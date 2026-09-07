use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{ConnectInfo, DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use chrono::{Duration, FixedOffset, NaiveDate, Utc};
use rusqlite::{Connection, OptionalExtension, params};
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tower_http::{compression::CompressionLayer, cors::CorsLayer};

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    pub db_path: Arc<PathBuf>,
    pub secret: Arc<Vec<u8>>,
    pub app_version: Arc<String>,
    pub backend_kind: Arc<String>,
}

fn read_db(state: &AppState) -> Result<Connection, ApiError> {
    let conn = Connection::open(state.db_path.as_ref())?;
    conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA query_only=ON")?;
    Ok(conn)
}

fn store_today() -> NaiveDate {
    let store_tz = FixedOffset::east_opt(8 * 60 * 60).expect("valid store timezone");
    Utc::now().with_timezone(&store_tz).date_naive()
}

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    detail: Value,
    retry_after: Option<i64>,
}
impl ApiError {
    fn new(status: StatusCode, detail: impl Into<Value>) -> Self {
        Self {
            status,
            detail: detail.into(),
            retry_after: None,
        }
    }
    fn bad(detail: &str) -> Self {
        Self::new(StatusCode::BAD_REQUEST, detail)
    }
    fn conflict(detail: impl Into<Value>) -> Self {
        Self::new(StatusCode::CONFLICT, detail)
    }
    fn not_found(detail: &str) -> Self {
        Self::new(StatusCode::NOT_FOUND, detail)
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = (self.status, Json(json!({"detail": self.detail}))).into_response();
        if let Some(seconds) = self.retry_after {
            response.headers_mut().insert(
                header::RETRY_AFTER,
                HeaderValue::from_str(&seconds.max(1).to_string()).unwrap(),
            );
        }
        response
    }
}
impl From<rusqlite::Error> for ApiError {
    fn from(err: rusqlite::Error) -> Self {
        eprintln!("database error: {err}");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "数据库错误")
    }
}

#[derive(RustEmbed)]
#[folder = "../web/"]
struct WebAssets;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/auth/login-options", get(login_options))
        .route("/api/auth/login", post(login))
        .route("/api/auth/me", get(me))
        .route("/api/auth/change-pin", post(change_pin))
        .route("/api/users", get(list_users).post(create_user))
        .route("/api/users/{id}", axum::routing::patch(update_user))
        .route("/api/items", get(list_items).post(create_item))
        .route("/api/items/{id}", axum::routing::patch(update_item))
        .route("/api/items/{id}/batches", get(item_batches))
        .route("/api/items/{id}/movements", get(item_movements))
        .route("/api/stock", get(stock))
        .route("/api/stock/receive", post(receive_stock))
        .route("/api/expiry", get(expiry))
        .route("/api/dashboard", get(dashboard))
        .route("/api/purchases", get(list_purchases).post(create_purchase))
        .route("/api/purchases/{id}/receive", post(receive_purchase))
        .route("/api/purchases/{id}/cancel", post(cancel_purchase))
        .route("/api/waste", get(list_waste).post(create_waste))
        .route("/api/waste/{id}/photo", get(waste_photo))
        .route("/api/waste/{id}/confirm", post(confirm_waste))
        .route("/api/waste/{id}/reject", post(reject_waste))
        .route("/api/counts", get(list_counts).post(create_count))
        .route("/api/counts/{id}", get(count_detail).patch(edit_count))
        .route("/api/counts/{id}/verify", post(verify_count))
        .route("/api/counts/{id}/reject", post(reject_count))
        .route("/api/count-comparisons/preview", post(preview_count_pair))
        .route("/api/count-comparisons", post(confirm_count_pair))
        .route("/api/count-comparisons/{id}", get(count_comparison_detail))
        .fallback(static_asset)
        .layer(middleware::from_fn(etag_middleware))
        .layer(DefaultBodyLimit::max(2_500_000))
        .layer(CompressionLayer::new())
        .layer(CorsLayer::permissive())
        .with_state(state)
}

async fn etag_middleware(request: Request<Body>, next: Next) -> Response {
    let eligible = request.method() == Method::GET && request.uri().path().starts_with("/api/");
    let candidate = request
        .headers()
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let response = next.run(request).await;
    if !eligible || response.status() != StatusCode::OK {
        return response;
    }

    let (mut parts, body) = response.into_parts();
    let Ok(bytes) = to_bytes(body, 8 * 1024 * 1024).await else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let etag = format!("\"{:x}\"", Sha256::digest(&bytes));
    parts.headers.insert(
        header::ETAG,
        HeaderValue::from_str(&etag).expect("sha256 etag is a valid header"),
    );
    parts
        .headers
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    parts.headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("ETag"),
    );
    if candidate.as_deref() == Some(etag.as_str()) {
        parts.status = StatusCode::NOT_MODIFIED;
        parts.headers.remove(header::CONTENT_LENGTH);
        parts.headers.remove(header::CONTENT_ENCODING);
        return Response::from_parts(parts, Body::empty());
    }
    Response::from_parts(parts, Body::from(bytes))
}

async fn health(State(s): State<AppState>) -> Result<Json<Value>, ApiError> {
    let db = read_db(&s)?;
    let (store_id, schema): (String, String) = db.query_row(
        "SELECT store_id,schema_version FROM store_meta WHERE id=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(Json(
        json!({"status":"ok","api_version":"1","db_schema":schema,"store_id":store_id,"backend_kind":s.backend_kind.as_str(),"app_version":s.app_version.as_str()}),
    ))
}

async fn static_asset(uri: axum::http::Uri) -> Response {
    if uri.path().starts_with("/api/") {
        return (StatusCode::NOT_FOUND, Json(json!({"detail":"Not Found"}))).into_response();
    }
    let path = uri.path().trim_start_matches('/');
    let key = if path.is_empty() { "index.html" } else { path };
    let Some(asset) = WebAssets::get(key).or_else(|| WebAssets::get("index.html")) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mime = mime_guess::from_path(key).first_or_octet_stream();
    Response::builder()
        .header(header::CONTENT_TYPE, mime.as_ref())
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from(asset.data.into_owned()))
        .unwrap()
}

fn now() -> String {
    Utc::now()
        .naive_utc()
        .format("%Y-%m-%d %H:%M:%S%.6f")
        .to_string()
}
fn out_dt(s: String) -> String {
    s.replace(' ', "T")
}
fn valid_pin(pin: &str) -> bool {
    (4..=6).contains(&pin.len()) && pin.bytes().all(|b| b.is_ascii_digit())
}
fn role_level(role: &str) -> i32 {
    match role {
        "staff" => 0,
        "manager" => 1,
        "admin" => 2,
        _ => -1,
    }
}

#[derive(Clone)]
struct User {
    id: i64,
    username: String,
    display_name: String,
    role: String,
    active: bool,
    must_change_pin: bool,
    token_version: i64,
    created_at: String,
}
fn user_by_id(db: &Connection, id: i64) -> rusqlite::Result<Option<User>> {
    db.query_row("SELECT id,username,display_name,role,active,must_change_pin,token_version,created_at FROM users WHERE id=?1",[id],|r| Ok(User{id:r.get(0)?,username:r.get(1)?,display_name:r.get(2)?,role:r.get(3)?,active:r.get(4)?,must_change_pin:r.get(5)?,token_version:r.get(6)?,created_at:r.get(7)?})).optional()
}
fn user_json(u: &User) -> Value {
    json!({"id":u.id,"username":u.username,"display_name":u.display_name,"role":u.role,"active":u.active,"must_change_pin":u.must_change_pin,"created_at":out_dt(u.created_at.clone())})
}
fn current_user(
    db: &Connection,
    secret: &[u8],
    headers: &HeaderMap,
    min_role: Option<&str>,
    allow_pin_change: bool,
) -> Result<User, ApiError> {
    let raw = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "未登录"))?;
    let (uid, ver) = crate::auth::decode_token(secret, raw)
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "token 无效或已过期"))?;
    let u = user_by_id(db, uid)?
        .filter(|u| u.active && u.token_version == ver)
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "用户不存在、已停用或会话已撤销"))?;
    if u.must_change_pin && !allow_pin_change {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            json!({"code":"pin_change_required","message":"首次使用前请修改 PIN"}),
        ));
    }
    if let Some(role) = min_role {
        if role_level(&u.role) < role_level(role) {
            return Err(ApiError::new(StatusCode::FORBIDDEN, "权限不足"));
        }
    }
    Ok(u)
}

#[derive(Deserialize)]
struct LoginIn {
    username: String,
    pin: String,
}
async fn login(
    State(s): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(p): Json<LoginIn>,
) -> Result<Json<Value>, ApiError> {
    let username = p.username.trim().to_lowercase();
    if username.is_empty() || !valid_pin(&p.pin) {
        return Err(ApiError::bad("用户名或 PIN 格式错误"));
    }
    let ip = addr.ip().to_string();
    let db = s.db.lock().unwrap();
    let t = now();
    let attempt:Option<(i64,String,Option<String>)>=db.query_row("SELECT failed_count,window_started_at,locked_until FROM login_attempts WHERE username=?1 AND source_ip=?2",params![username,ip],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    if let Some((_, _, Some(lock))) = &attempt {
        if lock > &t {
            let secs = (chrono::NaiveDateTime::parse_from_str(lock, "%Y-%m-%d %H:%M:%S%.f")
                .ok()
                .map(|d| (d - Utc::now().naive_utc()).num_seconds())
                .unwrap_or(1))
            .max(1);
            return Err(ApiError {
                status: StatusCode::TOO_MANY_REQUESTS,
                detail: "登录尝试过多，请稍后再试".into(),
                retry_after: Some(secs),
            });
        }
    }
    let found:Option<(i64,String,i64,bool,bool,String,String)>=db.query_row("SELECT id,pin_hash,token_version,active,must_change_pin,display_name,role FROM users WHERE username=?1",[&username],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional()?;
    if found
        .as_ref()
        .is_none_or(|(_, h, _, active, _, _, _)| !*active || !crate::auth::verify_pin(&p.pin, h))
    {
        let now_dt = Utc::now().naive_utc();
        let window_start = attempt
            .as_ref()
            .and_then(|x| chrono::NaiveDateTime::parse_from_str(&x.1, "%Y-%m-%d %H:%M:%S%.f").ok());
        let count = if window_start.is_some_and(|w| now_dt - w <= Duration::minutes(10)) {
            attempt.as_ref().map(|x| x.0 + 1).unwrap_or(1)
        } else {
            1
        };
        let lock: Option<String> = (count >= 5).then(|| {
            (now_dt + Duration::minutes(15))
                .format("%Y-%m-%d %H:%M:%S%.6f")
                .to_string()
        });
        db.execute("INSERT INTO login_attempts(username,source_ip,failed_count,window_started_at,locked_until) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(username,source_ip) DO UPDATE SET failed_count=excluded.failed_count,window_started_at=CASE WHEN excluded.failed_count=1 THEN excluded.window_started_at ELSE login_attempts.window_started_at END,locked_until=excluded.locked_until",params![username,ip,count,t,lock])?;
        if count >= 5 {
            return Err(ApiError {
                status: StatusCode::TOO_MANY_REQUESTS,
                detail: "登录尝试过多，请稍后再试".into(),
                retry_after: Some(900),
            });
        }
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, "用户名或 PIN 错误"));
    }
    let (id, _, ver, _, _, _, _) = found.unwrap();
    db.execute(
        "DELETE FROM login_attempts WHERE username=?1 AND source_ip=?2",
        params![username, ip],
    )?;
    let u = user_by_id(&db, id)?.unwrap();
    Ok(Json(
        json!({"token":crate::auth::create_token(&s.secret,id,ver),"user":user_json(&u)}),
    ))
}

async fn login_options(State(s): State<AppState>) -> Result<Json<Value>, ApiError> {
    let db = read_db(&s)?;
    let mut q = db.prepare("SELECT id FROM users WHERE active=1 ORDER BY id")?;
    let ids = q
        .query_map([], |r| r.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(json!({
        "users": ids.into_iter()
            .filter_map(|id| user_by_id(&db, id).ok().flatten())
            .map(|u| user_json(&u))
            .collect::<Vec<_>>()
    })))
}
async fn me(State(s): State<AppState>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    let db = read_db(&s)?;
    let u = current_user(&db, &s.secret, &headers, None, true)?;
    Ok(Json(user_json(&u)))
}

#[derive(Deserialize)]
struct ChangePin {
    current_pin: String,
    new_pin: String,
}
async fn change_pin(
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(p): Json<ChangePin>,
) -> Result<Json<Value>, ApiError> {
    if !valid_pin(&p.new_pin) {
        return Err(ApiError::bad("PIN 必须为 4-6 位数字"));
    }
    let db = s.db.lock().unwrap();
    let u = current_user(&db, &s.secret, &headers, None, true)?;
    let hash: String = db.query_row("SELECT pin_hash FROM users WHERE id=?1", [u.id], |r| {
        r.get(0)
    })?;
    if !crate::auth::verify_pin(&p.current_pin, &hash) {
        return Err(ApiError::bad("当前 PIN 错误"));
    }
    if p.current_pin == p.new_pin {
        return Err(ApiError::bad("新 PIN 不能与当前 PIN 相同"));
    }
    db.execute(
        "UPDATE users SET pin_hash=?1,must_change_pin=0,token_version=token_version+1 WHERE id=?2",
        params![crate::auth::hash_pin(&p.new_pin), u.id],
    )?;
    let changed = user_by_id(&db, u.id)?.unwrap();
    Ok(Json(
        json!({"token":crate::auth::create_token(&s.secret,changed.id,changed.token_version),"user":user_json(&changed)}),
    ))
}

async fn list_users(
    State(s): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let db = read_db(&s)?;
    current_user(&db, &s.secret, &headers, Some("admin"), false)?;
    let mut st = db.prepare("SELECT id FROM users ORDER BY id")?;
    let ids = st
        .query_map([], |r| r.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(Value::Array(
        ids.into_iter()
            .map(|id| user_json(&user_by_id(&db, id).unwrap().unwrap()))
            .collect(),
    )))
}
#[derive(Deserialize)]
struct UserCreate {
    username: String,
    display_name: String,
    pin: String,
    role: Option<String>,
}
async fn create_user(
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(p): Json<UserCreate>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let db = s.db.lock().unwrap();
    current_user(&db, &s.secret, &headers, Some("admin"), false)?;
    let name = p.username.trim().to_lowercase();
    if name.is_empty() || p.display_name.trim().is_empty() || !valid_pin(&p.pin) {
        return Err(ApiError::bad("用户资料格式错误"));
    }
    let role = p.role.unwrap_or_else(|| "staff".into());
    if role_level(&role) < 0 {
        return Err(ApiError::bad("角色无效"));
    }
    if db
        .query_row("SELECT 1 FROM users WHERE username=?1", [&name], |r| {
            r.get::<_, i64>(0)
        })
        .optional()?
        .is_some()
    {
        return Err(ApiError::conflict("用户名已存在"));
    }
    db.execute("INSERT INTO users(username,display_name,pin_hash,role,active,must_change_pin,token_version,created_at) VALUES(?1,?2,?3,?4,1,1,0,?5)",params![name,p.display_name,crate::auth::hash_pin(&p.pin),role,now()])?;
    let u = user_by_id(&db, db.last_insert_rowid())?.unwrap();
    Ok((StatusCode::CREATED, Json(user_json(&u))))
}
#[derive(Deserialize)]
struct UserUpdate {
    username: Option<String>,
    display_name: Option<String>,
    role: Option<String>,
    active: Option<bool>,
    pin: Option<String>,
}
async fn update_user(
    State(s): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Json(p): Json<UserUpdate>,
) -> Result<Json<Value>, ApiError> {
    let db = s.db.lock().unwrap();
    let admin = current_user(&db, &s.secret, &headers, Some("admin"), false)?;
    let old = user_by_id(&db, id)?.ok_or_else(|| ApiError::not_found("用户不存在"))?;
    if id == admin.id && (p.active == Some(false) || p.role.is_some()) {
        return Err(ApiError::bad("不能停用自己或修改自己的角色"));
    }
    if p.pin.as_ref().is_some_and(|v| !valid_pin(v)) {
        return Err(ApiError::bad("PIN 必须为 4-6 位数字"));
    }
    if p.role.as_ref().is_some_and(|v| role_level(v) < 0) {
        return Err(ApiError::bad("角色无效"));
    }
    let username = p.username.map(|value| value.trim().to_lowercase());
    if username
        .as_ref()
        .is_some_and(|value| value.is_empty() || value.chars().count() > 64)
    {
        return Err(ApiError::bad("用户名格式错误"));
    }
    if let Some(ref value) = username {
        if db
            .query_row(
                "SELECT 1 FROM users WHERE username=?1 AND id<>?2",
                params![value, id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some()
        {
            return Err(ApiError::conflict("用户名已存在"));
        }
    }
    let username_changed = username
        .as_ref()
        .is_some_and(|value| value != &old.username);
    let revoke = p.pin.is_some()
        || username_changed
        || p.role.as_ref().is_some_and(|v| v != &old.role)
        || p.active.is_some_and(|v| v != old.active);
    db.execute("UPDATE users SET username=coalesce(?1,username),display_name=coalesce(?2,display_name),role=coalesce(?3,role),active=coalesce(?4,active),pin_hash=coalesce(?5,pin_hash),must_change_pin=CASE WHEN ?5 IS NULL THEN must_change_pin ELSE 1 END,token_version=token_version+?6 WHERE id=?7",params![username,p.display_name,p.role,p.active,p.pin.map(|v|crate::auth::hash_pin(&v)),i64::from(revoke),id])?;
    if username_changed {
        db.execute(
            "DELETE FROM login_attempts WHERE username=?1 OR username=(SELECT username FROM users WHERE id=?2)",
            params![old.username, id],
        )?;
    }
    Ok(Json(user_json(&user_by_id(&db, id)?.unwrap())))
}

fn item_exists(db: &Connection, id: i64) -> rusqlite::Result<bool> {
    Ok(db
        .query_row("SELECT 1 FROM items WHERE id=?1", [id], |r| {
            r.get::<_, i64>(0)
        })
        .optional()?
        .is_some())
}
fn item_stock(db: &Connection, id: i64) -> rusqlite::Result<i64> {
    db.query_row(
        "SELECT coalesce(sum(qty),0) FROM batches WHERE item_id=?1",
        [id],
        |r| r.get(0),
    )
}
fn item_last_count(
    db: &Connection,
    id: i64,
) -> rusqlite::Result<(Option<String>, Option<i64>, Option<String>, Option<bool>)> {
    let last = db
        .query_row(
            "SELECT c.created_at,CASE WHEN c.count_type='daily' THEN e.reported_qty ELSE coalesce(e.reviewed_qty,e.qty_counted) END,c.count_type,e.is_enough FROM count_entries e JOIN count_sessions c ON c.id=e.session_id WHERE e.item_id=?1 AND ((c.count_type='daily' AND c.status='completed') OR (c.count_type='weekly' AND c.status='verified')) ORDER BY datetime(c.created_at) DESC,c.id DESC,e.id DESC LIMIT 1",
            [id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<bool>>(3)?)),
        )
        .optional()?;
    Ok(match last {
        Some((at, qty, kind, enough)) => {
            let mut at = out_dt(at);
            if !at.ends_with('Z') && !at.contains('+') {
                at.push('Z');
            }
            (Some(at), qty, Some(kind), enough)
        }
        None => (None, None, None, None),
    })
}
fn item_json(db: &Connection, id: i64) -> rusqlite::Result<Value> {
    db.query_row("SELECT id,name,category,unit,shelf_life_days,min_stock,daily_count_enabled,weekly_count_enabled,active,sort_order FROM items WHERE id=?1",[id],|r|{let last=item_last_count(db,id)?;Ok(json!({"id":r.get::<_,i64>(0)?,"name":r.get::<_,String>(1)?,"category":r.get::<_,String>(2)?,"unit":r.get::<_,String>(3)?,"shelf_life_days":r.get::<_,i64>(4)?,"min_stock":r.get::<_,i64>(5)?,"daily_count_enabled":r.get::<_,bool>(6)?,"weekly_count_enabled":r.get::<_,bool>(7)?,"active":r.get::<_,bool>(8)?,"sort_order":r.get::<_,i64>(9)?,"stock":item_stock(db,id)?,"last_count_at":last.0,"last_count_qty":last.1,"last_count_type":last.2,"last_count_enough":last.3}))})
}

#[derive(Deserialize, Default)]
struct ItemQuery {
    include_inactive: Option<bool>,
}
async fn list_items(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ItemQuery>,
) -> Result<Json<Value>, ApiError> {
    let db = read_db(&s)?;
    current_user(&db, &s.secret, &headers, Some("staff"), false)?;
    let sql = if q.include_inactive.unwrap_or(false) {
        "SELECT id FROM items ORDER BY sort_order,id"
    } else {
        "SELECT id FROM items WHERE active=1 ORDER BY sort_order,id"
    };
    let mut st = db.prepare(sql)?;
    let ids = st
        .query_map([], |r| r.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(Value::Array(
        ids.into_iter()
            .map(|id| item_json(&db, id).unwrap())
            .collect(),
    )))
}
#[derive(Deserialize)]
struct ItemCreate {
    name: String,
    category: Option<String>,
    unit: Option<String>,
    shelf_life_days: Option<i64>,
    min_stock: Option<i64>,
    daily_count_enabled: Option<bool>,
    weekly_count_enabled: Option<bool>,
    sort_order: Option<i64>,
}
async fn create_item(
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(p): Json<ItemCreate>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let db = s.db.lock().unwrap();
    current_user(&db, &s.secret, &headers, Some("manager"), false)?;
    if p.name.trim().is_empty()
        || p.shelf_life_days.unwrap_or(7) < 1
        || p.min_stock.unwrap_or(0) < 0
    {
        return Err(ApiError::bad("库存品资料格式错误"));
    }
    if db
        .query_row("SELECT 1 FROM items WHERE name=?1", [&p.name], |r| {
            r.get::<_, i64>(0)
        })
        .optional()?
        .is_some()
    {
        return Err(ApiError::conflict("库存品名称已存在"));
    }
    db.execute("INSERT INTO items(name,category,unit,shelf_life_days,min_stock,daily_count_enabled,weekly_count_enabled,active,sort_order,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,1,?8,?9)",params![p.name,p.category.unwrap_or_default(),p.unit.unwrap_or_else(||"个".into()),p.shelf_life_days.unwrap_or(7),p.min_stock.unwrap_or(0),p.daily_count_enabled.unwrap_or(true),p.weekly_count_enabled.unwrap_or(true),p.sort_order.unwrap_or(0),now()])?;
    let id = db.last_insert_rowid();
    Ok((StatusCode::CREATED, Json(item_json(&db, id)?)))
}
#[derive(Deserialize)]
struct ItemUpdate {
    name: Option<String>,
    category: Option<String>,
    unit: Option<String>,
    shelf_life_days: Option<i64>,
    min_stock: Option<i64>,
    daily_count_enabled: Option<bool>,
    weekly_count_enabled: Option<bool>,
    active: Option<bool>,
    sort_order: Option<i64>,
}
async fn update_item(
    State(s): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Json(p): Json<ItemUpdate>,
) -> Result<Json<Value>, ApiError> {
    let db = s.db.lock().unwrap();
    current_user(&db, &s.secret, &headers, Some("manager"), false)?;
    if !item_exists(&db, id)? {
        return Err(ApiError::not_found("库存品不存在"));
    }
    if p.name.as_ref().is_some_and(|v| v.trim().is_empty())
        || p.shelf_life_days.is_some_and(|v| v < 1)
        || p.min_stock.is_some_and(|v| v < 0)
    {
        return Err(ApiError::bad("库存品资料格式错误"));
    }
    if let Some(name) = &p.name {
        if db
            .query_row(
                "SELECT id FROM items WHERE name=?1 AND id<>?2",
                params![name, id],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .is_some()
        {
            return Err(ApiError::conflict("库存品名称已存在"));
        }
    }
    db.execute("UPDATE items SET name=coalesce(?1,name),category=coalesce(?2,category),unit=coalesce(?3,unit),shelf_life_days=coalesce(?4,shelf_life_days),min_stock=coalesce(?5,min_stock),daily_count_enabled=coalesce(?6,daily_count_enabled),weekly_count_enabled=coalesce(?7,weekly_count_enabled),active=coalesce(?8,active),sort_order=coalesce(?9,sort_order) WHERE id=?10",params![p.name,p.category,p.unit,p.shelf_life_days,p.min_stock,p.daily_count_enabled,p.weekly_count_enabled,p.active,p.sort_order,id])?;
    Ok(Json(item_json(&db, id)?))
}

async fn item_batches(
    State(s): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let db = read_db(&s)?;
    current_user(&db, &s.secret, &headers, Some("staff"), false)?;
    if !item_exists(&db, id)? {
        return Err(ApiError::not_found("库存品不存在"));
    }
    let today = store_today();
    let mut st=db.prepare("SELECT id,item_id,qty,initial_qty,expiry_date,received_at,source,note FROM batches WHERE item_id=?1 ORDER BY expiry_date,id")?;
    let rows=st.query_map([id],|r|{let expiry:String=r.get(4)?;let days=NaiveDate::parse_from_str(&expiry,"%Y-%m-%d").map(|d|(d-today).num_days()).unwrap_or(0);Ok(json!({"id":r.get::<_,i64>(0)?,"item_id":r.get::<_,i64>(1)?,"qty":r.get::<_,i64>(2)?,"initial_qty":r.get::<_,i64>(3)?,"expiry_date":expiry,"received_at":out_dt(r.get(5)?),"source":r.get::<_,String>(6)?,"note":r.get::<_,Option<String>>(7)?,"days_to_expiry":days}))})?.collect::<Result<Vec<_>,_>>()?;
    Ok(Json(Value::Array(rows)))
}
async fn item_movements(
    State(s): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let db = read_db(&s)?;
    current_user(&db, &s.secret, &headers, Some("manager"), false)?;
    if !item_exists(&db, id)? {
        return Err(ApiError::not_found("库存品不存在"));
    }
    let mut st=db.prepare("SELECT m.id,m.item_id,m.batch_id,m.delta,m.operation,m.reference_type,m.reference_id,m.actor_id,u.display_name,m.created_at FROM stock_movements m LEFT JOIN users u ON u.id=m.actor_id WHERE m.item_id=?1 ORDER BY m.id DESC")?;
    let rows=st.query_map([id],|r|Ok(json!({"id":r.get::<_,i64>(0)?,"item_id":r.get::<_,i64>(1)?,"batch_id":r.get::<_,i64>(2)?,"delta":r.get::<_,i64>(3)?,"operation":r.get::<_,String>(4)?,"reference_type":r.get::<_,String>(5)?,"reference_id":r.get::<_,Option<i64>>(6)?,"actor_id":r.get::<_,i64>(7)?,"actor_name":r.get::<_,Option<String>>(8)?.unwrap_or_else(||"?".into()),"created_at":out_dt(r.get(9)?)})))?.collect::<Result<Vec<_>,_>>()?;
    Ok(Json(Value::Array(rows)))
}

async fn stock(State(s): State<AppState>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    let db = read_db(&s)?;
    current_user(&db, &s.secret, &headers, Some("staff"), false)?;
    let mut st=db.prepare("SELECT id,name,category,unit,shelf_life_days,min_stock,daily_count_enabled,weekly_count_enabled,active FROM items WHERE active=1 ORDER BY sort_order,id")?;
    let rows=st.query_map([],|r|{let id:i64=r.get(0)?;let (qty,nearest,count):(i64,Option<String>,i64)=db.query_row("SELECT coalesce(sum(qty),0),min(CASE WHEN qty>0 THEN expiry_date END),coalesce(sum(CASE WHEN qty>0 THEN 1 ELSE 0 END),0) FROM batches WHERE item_id=?1",[id],|x|Ok((x.get(0)?,x.get(1)?,x.get(2)?)))?;Ok(json!({"item":{"id":id,"name":r.get::<_,String>(1)?,"category":r.get::<_,String>(2)?,"unit":r.get::<_,String>(3)?,"shelf_life_days":r.get::<_,i64>(4)?,"min_stock":r.get::<_,i64>(5)?,"daily_count_enabled":r.get::<_,bool>(6)?,"weekly_count_enabled":r.get::<_,bool>(7)?,"active":r.get::<_,bool>(8)?},"stock":qty,"nearest_expiry":nearest,"batch_count":count}))})?.collect::<Result<Vec<_>,_>>()?;
    Ok(Json(Value::Array(rows)))
}
#[derive(Deserialize)]
struct StockReceiveLine {
    item_id: i64,
    qty: i64,
    expiry_date: String,
}
#[derive(Deserialize)]
struct StockReceiveIn {
    items: Vec<StockReceiveLine>,
    note: Option<String>,
}
async fn receive_stock(
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(p): Json<StockReceiveIn>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let mut db = s.db.lock().unwrap();
    let u = current_user(&db, &s.secret, &headers, Some("manager"), false)?;
    if p.items.is_empty() {
        return Err(ApiError::bad("入库条目不能为空"));
    }
    if p.note
        .as_ref()
        .is_some_and(|note| note.chars().count() > 255)
    {
        return Err(ApiError::bad("入库备注不能超过 255 个字符"));
    }
    let mut seen = HashSet::new();
    for line in &p.items {
        if line.qty < 1 {
            return Err(ApiError::bad("入库数量必须大于 0"));
        }
        if !seen.insert(line.item_id) {
            return Err(ApiError::bad("入库条目重复"));
        }
        if !item_exists(&db, line.item_id)? {
            return Err(ApiError::bad(&format!("库存品不存在：{}", line.item_id)));
        }
        if NaiveDate::parse_from_str(&line.expiry_date, "%Y-%m-%d").is_err() {
            return Err(ApiError::bad("效期必须为有效日期 YYYY-MM-DD"));
        }
    }

    let received_at = now();
    let note = p.note;
    let tx = db.transaction()?;
    let mut batch_ids = Vec::with_capacity(p.items.len());
    for line in p.items {
        tx.execute(
            "INSERT INTO batches(item_id,qty,initial_qty,expiry_date,received_at,source,note) VALUES(?1,?2,?2,?3,?4,'receive',?5)",
            params![line.item_id, line.qty, line.expiry_date, received_at, note],
        )?;
        let batch_id = tx.last_insert_rowid();
        movement(
            &tx,
            line.item_id,
            batch_id,
            line.qty,
            "stock_receive",
            "manual",
            None,
            u.id,
        )?;
        batch_ids.push(batch_id);
    }
    tx.commit()?;

    let today = store_today();
    let mut batches = Vec::with_capacity(batch_ids.len());
    for id in batch_ids {
        let row = db.query_row(
            "SELECT id,item_id,qty,initial_qty,expiry_date,received_at,source,note FROM batches WHERE id=?1",
            [id],
            |r| {
                let expiry: String = r.get(4)?;
                let days = NaiveDate::parse_from_str(&expiry, "%Y-%m-%d")
                    .map(|date| (date - today).num_days())
                    .unwrap_or(0);
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "item_id": r.get::<_, i64>(1)?,
                    "qty": r.get::<_, i64>(2)?,
                    "initial_qty": r.get::<_, i64>(3)?,
                    "expiry_date": expiry,
                    "received_at": out_dt(r.get(5)?),
                    "source": r.get::<_, String>(6)?,
                    "note": r.get::<_, Option<String>>(7)?,
                    "days_to_expiry": days,
                }))
            },
        )?;
        batches.push(row);
    }
    Ok((StatusCode::CREATED, Json(Value::Array(batches))))
}
#[derive(Deserialize, Default)]
struct ExpiryQuery {
    days: Option<i64>,
}
async fn expiry(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ExpiryQuery>,
) -> Result<Json<Value>, ApiError> {
    let db = read_db(&s)?;
    current_user(&db, &s.secret, &headers, Some("staff"), false)?;
    let days = q.days.unwrap_or(3);
    if days < 0 {
        return Err(ApiError::bad("days 不能为负数"));
    }
    let today = store_today();
    let cutoff = (today + Duration::days(days))
        .format("%Y-%m-%d")
        .to_string();
    let mut st=db.prepare("SELECT b.id,b.item_id,i.name,i.unit,b.qty,b.expiry_date FROM batches b JOIN items i ON i.id=b.item_id WHERE b.qty>0 AND b.expiry_date<=?1 ORDER BY b.expiry_date,b.id")?;
    let rows=st.query_map([cutoff],|r|{let e:String=r.get(5)?;let d=NaiveDate::parse_from_str(&e,"%Y-%m-%d").map(|x|(x-today).num_days()).unwrap_or(0);Ok(json!({"batch_id":r.get::<_,i64>(0)?,"item_id":r.get::<_,i64>(1)?,"item_name":r.get::<_,String>(2)?,"unit":r.get::<_,String>(3)?,"qty":r.get::<_,i64>(4)?,"expiry_date":e,"days_to_expiry":d}))})?.collect::<Result<Vec<_>,_>>()?;
    Ok(Json(Value::Array(rows)))
}
async fn dashboard(State(s): State<AppState>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    let db = read_db(&s)?;
    let u = current_user(&db, &s.secret, &headers, Some("staff"), false)?;
    let low:i64=db.query_row("SELECT count(*) FROM items i WHERE active=1 AND coalesce((SELECT sum(qty) FROM batches b WHERE b.item_id=i.id),0)<i.min_stock",[],|r|r.get(0))?;
    let cutoff = (store_today() + Duration::days(3))
        .format("%Y-%m-%d")
        .to_string();
    let exp: i64 = db.query_row(
        "SELECT count(*) FROM batches WHERE qty>0 AND expiry_date<=?1",
        [cutoff],
        |r| r.get(0),
    )?;
    let count = |table: &str, status: &str| -> rusqlite::Result<i64> {
        db.query_row(
            &format!("SELECT count(*) FROM {table} WHERE status=?1"),
            [status],
            |r| r.get(0),
        )
    };
    let daily_shortages: i64 = db.query_row(
        "SELECT count(*) FROM count_entries e JOIN count_sessions c ON c.id=e.session_id WHERE c.count_type='daily' AND c.business_date=?1 AND c.status='completed' AND e.is_enough=0",
        [store_today().format("%Y-%m-%d").to_string()],
        |r| r.get(0),
    )?;
    let recent_counts_3d: i64 = db.query_row(
        "SELECT count(*) FROM count_sessions WHERE count_type='weekly' AND datetime(created_at)>=datetime('now','-3 days') AND (?1=0 OR created_by=?2)",
        params![i64::from(u.role == "staff"), u.id],
        |r| r.get(0),
    )?;
    let pending_counts: i64 = db.query_row(
        "SELECT count(*) FROM count_sessions WHERE count_type='weekly' AND status='submitted' AND datetime(created_at)>=datetime('now','-72 hours')",
        [], |r| r.get(0),
    )?;
    Ok(Json(
        json!({"low_stock":low,"expiring_soon":exp,"pending_waste":count("waste_records","pending")?,"pending_counts":pending_counts,"active_purchases":count("purchases","ordered")?,"daily_shortages":daily_shortages,"recent_counts_3d":recent_counts_3d}),
    ))
}

fn purchase_json(db: &Connection, id: i64) -> rusqlite::Result<Value> {
    let (status,note,created_by,creator,created_at,received_at):(String,Option<String>,i64,String,String,Option<String>)=db.query_row("SELECT p.status,p.note,p.created_by,coalesce(u.display_name,''),p.created_at,p.received_at FROM purchases p LEFT JOIN users u ON u.id=p.created_by WHERE p.id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?)))?;
    let mut st=db.prepare("SELECT pi.id,pi.item_id,coalesce(i.name,'?'),coalesce(i.unit,''),pi.qty FROM purchase_items pi LEFT JOIN items i ON i.id=pi.item_id WHERE pi.purchase_id=?1 ORDER BY pi.id")?;
    let items=st.query_map([id],|r|Ok(json!({"id":r.get::<_,i64>(0)?,"item_id":r.get::<_,i64>(1)?,"item_name":r.get::<_,String>(2)?,"unit":r.get::<_,String>(3)?,"qty":r.get::<_,i64>(4)?})))?.collect::<Result<Vec<_>,_>>()?;
    Ok(
        json!({"id":id,"status":status,"note":note,"created_by":created_by,"created_by_name":creator,"created_at":out_dt(created_at),"received_at":received_at.map(out_dt),"items":items}),
    )
}
#[derive(Deserialize)]
struct PurchaseLineIn {
    item_id: i64,
    qty: i64,
}
#[derive(Deserialize)]
struct PurchaseCreateIn {
    items: Vec<PurchaseLineIn>,
    note: Option<String>,
}
async fn create_purchase(
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(p): Json<PurchaseCreateIn>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let mut db = s.db.lock().unwrap();
    let u = current_user(&db, &s.secret, &headers, Some("manager"), false)?;
    if p.items.is_empty() {
        return Err(ApiError::bad("采购条目不能为空"));
    }
    let mut seen = HashSet::new();
    for line in &p.items {
        if line.qty < 1 {
            return Err(ApiError::bad("采购数量必须大于 0"));
        }
        if !seen.insert(line.item_id) {
            return Err(ApiError::bad("采购条目重复"));
        }
        if !item_exists(&db, line.item_id)? {
            return Err(ApiError::bad(&format!("库存品不存在：{}", line.item_id)));
        }
    }
    let tx = db.transaction()?;
    tx.execute(
        "INSERT INTO purchases(status,created_by,created_at,note) VALUES('ordered',?1,?2,?3)",
        params![u.id, now(), p.note],
    )?;
    let id = tx.last_insert_rowid();
    for line in p.items {
        tx.execute(
            "INSERT INTO purchase_items(purchase_id,item_id,qty) VALUES(?1,?2,?3)",
            params![id, line.item_id, line.qty],
        )?;
    }
    tx.commit()?;
    Ok((StatusCode::CREATED, Json(purchase_json(&db, id)?)))
}
#[derive(Deserialize, Default)]
struct StatusQuery {
    status: Option<String>,
    count_type: Option<String>,
    days: Option<i64>,
}
async fn list_purchases(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<StatusQuery>,
) -> Result<Json<Value>, ApiError> {
    let db = read_db(&s)?;
    current_user(&db, &s.secret, &headers, Some("manager"), false)?;
    let mut st =
        db.prepare("SELECT id FROM purchases WHERE (?1 IS NULL OR status=?1) ORDER BY id DESC")?;
    let ids = st
        .query_map([q.status], |r| r.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(Value::Array(
        ids.into_iter()
            .map(|id| purchase_json(&db, id).unwrap())
            .collect(),
    )))
}
#[derive(Deserialize)]
struct ReceiveLine {
    purchase_item_id: i64,
    expiry_date: String,
}
#[derive(Deserialize)]
struct ReceiveIn {
    items: Vec<ReceiveLine>,
}
async fn receive_purchase(
    State(s): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Json(p): Json<ReceiveIn>,
) -> Result<Json<Value>, ApiError> {
    let mut db = s.db.lock().unwrap();
    let u = current_user(&db, &s.secret, &headers, Some("manager"), false)?;
    let status: Option<String> = db
        .query_row("SELECT status FROM purchases WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .optional()?;
    let Some(status) = status else {
        return Err(ApiError::not_found("采购单不存在"));
    };
    if status != "ordered" {
        return Err(ApiError::conflict("该采购单已处理"));
    }
    let mut st = db.prepare("SELECT id,item_id,qty FROM purchase_items WHERE purchase_id=?1")?;
    let own = st
        .query_map([id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(st);
    let provided: HashMap<i64, String> = p
        .items
        .into_iter()
        .map(|x| (x.purchase_item_id, x.expiry_date))
        .collect();
    if provided.len() != own.len() || own.iter().any(|x| !provided.contains_key(&x.0)) {
        return Err(ApiError::bad("入库行必须覆盖采购单全部条目"));
    }
    if provided
        .values()
        .any(|v| NaiveDate::parse_from_str(v, "%Y-%m-%d").is_err())
    {
        return Err(ApiError::bad("效期必须为有效日期 YYYY-MM-DD"));
    }
    let tx = db.transaction()?;
    if tx.execute("UPDATE purchases SET status='received',received_at=?1,handled_by=?2,handled_at=?1 WHERE id=?3 AND status='ordered'",params![now(),u.id,id])?!=1{return Err(ApiError::conflict("该采购单已处理"));}
    for (line, item, qty) in own {
        tx.execute("INSERT INTO batches(item_id,qty,initial_qty,expiry_date,received_at,source,note) VALUES(?1,?2,?2,?3,?4,'purchase',?5)",params![item,qty,provided[&line],now(),format!("采购单 #{id}")])?;
        let batch = tx.last_insert_rowid();
        movement(
            &tx,
            item,
            batch,
            qty,
            "purchase_receive",
            "purchase",
            Some(id),
            u.id,
        )?;
    }
    tx.commit()?;
    Ok(Json(purchase_json(&db, id)?))
}
async fn cancel_purchase(
    State(s): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let db = s.db.lock().unwrap();
    let u = current_user(&db, &s.secret, &headers, Some("manager"), false)?;
    if db
        .query_row("SELECT 1 FROM purchases WHERE id=?1", [id], |r| {
            r.get::<_, i64>(0)
        })
        .optional()?
        .is_none()
    {
        return Err(ApiError::not_found("采购单不存在"));
    }
    if db.execute("UPDATE purchases SET status='cancelled',handled_by=?1,handled_at=?2 WHERE id=?3 AND status='ordered'",params![u.id,now(),id])?!=1{return Err(ApiError::conflict("该采购单已处理"));}
    Ok(Json(purchase_json(&db, id)?))
}

fn movement(
    db: &Connection,
    item: i64,
    batch: i64,
    delta: i64,
    op: &str,
    reference: &str,
    ref_id: Option<i64>,
    actor: i64,
) -> rusqlite::Result<()> {
    db.execute("INSERT INTO stock_movements(item_id,batch_id,delta,operation,reference_type,reference_id,actor_id,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![item,batch,delta,op,reference,ref_id,actor,now()])?;
    Ok(())
}
fn deduct_fefo(
    db: &Connection,
    item: i64,
    qty: i64,
    batch_id: Option<i64>,
    actor: i64,
    op: &str,
    reference: &str,
    ref_id: Option<i64>,
) -> Result<(), ApiError> {
    if qty <= 0 {
        return Err(ApiError::bad("扣减数量必须大于 0"));
    }
    if let Some(batch) = batch_id {
        let found: Option<(i64, i64)> = db
            .query_row(
                "SELECT item_id,qty FROM batches WHERE id=?1",
                [batch],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((owner, stock)) = found else {
            return Err(ApiError::bad("指定批次不存在或不属于该库存品"));
        };
        if owner != item {
            return Err(ApiError::bad("指定批次不存在或不属于该库存品"));
        }
        if stock < qty {
            return Err(ApiError::bad("批次库存不足"));
        }
        if db.execute(
            "UPDATE batches SET qty=qty-?1 WHERE id=?2 AND qty>=?1",
            params![qty, batch],
        )? != 1
        {
            return Err(ApiError::conflict("库存已变化，请重试"));
        }
        movement(db, item, batch, -qty, op, reference, ref_id, actor)?;
        return Ok(());
    }
    let mut st = db
        .prepare("SELECT id,qty FROM batches WHERE item_id=?1 AND qty>0 ORDER BY expiry_date,id")?;
    let batches = st
        .query_map([item], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(st);
    if batches.iter().map(|x| x.1).sum::<i64>() < qty {
        return Err(ApiError::bad("库存不足，无法扣减"));
    }
    let mut remaining = qty;
    for (batch, stock) in batches {
        if remaining == 0 {
            break;
        }
        let take = stock.min(remaining);
        if db.execute(
            "UPDATE batches SET qty=qty-?1 WHERE id=?2 AND qty>=?1",
            params![take, batch],
        )? != 1
        {
            return Err(ApiError::conflict("库存已变化，请重试"));
        }
        movement(db, item, batch, -take, op, reference, ref_id, actor)?;
        remaining -= take;
    }
    Ok(())
}

fn waste_json(db: &Connection, id: i64) -> rusqlite::Result<Value> {
    db.query_row("SELECT w.id,w.item_id,coalesce(i.name,'?'),coalesce(i.unit,''),w.batch_id,b.expiry_date,w.qty,w.reason,w.description,w.photo_base64 IS NOT NULL,w.status,w.reported_by,coalesce(u.display_name,''),w.reported_at,w.confirmed_by,w.confirmed_at FROM waste_records w LEFT JOIN items i ON i.id=w.item_id LEFT JOIN batches b ON b.id=w.batch_id LEFT JOIN users u ON u.id=w.reported_by WHERE w.id=?1",[id],|r|Ok(json!({"id":r.get::<_,i64>(0)?,"item_id":r.get::<_,i64>(1)?,"item_name":r.get::<_,String>(2)?,"unit":r.get::<_,String>(3)?,"batch_id":r.get::<_,Option<i64>>(4)?,"batch_expiry_date":r.get::<_,Option<String>>(5)?,"qty":r.get::<_,i64>(6)?,"reason":r.get::<_,String>(7)?,"description":r.get::<_,Option<String>>(8)?,"has_photo":r.get::<_,bool>(9)?,"status":r.get::<_,String>(10)?,"reported_by":r.get::<_,i64>(11)?,"reported_by_name":r.get::<_,String>(12)?,"reported_at":out_dt(r.get(13)?),"confirmed_by":r.get::<_,Option<i64>>(14)?,"confirmed_at":r.get::<_,Option<String>>(15)?.map(out_dt)})))
}
#[derive(Deserialize)]
struct WasteCreateIn {
    item_id: i64,
    qty: i64,
    reason: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    photo_data: Option<String>,
    #[serde(default)]
    batch_id: Option<i64>,
}

fn parse_waste_photo(data: Option<String>) -> Result<(Option<String>, Option<String>), ApiError> {
    let Some(data) = data.filter(|value| !value.is_empty()) else {
        return Ok((None, None));
    };
    let (header, encoded) = data
        .split_once(',')
        .ok_or_else(|| ApiError::bad("报损图片格式无效"))?;
    let mime = header
        .strip_prefix("data:")
        .and_then(|value| value.strip_suffix(";base64"))
        .filter(|value| matches!(*value, "image/jpeg" | "image/png" | "image/webp"))
        .ok_or_else(|| ApiError::bad("报损图片格式无效"))?;
    let raw = BASE64
        .decode(encoded)
        .map_err(|_| ApiError::bad("报损图片格式无效"))?;
    if raw.len() > 1_500_000 {
        return Err(ApiError::bad("报损图片不能超过 1.5MB"));
    }
    Ok((Some(mime.to_string()), Some(encoded.to_string())))
}
async fn create_waste(
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(p): Json<WasteCreateIn>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let db = s.db.lock().unwrap();
    let u = current_user(&db, &s.secret, &headers, Some("staff"), false)?;
    if p.qty < 1 || p.reason.trim().is_empty() {
        return Err(ApiError::bad("报损资料格式错误"));
    }
    if p.description
        .as_ref()
        .is_some_and(|value| value.chars().count() > 500)
    {
        return Err(ApiError::bad("原因描述不能超过 500 字"));
    }
    if !item_exists(&db, p.item_id)? {
        return Err(ApiError::bad("库存品不存在"));
    }
    if let Some(b) = p.batch_id {
        let owner: Option<i64> = db
            .query_row("SELECT item_id FROM batches WHERE id=?1", [b], |r| r.get(0))
            .optional()?;
        if owner != Some(p.item_id) {
            return Err(ApiError::bad("指定批次不存在或不属于该库存品"));
        }
    }
    let (photo_mime, photo_base64) = parse_waste_photo(p.photo_data)?;
    let description = p
        .description
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    db.execute("INSERT INTO waste_records(item_id,batch_id,qty,reason,description,photo_mime,photo_base64,status,reported_by,reported_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'pending',?8,?9)",params![p.item_id,p.batch_id,p.qty,p.reason,description,photo_mime,photo_base64,u.id,now()])?;
    let id = db.last_insert_rowid();
    Ok((StatusCode::CREATED, Json(waste_json(&db, id)?)))
}
async fn waste_photo(
    State(s): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let db = read_db(&s)?;
    current_user(&db, &s.secret, &headers, Some("staff"), false)?;
    let photo: Option<(String, String)> = db.query_row(
        "SELECT photo_mime,photo_base64 FROM waste_records WHERE id=?1 AND photo_base64 IS NOT NULL",
        [id], |r| Ok((r.get(0)?, r.get(1)?)),
    ).optional()?;
    let Some((mime, encoded)) = photo else {
        return Err(ApiError::not_found("报损图片不存在"));
    };
    let bytes = BASE64
        .decode(encoded)
        .map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "报损图片损坏"))?;
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .body(Body::from(bytes))
        .unwrap())
}
async fn list_waste(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<StatusQuery>,
) -> Result<Json<Value>, ApiError> {
    let db = read_db(&s)?;
    current_user(&db, &s.secret, &headers, Some("staff"), false)?;
    let mut st = db
        .prepare("SELECT id FROM waste_records WHERE (?1 IS NULL OR status=?1) ORDER BY id DESC")?;
    let ids = st
        .query_map([q.status], |r| r.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(Value::Array(
        ids.into_iter()
            .map(|id| waste_json(&db, id).unwrap())
            .collect(),
    )))
}
async fn confirm_waste(
    State(s): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let mut db = s.db.lock().unwrap();
    let u = current_user(&db, &s.secret, &headers, Some("manager"), false)?;
    let row: Option<(String, i64, i64, Option<i64>)> = db
        .query_row(
            "SELECT status,item_id,qty,batch_id FROM waste_records WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((status, item, qty, batch)) = row else {
        return Err(ApiError::not_found("报损记录不存在"));
    };
    if status != "pending" {
        return Err(ApiError::conflict("该报损记录已处理"));
    }
    let tx = db.transaction()?;
    if tx.execute("UPDATE waste_records SET status='confirmed',confirmed_by=?1,confirmed_at=?2 WHERE id=?3 AND status='pending'",params![u.id,now(),id])?!=1{return Err(ApiError::conflict("该报损记录已处理"));}
    deduct_fefo(&tx, item, qty, batch, u.id, "waste", "waste", Some(id))?;
    tx.commit()?;
    Ok(Json(waste_json(&db, id)?))
}
async fn reject_waste(
    State(s): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let db = s.db.lock().unwrap();
    let u = current_user(&db, &s.secret, &headers, Some("manager"), false)?;
    if db
        .query_row("SELECT 1 FROM waste_records WHERE id=?1", [id], |r| {
            r.get::<_, i64>(0)
        })
        .optional()?
        .is_none()
    {
        return Err(ApiError::not_found("报损记录不存在"));
    }
    if db.execute("UPDATE waste_records SET status='rejected',confirmed_by=?1,confirmed_at=?2 WHERE id=?3 AND status='pending'",params![u.id,now(),id])?!=1{return Err(ApiError::conflict("该报损记录已处理"));}
    Ok(Json(waste_json(&db, id)?))
}

fn count_detail_json(db: &Connection, id: i64) -> rusqlite::Result<Value> {
    let (status,count_type,business_date,note,created_by,creator,created_at,verified_by,verifier,verified_at,review_reason,review_note,comparison_id):(String,String,Option<String>,Option<String>,i64,String,String,Option<i64>,String,Option<String>,Option<String>,Option<String>,Option<i64>)=db.query_row("SELECT c.status,c.count_type,c.business_date,c.note,c.created_by,coalesce(cu.display_name,''),c.created_at,c.verified_by,coalesce(vu.display_name,''),c.verified_at,c.review_reason,c.review_note,c.comparison_id FROM count_sessions c LEFT JOIN users cu ON cu.id=c.created_by LEFT JOIN users vu ON vu.id=c.verified_by WHERE c.id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?,r.get(10)?,r.get(11)?,r.get(12)?)))?;
    let mut st=db.prepare("SELECT e.id,e.item_id,coalesce(i.name,'?'),coalesce(i.unit,''),e.expected_qty,e.qty_counted,e.is_enough,e.reviewed_qty,e.reported_qty,coalesce((SELECT sum(b.qty) FROM batches b WHERE b.item_id=e.item_id),0) FROM count_entries e LEFT JOIN items i ON i.id=e.item_id WHERE e.session_id=?1 ORDER BY e.id")?;
    let entries=st.query_map([id],|r|{let expected:i64=r.get(4)?;let counted:i64=r.get(5)?;let reviewed:Option<i64>=r.get(7)?;Ok(json!({"id":r.get::<_,i64>(0)?,"item_id":r.get::<_,i64>(1)?,"item_name":r.get::<_,String>(2)?,"unit":r.get::<_,String>(3)?,"expected_qty":expected,"qty_counted":counted,"diff":counted-expected,"is_enough":r.get::<_,Option<bool>>(6)?,"reviewed_qty":reviewed,"reported_qty":r.get::<_,Option<i64>>(8)?,"review_diff":reviewed.map(|qty|qty-counted),"current_qty":r.get::<_,i64>(9)?}))})?.collect::<Result<Vec<_>,_>>()?;
    Ok(
        json!({"id":id,"status":status,"count_type":count_type,"business_date":business_date,"note":note,"created_by":created_by,"created_by_name":creator,"created_at":out_dt(created_at),"verified_by":verified_by,"verified_by_name":verifier,"verified_at":verified_at.map(out_dt),"review_reason":review_reason,"review_note":review_note,"comparison_id":comparison_id,"entries":entries}),
    )
}
#[derive(Deserialize)]
struct CountLineIn {
    item_id: i64,
    #[serde(default)]
    qty: Option<i64>,
    #[serde(default)]
    enough: Option<bool>,
}
fn default_count_type() -> String {
    "weekly".to_string()
}
#[derive(Deserialize)]
struct CountCreateIn {
    #[serde(default = "default_count_type")]
    count_type: String,
    entries: Vec<CountLineIn>,
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    overwrite_daily: bool,
}
async fn create_count(
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(p): Json<CountCreateIn>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let mut db = s.db.lock().unwrap();
    let u = current_user(&db, &s.secret, &headers, Some("staff"), false)?;
    if p.count_type == "weekly" && u.role == "admin" {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "管理员不提交每周盘点"));
    }
    if p.count_type != "daily" && p.count_type != "weekly" {
        return Err(ApiError::bad("盘点类型无效"));
    }
    if p.entries.is_empty() {
        return Err(ApiError::bad("盘点条目不能为空"));
    }
    let mut seen = HashSet::new();
    for e in &p.entries {
        if e.qty.is_some_and(|qty| qty < 0) {
            return Err(ApiError::bad("盘点数量不能为负数"));
        }
        if p.count_type == "daily" && e.enough.is_none() {
            return Err(ApiError::bad("每日盘点必须确认够或不够"));
        }
        if p.count_type == "daily" && e.enough == Some(false) && e.qty.is_none() {
            return Err(ApiError::bad("每日盘点选择不够时必须填写现场数量"));
        }
        if p.count_type == "weekly" && e.qty.is_none() {
            return Err(ApiError::bad("每周盘点必须填写盘点数量"));
        }
        if p.count_type == "weekly" && e.enough.is_some() {
            return Err(ApiError::bad("每周盘点必须填写实际数量"));
        }
        if !seen.insert(e.item_id) {
            return Err(ApiError::bad("盘点条目重复"));
        }
        if !item_exists(&db, e.item_id)? {
            return Err(ApiError::bad(&format!("库存品不存在：{}", e.item_id)));
        }
        let (name, daily_enabled, weekly_enabled): (String, bool, bool) = db.query_row(
            "SELECT name,daily_count_enabled,weekly_count_enabled FROM items WHERE id=?1",
            [e.item_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        if p.count_type == "daily" && !daily_enabled {
            return Err(ApiError::bad(&format!("库存品未启用每日盘点：{name}")));
        }
        if p.count_type == "weekly" && !weekly_enabled {
            return Err(ApiError::bad(&format!("库存品未启用每周盘点：{name}")));
        }
    }
    let business_date = if p.count_type == "daily" {
        Some(store_today().format("%Y-%m-%d").to_string())
    } else {
        None
    };
    let existing_id: Option<i64> = if let Some(day) = business_date.as_ref() {
        db.query_row(
            "SELECT id FROM count_sessions WHERE count_type='daily' AND business_date=?1 AND status='completed'",
            [day], |r| r.get(0),
        ).optional()?
    } else {
        None
    };
    if let Some(id) = existing_id.filter(|_| !p.overwrite_daily) {
        let mut previous = HashMap::new();
        let mut st = db.prepare(
            "SELECT item_id,is_enough,reported_qty FROM count_entries WHERE session_id=?1",
        )?;
        for row in st.query_map([id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                (r.get::<_, Option<bool>>(1)?, r.get::<_, Option<i64>>(2)?),
            ))
        })? {
            let (item, values) = row?;
            previous.insert(item, values);
        }
        let incoming: HashMap<i64, (Option<bool>, Option<i64>)> = p
            .entries
            .iter()
            .map(|entry| (entry.item_id, (entry.enough, entry.qty)))
            .collect();
        let mut item_ids: Vec<i64> = previous.keys().chain(incoming.keys()).copied().collect();
        item_ids.sort_unstable();
        item_ids.dedup();
        let mut changes = Vec::new();
        let mut unchanged = 0;
        for item in item_ids {
            let old = previous.get(&item).copied().unwrap_or((None, None));
            let new = incoming.get(&item).copied().unwrap_or((None, None));
            if old == new {
                unchanged += 1;
                continue;
            }
            let name: String = db
                .query_row("SELECT name FROM items WHERE id=?1", [item], |r| r.get(0))
                .unwrap_or_else(|_| format!("商品#{item}"));
            changes.push(
                json!({"item_id":item,"item_name":name,"previous_enough":old.0,"new_enough":new.0,"previous_qty":old.1,"new_qty":new.1}),
            );
        }
        return Err(ApiError::conflict(
            json!({"code":"daily_count_exists","message":"今日已有每日盘点结果","count_id":id,"changes":changes,"unchanged_count":unchanged}),
        ));
    }
    let tx = db.transaction()?;
    let status = if p.count_type == "daily" {
        "completed"
    } else {
        "submitted"
    };
    let id = if let Some(id) = existing_id {
        tx.execute("DELETE FROM count_entries WHERE session_id=?1", [id])?;
        tx.execute(
            "UPDATE count_sessions SET created_by=?1,created_at=?2,note=?3 WHERE id=?4",
            params![u.id, now(), p.note.as_deref(), id],
        )?;
        id
    } else {
        tx.execute("INSERT INTO count_sessions(status,count_type,business_date,created_by,created_at,note) VALUES(?1,?2,?3,?4,?5,?6)",params![status,&p.count_type,business_date.as_deref(),u.id,now(),p.note.as_deref()])?;
        tx.last_insert_rowid()
    };
    for e in p.entries {
        let expected = item_stock(&tx, e.item_id)?;
        let counted = if p.count_type == "daily" {
            expected
        } else {
            e.qty.unwrap()
        };
        let enough = if p.count_type == "daily" {
            e.enough
        } else {
            None
        };
        let reported_qty = if p.count_type == "daily" { e.qty } else { None };
        tx.execute("INSERT INTO count_entries(session_id,item_id,qty_counted,expected_qty,is_enough,reported_qty) VALUES(?1,?2,?3,?4,?5,?6)",params![id,e.item_id,counted,expected,enough,reported_qty])?;
    }
    tx.commit()?;
    Ok((StatusCode::CREATED, Json(count_detail_json(&db, id)?)))
}
async fn list_counts(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<StatusQuery>,
) -> Result<Json<Value>, ApiError> {
    let db = read_db(&s)?;
    let u = current_user(&db, &s.secret, &headers, Some("staff"), false)?;
    if q.count_type
        .as_deref()
        .is_some_and(|kind| kind != "daily" && kind != "weekly")
    {
        return Err(ApiError::bad("盘点类型无效"));
    }
    if q.days.is_some_and(|days| !(1..=30).contains(&days)) {
        return Err(ApiError::bad("days 必须在 1 到 30 之间"));
    }
    let mut st=db.prepare("SELECT c.id,c.status,c.count_type,c.business_date,c.note,c.created_by,coalesce(cu.display_name,''),c.created_at,c.verified_by,coalesce(vu.display_name,''),c.verified_at,c.review_reason,c.review_note,c.comparison_id,(SELECT count(*) FROM count_entries e WHERE e.session_id=c.id),(SELECT count(*) FROM count_entries e WHERE e.session_id=c.id AND e.reviewed_qty IS NOT NULL AND e.reviewed_qty<>e.qty_counted),(SELECT count(*) FROM count_entries e WHERE e.session_id=c.id AND e.is_enough=1),(SELECT count(*) FROM count_entries e WHERE e.session_id=c.id AND e.is_enough=0),(SELECT count(*) FROM count_entries e WHERE e.session_id=c.id AND e.reported_qty IS NOT NULL) FROM count_sessions c LEFT JOIN users cu ON cu.id=c.created_by LEFT JOIN users vu ON vu.id=c.verified_by WHERE (?1 IS NULL OR c.status=?1) AND (?2 IS NULL OR c.count_type=?2) AND (?3 IS NULL OR datetime(c.created_at)>=datetime('now','-' || ?3 || ' days')) AND (?4=0 OR c.count_type<>'weekly' OR c.created_by=?5) ORDER BY c.id DESC")?;
    let rows=st.query_map(params![q.status,q.count_type,q.days,i64::from(u.role=="staff"),u.id],|r|Ok(json!({"id":r.get::<_,i64>(0)?,"status":r.get::<_,String>(1)?,"count_type":r.get::<_,String>(2)?,"business_date":r.get::<_,Option<String>>(3)?,"note":r.get::<_,Option<String>>(4)?,"created_by":r.get::<_,i64>(5)?,"created_by_name":r.get::<_,String>(6)?,"created_at":out_dt(r.get(7)?),"verified_by":r.get::<_,Option<i64>>(8)?,"verified_by_name":r.get::<_,String>(9)?,"verified_at":r.get::<_,Option<String>>(10)?.map(out_dt),"review_reason":r.get::<_,Option<String>>(11)?,"review_note":r.get::<_,Option<String>>(12)?,"comparison_id":r.get::<_,Option<i64>>(13)?,"entries_count":r.get::<_,i64>(14)?,"difference_count":r.get::<_,i64>(15)?,"enough_count":r.get::<_,i64>(16)?,"not_enough_count":r.get::<_,i64>(17)?,"quantity_count":r.get::<_,i64>(18)?})))?.collect::<Result<Vec<_>,_>>()?;
    Ok(Json(Value::Array(rows)))
}
async fn count_detail(
    State(s): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let db = read_db(&s)?;
    let u = current_user(&db, &s.secret, &headers, Some("staff"), false)?;
    let state = db
        .query_row(
            "SELECT count_type,created_by FROM count_sessions WHERE id=?1",
            [id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
        )
        .optional()?;
    let Some((kind, created_by)) = state else {
        return Err(ApiError::not_found("盘点单不存在"));
    };
    if kind == "weekly" && u.role == "staff" && created_by != u.id {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "只能查看自己提交的盘点单",
        ));
    }
    Ok(Json(count_detail_json(&db, id)?))
}
#[derive(Deserialize)]
struct CountEditIn {
    entries: Vec<CountLineIn>,
    #[serde(default)]
    note: Option<String>,
}
async fn edit_count(
    State(s): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Json(p): Json<CountEditIn>,
) -> Result<Json<Value>, ApiError> {
    let mut db = s.db.lock().unwrap();
    let u = current_user(&db, &s.secret, &headers, Some("staff"), false)?;
    let state = db
        .query_row(
            "SELECT count_type,status,created_by FROM count_sessions WHERE id=?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((kind, status, created_by)) = state else {
        return Err(ApiError::not_found("盘点单不存在"));
    };
    if kind != "weekly" {
        return Err(ApiError::conflict("每日盘点不支持此方式修改"));
    }
    if created_by != u.id {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "只能修改自己提交的盘点单",
        ));
    }
    if status != "submitted" {
        return Err(ApiError::conflict("盘点单已核对或驳回，不能修改"));
    }
    if p.entries.is_empty() {
        return Err(ApiError::bad("盘点条目不能为空"));
    }
    if p.note
        .as_ref()
        .is_some_and(|note| note.chars().count() > 255)
    {
        return Err(ApiError::bad("备注长度无效"));
    }
    let mut incoming = HashMap::new();
    for entry in p.entries {
        let Some(qty) = entry.qty else {
            return Err(ApiError::bad("每周盘点必须填写盘点数量"));
        };
        if qty < 0 || entry.enough.is_some() {
            return Err(ApiError::bad("每周盘点必须填写实际数量"));
        }
        if incoming.insert(entry.item_id, qty).is_some() {
            return Err(ApiError::bad("盘点条目重复"));
        }
    }
    let mut st =
        db.prepare("SELECT item_id FROM count_entries WHERE session_id=?1 ORDER BY item_id")?;
    let existing = st
        .query_map([id], |r| r.get::<_, i64>(0))?
        .collect::<Result<HashSet<_>, _>>()?;
    drop(st);
    let incoming_ids: HashSet<i64> = incoming.keys().copied().collect();
    if !existing.is_subset(&incoming_ids) {
        return Err(ApiError::bad("修改不能删除原盘点条目"));
    }
    for item_id in incoming_ids.difference(&existing) {
        let item = db
            .query_row(
                "SELECT name,active,weekly_count_enabled FROM items WHERE id=?1",
                [item_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, bool>(1)?,
                        r.get::<_, bool>(2)?,
                    ))
                },
            )
            .optional()?;
        let Some((name, active, weekly_enabled)) = item else {
            return Err(ApiError::bad(&format!("库存品不存在或已停用：{item_id}")));
        };
        if !active {
            return Err(ApiError::bad(&format!("库存品不存在或已停用：{item_id}")));
        }
        if !weekly_enabled {
            return Err(ApiError::bad(&format!("库存品未启用每周盘点：{name}")));
        }
    }
    let tx = db.transaction()?;
    let note = p
        .note
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if tx.execute("UPDATE count_sessions SET created_at=?1,note=?2 WHERE id=?3 AND status='submitted' AND created_by=?4", params![now(),note,id,u.id])? != 1 {
        return Err(ApiError::conflict("盘点单状态已变化，请刷新"));
    }
    for (item_id, qty) in incoming {
        let expected = item_stock(&tx, item_id)?;
        if existing.contains(&item_id) {
            if tx.execute("UPDATE count_entries SET qty_counted=?1,expected_qty=?2,reviewed_qty=NULL WHERE session_id=?3 AND item_id=?4", params![qty,expected,id,item_id])? != 1 {
                return Err(ApiError::conflict("盘点单明细已变化，请刷新"));
            }
        } else {
            tx.execute(
                "INSERT INTO count_entries(session_id,item_id,qty_counted,expected_qty,is_enough,reported_qty,reviewed_qty) VALUES(?1,?2,?3,?4,NULL,NULL,NULL)",
                params![id,item_id,qty,expected],
            )?;
        }
    }
    tx.commit()?;
    Ok(Json(count_detail_json(&db, id)?))
}

#[derive(Deserialize)]
struct CountPairIn {
    first_count_id: i64,
    second_count_id: i64,
}

#[derive(Deserialize)]
struct CountCorrectionIn {
    item_id: i64,
    qty: i64,
}

#[derive(Deserialize)]
struct CountPairConfirmIn {
    first_count_id: i64,
    second_count_id: i64,
    comparison_token: String,
    resolution: String,
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    corrections: Vec<CountCorrectionIn>,
}

#[derive(Clone)]
struct PairSession {
    id: i64,
    created_by: i64,
    created_by_name: String,
    created_at: String,
    note: Option<String>,
}

#[derive(Clone)]
struct PairEntry {
    item_id: i64,
    item_name: String,
    unit: String,
    first_qty: Option<i64>,
    second_qty: Option<i64>,
    current_qty: i64,
    result: String,
}

struct PairState {
    first: PairSession,
    second: PairSession,
    later_count_id: i64,
    entries: Vec<PairEntry>,
    token: String,
}

impl PairState {
    fn json(&self) -> Value {
        let entries: Vec<Value> = self
            .entries
            .iter()
            .map(|row| {
                json!({"item_id":row.item_id,"item_name":row.item_name,"unit":row.unit,"first_qty":row.first_qty,"second_qty":row.second_qty,"current_qty":row.current_qty,"result":row.result})
            })
            .collect();
        json!({
            "first":{"id":self.first.id,"created_by":self.first.created_by,"created_by_name":self.first.created_by_name,"created_at":out_dt(self.first.created_at.clone()),"note":self.first.note},
            "second":{"id":self.second.id,"created_by":self.second.created_by,"created_by_name":self.second.created_by_name,"created_at":out_dt(self.second.created_at.clone()),"note":self.second.note},
            "later_count_id":self.later_count_id,
            "shared_count":self.entries.iter().filter(|row| row.first_qty.is_some() && row.second_qty.is_some()).count(),
            "different_count":self.entries.iter().filter(|row| row.result=="different").count(),
            "missing_count":self.entries.iter().filter(|row| row.result.starts_with("missing_")).count(),
            "entries":entries,
            "comparison_token":self.token,
        })
    }
}

fn pair_state(
    db: &Connection,
    first_id: i64,
    second_id: i64,
    actor: &User,
) -> Result<PairState, ApiError> {
    if first_id == second_id {
        return Err(ApiError::bad("请选择两份不同的盘点记录"));
    }
    let load_session =
        |id: i64| -> rusqlite::Result<Option<(PairSession, String, String, Option<i64>)>> {
            db.query_row(
            "SELECT c.id,c.created_by,coalesce(u.display_name,''),c.created_at,c.note,c.status,c.count_type,c.comparison_id FROM count_sessions c LEFT JOIN users u ON u.id=c.created_by WHERE c.id=?1",
            [id],
            |r| Ok((PairSession{id:r.get(0)?,created_by:r.get(1)?,created_by_name:r.get(2)?,created_at:r.get(3)?,note:r.get(4)?},r.get(5)?,r.get(6)?,r.get(7)?)),
        ).optional()
        };
    let Some((first, first_status, first_kind, first_comparison)) = load_session(first_id)? else {
        return Err(ApiError::not_found("盘点记录不存在"));
    };
    let Some((second, second_status, second_kind, second_comparison)) = load_session(second_id)?
    else {
        return Err(ApiError::not_found("盘点记录不存在"));
    };
    for (session, status, kind, comparison) in [
        (&first, &first_status, &first_kind, first_comparison),
        (&second, &second_status, &second_kind, second_comparison),
    ] {
        if kind != "weekly" {
            return Err(ApiError::bad("只能比对每周盘点记录"));
        }
        if status != "submitted" || comparison.is_some() {
            return Err(ApiError::conflict(
                json!({"code":"count_already_processed","message":"盘点记录已处理"}),
            ));
        }
        let cutoff = (Utc::now().naive_utc() - Duration::hours(72))
            .format("%Y-%m-%d %H:%M:%S%.6f")
            .to_string();
        if db.query_row(
            "SELECT datetime(?1)<datetime(?2)",
            params![session.created_at, cutoff],
            |r| r.get::<_, bool>(0),
        )? {
            return Err(ApiError::bad("只能选择近72小时的盘点记录"));
        }
        let role: Option<String> = db
            .query_row(
                "SELECT role FROM users WHERE id=?1",
                [session.created_by],
                |r| r.get(0),
            )
            .optional()?;
        if !matches!(role.as_deref(), Some("staff" | "manager")) {
            return Err(ApiError::bad("盘点提交人身份不符合要求"));
        }
    }
    if first.created_by == second.created_by {
        return Err(ApiError::bad("两份记录必须由不同人员独立提交"));
    }
    if actor.id == first.created_by || actor.id == second.created_by {
        return Err(ApiError::conflict(
            json!({"code":"self_review_not_allowed","message":"确认人不能是任一盘点提交人"}),
        ));
    }
    let load_entries = |session_id: i64| -> rusqlite::Result<HashMap<i64, i64>> {
        let mut statement =
            db.prepare("SELECT item_id,qty_counted FROM count_entries WHERE session_id=?1")?;
        statement
            .query_map([session_id], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
            })?
            .collect::<Result<HashMap<_, _>, _>>()
    };
    let left = load_entries(first.id)?;
    let right = load_entries(second.id)?;
    let mut item_ids: Vec<i64> = left.keys().chain(right.keys()).copied().collect();
    item_ids.sort_unstable();
    item_ids.dedup();
    if !item_ids
        .iter()
        .any(|id| left.contains_key(id) && right.contains_key(id))
    {
        return Err(ApiError::conflict(
            json!({"code":"no_comparable_items","message":"两份记录没有共同库存品，无法比对"}),
        ));
    }
    let mut entries = Vec::new();
    let mut token_rows = Vec::new();
    for item_id in item_ids {
        let (name, unit): (String, String) =
            db.query_row("SELECT name,unit FROM items WHERE id=?1", [item_id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?;
        let first_qty = left.get(&item_id).copied();
        let second_qty = right.get(&item_id).copied();
        let result = match (first_qty, second_qty) {
            (None, _) => "missing_first",
            (_, None) => "missing_second",
            (Some(a), Some(b)) if a == b => "same",
            _ => "different",
        }
        .to_string();
        let current_qty = item_stock(db, item_id)?;
        token_rows.push(json!([item_id, first_qty, second_qty, current_qty]));
        entries.push(PairEntry {
            item_id,
            item_name: name,
            unit,
            first_qty,
            second_qty,
            current_qty,
            result,
        });
    }
    let token_data = json!({"sessions":[[first.id,first_status,first.created_at,first_comparison],[second.id,second_status,second.created_at,second_comparison]],"rows":token_rows});
    let token = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&token_data).unwrap())
    );
    let later_count_id =
        if (second.created_at.as_str(), second.id) > (first.created_at.as_str(), first.id) {
            second.id
        } else {
            first.id
        };
    Ok(PairState {
        first,
        second,
        later_count_id,
        entries,
        token,
    })
}

async fn preview_count_pair(
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(p): Json<CountPairIn>,
) -> Result<Json<Value>, ApiError> {
    let db = read_db(&s)?;
    let user = current_user(&db, &s.secret, &headers, Some("manager"), false)?;
    Ok(Json(
        pair_state(&db, p.first_count_id, p.second_count_id, &user)?.json(),
    ))
}

fn count_comparison_json(db: &Connection, id: i64) -> rusqlite::Result<Value> {
    let (first,second,resolution,trusted,note,confirmed_by,confirmed_name,confirmed_at):(i64,i64,String,Option<i64>,Option<String>,i64,String,String)=db.query_row("SELECT c.first_session_id,c.second_session_id,c.resolution,c.trusted_session_id,c.note,c.confirmed_by,coalesce(u.display_name,''),c.confirmed_at FROM count_comparisons c LEFT JOIN users u ON u.id=c.confirmed_by WHERE c.id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?)))?;
    let mut st=db.prepare("SELECT e.item_id,coalesce(i.name,'?'),coalesce(i.unit,''),e.first_qty,e.second_qty,e.final_qty,e.result FROM count_comparison_entries e LEFT JOIN items i ON i.id=e.item_id WHERE e.comparison_id=?1 ORDER BY e.id")?;
    let entries=st.query_map([id],|r|Ok(json!({"item_id":r.get::<_,i64>(0)?,"item_name":r.get::<_,String>(1)?,"unit":r.get::<_,String>(2)?,"first_qty":r.get::<_,Option<i64>>(3)?,"second_qty":r.get::<_,Option<i64>>(4)?,"final_qty":r.get::<_,Option<i64>>(5)?,"result":r.get::<_,String>(6)?})))?.collect::<Result<Vec<_>,_>>()?;
    Ok(
        json!({"id":id,"first_count_id":first,"second_count_id":second,"resolution":resolution,"trusted_count_id":trusted,"note":note,"confirmed_by":confirmed_by,"confirmed_by_name":confirmed_name,"confirmed_at":out_dt(confirmed_at),"entries":entries}),
    )
}

async fn confirm_count_pair(
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(p): Json<CountPairConfirmIn>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let mut db = s.db.lock().unwrap();
    let user = current_user(&db, &s.secret, &headers, Some("manager"), false)?;
    let state = pair_state(&db, p.first_count_id, p.second_count_id, &user)?;
    if state.token != p.comparison_token {
        return Err(ApiError::conflict(
            json!({"code":"count_comparison_changed","message":"盘点记录或库存已变化，请重新比对"}),
        ));
    }
    let valid = [
        "no_difference",
        "normal_consumption",
        "trusted_first",
        "trusted_second",
        "manager_corrected",
        "recount_required",
    ];
    if !valid.contains(&p.resolution.as_str()) {
        return Err(ApiError::bad("比对处理方式无效"));
    }
    let different: HashSet<i64> = state
        .entries
        .iter()
        .filter(|r| r.result == "different")
        .map(|r| r.item_id)
        .collect();
    if p.resolution == "no_difference" && !different.is_empty() {
        return Err(ApiError::bad("两份盘点存在差异，不能按无差异确认"));
    }
    if matches!(
        p.resolution.as_str(),
        "normal_consumption" | "trusted_first" | "trusted_second" | "manager_corrected"
    ) && different.is_empty()
    {
        return Err(ApiError::bad("两份盘点没有差异，请直接确认"));
    }
    let note = p
        .note
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    if matches!(
        p.resolution.as_str(),
        "trusted_first" | "trusted_second" | "manager_corrected" | "recount_required"
    ) && note.is_none()
    {
        return Err(ApiError::bad("该处理方式必须填写差异原因"));
    }
    if note.as_ref().is_some_and(|v| v.chars().count() > 255) {
        return Err(ApiError::bad("差异原因不能超过255字"));
    }
    let mut corrections = HashMap::new();
    for row in p.corrections {
        if row.qty < 0 {
            return Err(ApiError::bad("更正数量不能为负数"));
        }
        if corrections.insert(row.item_id, row.qty).is_some() {
            return Err(ApiError::bad("更正条目重复"));
        }
    }
    if p.resolution == "manager_corrected"
        && corrections.keys().copied().collect::<HashSet<_>>() != different
    {
        return Err(ApiError::bad("管理员更正必须填写全部差异项目"));
    }
    if p.resolution != "manager_corrected" && !corrections.is_empty() {
        return Err(ApiError::bad("当前处理方式不接受更正数量"));
    }
    let mut final_qty = HashMap::new();
    if p.resolution != "recount_required" {
        for row in state
            .entries
            .iter()
            .filter(|r| r.first_qty.is_some() && r.second_qty.is_some())
        {
            let qty = if row.result == "same" || p.resolution == "no_difference" {
                row.first_qty.unwrap()
            } else {
                match p.resolution.as_str() {
                    "normal_consumption" => {
                        if state.later_count_id == state.first.id {
                            row.first_qty.unwrap()
                        } else {
                            row.second_qty.unwrap()
                        }
                    }
                    "trusted_first" => row.first_qty.unwrap(),
                    "trusted_second" => row.second_qty.unwrap(),
                    "manager_corrected" => corrections[&row.item_id],
                    _ => unreachable!(),
                }
            };
            final_qty.insert(row.item_id, qty);
        }
    }
    let confirmed_at = now();
    let tx = db.transaction()?;
    tx.execute("INSERT INTO count_comparisons(first_session_id,second_session_id,resolution,trusted_session_id,note,confirmed_by,confirmed_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![state.first.id,state.second.id,p.resolution,if p.resolution=="trusted_first"{Some(state.first.id)}else if p.resolution=="trusted_second"{Some(state.second.id)}else{None},note,user.id,confirmed_at])?;
    let comparison_id = tx.last_insert_rowid();
    let status = if p.resolution == "recount_required" {
        "rejected"
    } else {
        "verified"
    };
    let reason = format!("paired_{}", p.resolution);
    for count_id in [state.first.id, state.second.id] {
        if tx.execute("UPDATE count_sessions SET status=?1,comparison_id=?2,verified_by=?3,verified_at=?4,review_reason=?5,review_note=?6 WHERE id=?7 AND status='submitted' AND comparison_id IS NULL",params![status,comparison_id,user.id,confirmed_at,reason,note,count_id])?!=1{return Err(ApiError::conflict(json!({"code":"count_comparison_changed","message":"盘点记录已被处理"})));}
    }
    for row in &state.entries {
        let target = final_qty.get(&row.item_id).copied();
        tx.execute("INSERT INTO count_comparison_entries(comparison_id,item_id,first_qty,second_qty,final_qty,result) VALUES(?1,?2,?3,?4,?5,?6)",params![comparison_id,row.item_id,row.first_qty,row.second_qty,target,row.result])?;
        if let Some(target) = target {
            tx.execute("UPDATE count_entries SET reviewed_qty=?1 WHERE session_id IN (?2,?3) AND item_id=?4",params![target,state.first.id,state.second.id,row.item_id])?;
            let current = item_stock(&tx, row.item_id)?;
            let diff = target - current;
            if diff < 0 {
                deduct_fefo(
                    &tx,
                    row.item_id,
                    -diff,
                    None,
                    user.id,
                    "count_shortage",
                    "count_comparison",
                    Some(comparison_id),
                )?;
            } else if diff > 0 {
                let life: i64 = tx.query_row(
                    "SELECT shelf_life_days FROM items WHERE id=?1",
                    [row.item_id],
                    |r| r.get(0),
                )?;
                let expiry = (store_today() + Duration::days(life))
                    .format("%Y-%m-%d")
                    .to_string();
                tx.execute("INSERT INTO batches(item_id,qty,initial_qty,expiry_date,received_at,source,note) VALUES(?1,?2,?2,?3,?4,'adjust','双人盘点盘盈')",params![row.item_id,diff,expiry,now()])?;
                let batch = tx.last_insert_rowid();
                movement(
                    &tx,
                    row.item_id,
                    batch,
                    diff,
                    "count_surplus",
                    "count_comparison",
                    Some(comparison_id),
                    user.id,
                )?;
            }
        }
    }
    tx.commit()?;
    Ok((
        StatusCode::CREATED,
        Json(count_comparison_json(&db, comparison_id)?),
    ))
}

async fn count_comparison_detail(
    State(s): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let db = read_db(&s)?;
    current_user(&db, &s.secret, &headers, Some("manager"), false)?;
    if db
        .query_row("SELECT 1 FROM count_comparisons WHERE id=?1", [id], |r| {
            r.get::<_, i64>(0)
        })
        .optional()?
        .is_none()
    {
        return Err(ApiError::not_found("盘点比对不存在"));
    }
    Ok(Json(count_comparison_json(&db, id)?))
}

#[derive(Deserialize)]
struct CountReviewLineIn {
    item_id: i64,
    qty: i64,
    #[serde(default)]
    expected_current_qty: Option<i64>,
}

#[derive(Deserialize)]
struct CountVerifyIn {
    entries: Vec<CountReviewLineIn>,
    #[serde(default)]
    difference_reason: Option<String>,
    #[serde(default)]
    difference_note: Option<String>,
}

async fn verify_count(
    State(s): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Json(_p): Json<CountVerifyIn>,
) -> Result<Json<Value>, ApiError> {
    let db = s.db.lock().unwrap();
    let u = current_user(&db, &s.secret, &headers, Some("manager"), false)?;
    let _ = (id, u);
    return Err(ApiError::conflict(
        json!({"code":"pair_verification_required","message":"每周盘点必须选择两份独立记录进行比对确认"}),
    ));
    #[allow(unreachable_code)]
    {
        let mut db = s.db.lock().unwrap();
        let u = current_user(&db, &s.secret, &headers, Some("manager"), false)?;
        let p = _p;
        let state: Option<(String, String, i64)> = db
            .query_row(
                "SELECT status,count_type,created_by FROM count_sessions WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((status, count_type, created_by)) = state else {
            return Err(ApiError::not_found("盘点单不存在"));
        };
        if count_type != "weekly" {
            return Err(ApiError::conflict("每日盘点无需核对"));
        }
        if status != "submitted" {
            return Err(ApiError::conflict("该盘点单已处理"));
        }
        if created_by == u.id {
            return Err(ApiError::conflict(
                json!({"code":"self_review_not_allowed","message":"盘点提交人不能核对自己的盘点单"}),
            ));
        }
        if p.entries.is_empty() {
            return Err(ApiError::bad("核对条目不能为空"));
        }
        if p.difference_reason
            .as_deref()
            .is_some_and(|reason| reason != "normal_consumption" && reason != "recount_corrected")
        {
            return Err(ApiError::bad("差异原因无效"));
        }
        if p.difference_note
            .as_ref()
            .is_some_and(|note| note.chars().count() > 255)
        {
            return Err(ApiError::bad("差异说明不能超过 255 字"));
        }

        let mut st=db.prepare("SELECT e.item_id,e.qty_counted,e.expected_qty,coalesce(i.name,'?'),i.shelf_life_days FROM count_entries e LEFT JOIN items i ON i.id=e.item_id WHERE e.session_id=?1 ORDER BY e.id")?;
        let entries = st
            .query_map([id], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(st);

        let mut reviewed = HashMap::new();
        for line in p.entries {
            if line.qty < 0 || line.expected_current_qty.is_some_and(|qty| qty < 0) {
                return Err(ApiError::bad("核对数量不能为负数"));
            }
            if reviewed.insert(line.item_id, line).is_some() {
                return Err(ApiError::bad("核对条目重复"));
            }
        }
        if reviewed.len() != entries.len()
            || entries.iter().any(|entry| !reviewed.contains_key(&entry.0))
        {
            return Err(ApiError::bad("核对必须逐项录入该盘点单的全部库存品"));
        }

        let mut differences = Vec::new();
        let mut conflicts = Vec::new();
        for (item, submitted_qty, _, name, _) in &entries {
            let review = &reviewed[item];
            if review.qty != *submitted_qty {
                differences.push(json!({"item_id":item,"item_name":name,"submitted_qty":submitted_qty,"reviewed_qty":review.qty,"diff":review.qty-submitted_qty}));
            }
            let current = item_stock(&db, *item)?;
            if review
                .expected_current_qty
                .is_some_and(|expected| expected != current)
            {
                conflicts.push(json!({"item_id":item,"item_name":name,"expected_qty":review.expected_current_qty,"current_qty":current}));
            }
        }
        if !conflicts.is_empty() {
            return Err(ApiError::conflict(
                json!({"code":"stock_changed","message":"核对录入期间库存发生变化，请刷新后重新核对","items":conflicts}),
            ));
        }
        if !differences.is_empty() && p.difference_reason.is_none() {
            return Err(ApiError::conflict(
                json!({"code":"count_difference","message":"两次盘点存在差异，请确认是否为正常消耗；否则重新盘点并录入","items":differences}),
            ));
        }
        let review_note = p
            .difference_note
            .map(|note| note.trim().to_string())
            .filter(|note| !note.is_empty());
        if !differences.is_empty()
            && p.difference_reason.as_deref() == Some("recount_corrected")
            && review_note.is_none()
        {
            return Err(ApiError::bad("非正常消耗差异重新盘点后必须填写差异说明"));
        }
        let review_reason = if differences.is_empty() {
            "no_difference"
        } else {
            p.difference_reason.as_deref().unwrap()
        };

        let tx = db.transaction()?;
        if tx.execute("UPDATE count_sessions SET status='verified',verified_by=?1,verified_at=?2,review_reason=?3,review_note=?4 WHERE id=?5 AND status='submitted'",params![u.id,now(),review_reason,review_note,id])?!=1{return Err(ApiError::conflict("该盘点单已处理"));}
        for (item, _, _, _, life) in entries {
            let target = reviewed[&item].qty;
            let current = item_stock(&tx, item)?;
            let diff = target - current;
            tx.execute(
                "UPDATE count_entries SET reviewed_qty=?1 WHERE session_id=?2 AND item_id=?3",
                params![target, id, item],
            )?;
            if diff < 0 {
                deduct_fefo(
                    &tx,
                    item,
                    -diff,
                    None,
                    u.id,
                    "count_shortage",
                    "count",
                    Some(id),
                )?;
            } else if diff > 0 {
                let expiry = (store_today() + Duration::days(life))
                    .format("%Y-%m-%d")
                    .to_string();
                tx.execute("INSERT INTO batches(item_id,qty,initial_qty,expiry_date,received_at,source,note) VALUES(?1,?2,?2,?3,?4,'adjust','盘盈')",params![item,diff,expiry,now()])?;
                let batch = tx.last_insert_rowid();
                movement(
                    &tx,
                    item,
                    batch,
                    diff,
                    "count_surplus",
                    "count",
                    Some(id),
                    u.id,
                )?;
            }
        }
        tx.commit()?;
        Ok(Json(count_detail_json(&db, id)?))
    }
}
async fn reject_count(
    State(s): State<AppState>,
    Path(_id): Path<i64>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let db = s.db.lock().unwrap();
    current_user(&db, &s.secret, &headers, Some("manager"), false)?;
    Err(ApiError::conflict(
        json!({"code":"pair_verification_required","message":"请在双人比对中同时退回两份记录重盘"}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use tower::ServiceExt;

    #[test]
    fn five_concurrent_deductions_never_overdraw() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("concurrency.db")).unwrap();
        conn.execute(
            "INSERT INTO users(username,display_name,pin_hash,role,active,must_change_pin,token_version,created_at) VALUES('m','店长','x','manager',1,0,0,CURRENT_TIMESTAMP)",
            [],
        ).unwrap();
        conn.execute("INSERT INTO items(name,category,unit,shelf_life_days,min_stock,active,sort_order,created_at) VALUES('面包','','袋',7,0,1,0,CURRENT_TIMESTAMP)",[]).unwrap();
        conn.execute("INSERT INTO batches(item_id,qty,initial_qty,expiry_date,received_at,source) VALUES(1,10,10,'2099-01-01',CURRENT_TIMESTAMP,'init')",[]).unwrap();
        let db = Arc::new(Mutex::new(conn));
        let handles: Vec<_> = (0..5)
            .map(|_| {
                let db = Arc::clone(&db);
                std::thread::spawn(move || {
                    let mut guard = db.lock().unwrap();
                    let tx = guard.transaction().unwrap();
                    if deduct_fefo(&tx, 1, 3, None, 1, "test", "test", None).is_ok() {
                        tx.commit().unwrap();
                        true
                    } else {
                        false
                    }
                })
            })
            .collect();
        let successes = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .filter(|success| *success)
            .count();
        let guard = db.lock().unwrap();
        assert_eq!(successes, 3);
        assert_eq!(item_stock(&guard, 1).unwrap(), 1);
        assert_eq!(
            guard
                .query_row("SELECT count(*) FROM stock_movements", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            3
        );
    }

    #[tokio::test]
    async fn fifth_failed_login_is_rate_limited() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rate.db");
        let conn = crate::db::open(&path).unwrap();
        conn.execute("INSERT INTO users(username,display_name,pin_hash,role,active,must_change_pin,token_version,created_at) VALUES('limited','限流','x','staff',1,0,0,CURRENT_TIMESTAMP)",[]).unwrap();
        let state = AppState {
            db: Arc::new(Mutex::new(conn)),
            db_path: Arc::new(path),
            secret: Arc::new(b"test-secret-long-enough".to_vec()),
            app_version: Arc::new("test".into()),
            backend_kind: Arc::new("android_native".into()),
        };
        let app = router(state);
        for attempt in 1..=5 {
            let mut request = Request::builder()
                .method("POST")
                .uri("/api/auth/login")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"username":"limited","pin":"0000"}"#))
                .unwrap();
            request.extensions_mut().insert(ConnectInfo(
                "127.0.0.8:12345".parse::<SocketAddr>().unwrap(),
            ));
            let response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(
                response.status(),
                if attempt == 5 {
                    StatusCode::TOO_MANY_REQUESTS
                } else {
                    StatusCode::UNAUTHORIZED
                }
            );
        }
    }

    #[tokio::test]
    async fn get_api_supports_etag_revalidation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("etag.db");
        let conn = crate::db::open(&path).unwrap();
        let state = AppState {
            db: Arc::new(Mutex::new(conn)),
            db_path: Arc::new(path),
            secret: Arc::new(b"test-secret-long-enough".to_vec()),
            app_version: Arc::new("test".into()),
            backend_kind: Arc::new("android_native".into()),
        };
        let app = router(state);
        let first = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        let etag = first.headers().get(header::ETAG).unwrap().clone();

        let unchanged = app
            .oneshot(
                Request::builder()
                    .uri("/api/health")
                    .header(header::IF_NONE_MATCH, etag.clone())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unchanged.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(unchanged.headers().get(header::ETAG), Some(&etag));
        assert!(
            to_bytes(unchanged.into_body(), 1024)
                .await
                .unwrap()
                .is_empty()
        );
    }
}
