//! The owner role has an independent allowlist, never a business role level.
use super::*;

pub(super) async fn restrict_owner(
    State(s): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if request.uri().path().starts_with("/api/")
        && !matches!(
            request.uri().path(),
            "/api/auth/login" | "/api/auth/login-options" | "/api/health"
        )
        && request.headers().contains_key(header::AUTHORIZATION)
    {
        let checked =
            read_db(&s).and_then(|db| current_user(&db, &s.secret, request.headers(), None, true));
        match checked {
            Err(error) => return error.into_response(),
            Ok(user) if user.role == "owner_readonly" => {
                let allowed = match (request.method(), request.uri().path()) {
                    (&Method::GET, "/api/owner/dashboard" | "/api/auth/me") => true,
                    (&Method::POST, "/api/auth/change-pin") => true,
                    _ => false,
                };
                if !allowed {
                    return ApiError::new(
                        StatusCode::FORBIDDEN,
                        "老板账号仅可查看经营看板及修改自己的 PIN",
                    )
                    .into_response();
                }
            }
            _ => {}
        }
    }
    next.run(request).await
}

fn ids(db: &Connection, sql: &str) -> rusqlite::Result<Vec<i64>> {
    db.prepare(sql)?.query_map([], |r| r.get(0))?.collect()
}

pub(super) async fn dashboard(
    State(s): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let db = read_db(&s)?;
    // A single read transaction keeps summary and details from different sections consistent.
    db.execute_batch("BEGIN")?;
    let user = current_user(&db, &s.secret, &headers, None, false)?;
    if !matches!(user.role.as_str(), "owner_readonly" | "admin" | "manager") {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "权限不足"));
    }
    Ok(Json(snapshot(&db, &now(), store_today())?))
}

fn snapshot(db: &Connection, as_of: &str, today: NaiveDate) -> Result<Value, ApiError> {
    let date = today.to_string();
    let cutoff = (today + Duration::days(3)).to_string();
    let stock = ids(
        db,
        "SELECT id FROM items WHERE active=1 ORDER BY sort_order,id",
    )?
    .into_iter()
    .map(|id| item_json(db, id))
    .collect::<Result<Vec<_>, _>>()?;
    let mut expired = Vec::new();
    let mut upcoming = Vec::new();
    let mut statement = db.prepare("SELECT b.id,b.item_id,i.name,i.unit,b.qty,b.expiry_date FROM batches b JOIN items i ON i.id=b.item_id WHERE b.qty>0 AND b.expiry_date<=?1 ORDER BY b.expiry_date,b.id")?;
    let rows = statement.query_map([cutoff], |r| {
        let expiry: String = r.get(5)?;
        let days = NaiveDate::parse_from_str(&expiry, "%Y-%m-%d").map(|d| (d-today).num_days()).unwrap_or(0);
        Ok((days, json!({"batch_id":r.get::<_,i64>(0)?,"item_id":r.get::<_,i64>(1)?,"item_name":r.get::<_,String>(2)?,"unit":r.get::<_,String>(3)?,"qty":r.get::<_,Quantity>(4)?,"expiry_date":expiry,"days_to_expiry":days})))
    })?;
    for row in rows {
        let (days, value) = row?;
        if days < 0 {
            expired.push(value);
        } else {
            upcoming.push(value);
        }
    }
    let mut statement = db.prepare("SELECT DISTINCT i.id,i.name,i.unit FROM count_entries e JOIN count_sessions c ON c.id=e.session_id JOIN items i ON i.id=e.item_id WHERE c.count_type='daily' AND c.status='completed' AND c.business_date=?1 AND e.is_enough=0 ORDER BY i.id")?;
    let shortages = statement.query_map([date.clone()], |r| Ok(json!({"item_id":r.get::<_,i64>(0)?,"item_name":r.get::<_,String>(1)?,"unit":r.get::<_,String>(2)?})))?.collect::<Result<Vec<_>,_>>()?;
    let daily_latest_id = db.query_row("SELECT id FROM count_sessions WHERE count_type='daily' AND status='completed' AND business_date=?1 ORDER BY created_at DESC,id DESC LIMIT 1", [&date], |r| r.get::<_,i64>(0)).optional()?;
    let daily_latest = daily_latest_id
        .map(|id| count_detail_json(db, id))
        .transpose()?;
    let mut pending = ids(db, "SELECT id FROM count_sessions WHERE count_type='weekly' AND status='submitted' ORDER BY created_at,id")?
        .into_iter().map(|id| count_detail_json(db,id)).collect::<Result<Vec<_>,_>>()?;
    let recent = ids(
        db,
        "SELECT id FROM count_sessions ORDER BY created_at DESC,id DESC LIMIT 20",
    )?
    .into_iter()
    .map(|id| count_detail_json(db, id))
    .collect::<Result<Vec<_>, _>>()?;
    let mut waste = ids(
        db,
        "SELECT id FROM waste_records ORDER BY reported_at DESC,id DESC",
    )?
    .into_iter()
    .map(|id| waste_json(db, id))
    .collect::<Result<Vec<_>, _>>()?;
    let purchases = ids(
        db,
        "SELECT id FROM purchases ORDER BY created_at DESC,id DESC",
    )?
    .into_iter()
    .map(|id| purchase_json(db, id))
    .collect::<Result<Vec<_>, _>>()?;
    let overdue = |value: &Value, key: &str| -> bool {
        let stamp = value[key].as_str().unwrap_or("").replace('T', " ");
        chrono::NaiveDateTime::parse_from_str(&stamp, "%Y-%m-%d %H:%M:%S%.f")
            .ok()
            .zip(chrono::NaiveDateTime::parse_from_str(as_of, "%Y-%m-%d %H:%M:%S%.f").ok())
            .is_some_and(|(created, now)| now - created >= Duration::hours(72))
    };
    for row in &mut pending {
        row["overdue_72h"] = json!(overdue(row, "created_at"));
    }
    for row in &mut waste {
        row["overdue_72h"] = json!(row["status"] == "pending" && overdue(row, "reported_at"));
    }
    let consumption = consumption_data(
        db,
        &ConsumptionQuery {
            days: 56,
            lead_days: 2,
            coverage_days: 7,
        },
        as_of,
    )?;
    let summary = json!({
        "active_items":stock.len(),
        "low_stock":stock.iter().filter(|v| v["stock"].as_f64().unwrap_or(0.0)<v["min_stock"].as_f64().unwrap_or(0.0)).count(),
        "daily_shortages":shortages.len(), "daily_count_completed":daily_latest.is_some(), "expired_batches":expired.len(), "expiring_soon_batches":upcoming.len(),
        "pending_counts":pending.len(), "overdue_counts":pending.iter().filter(|v|v["overdue_72h"]==true).count(),
        "pending_waste":waste.iter().filter(|v|v["status"]=="pending").count(),
        "overdue_waste":waste.iter().filter(|v|v["overdue_72h"]==true).count(),
        "active_purchases":purchases.iter().filter(|v|v["status"]=="ordered").count()
    });
    Ok(
        json!({"as_of":as_of.replace(' ',"T")+"Z","business_date":date,"summary":summary,"stock":stock,"expiry":{"expired":expired,"upcoming":upcoming},"consumption":consumption,"counts":{"pending":pending,"recent":recent,"recent_limit":20,"daily_shortages":shortages,"daily_latest":daily_latest},"waste":waste,"purchases":purchases}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt;

    fn fixture() -> (tempfile::TempDir, AppState) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("owner.db");
        let db = crate::db::open(&path).unwrap();
        for (id, role) in [
            (1, "owner_readonly"),
            (2, "admin"),
            (3, "manager"),
            (4, "staff"),
            (5, "unknown"),
        ] {
            db.execute("INSERT INTO users(id,username,display_name,pin_hash,role,must_change_pin) VALUES(?1,?2,?2,?3,?4,0)", params![id,format!("user{id}"),crate::auth::hash_pin("1234"),role]).unwrap();
        }
        db.execute_batch("INSERT INTO items(id,name,unit,min_stock) VALUES(1,'Bread','bag',20);
          INSERT INTO batches(id,item_id,qty,initial_qty,expiry_date) VALUES(1,1,10,10,'2099-01-01');").unwrap();
        let state = AppState {
            db: Arc::new(Mutex::new(db)),
            db_path: Arc::new(path),
            secret: Arc::new(b"local-owner-test-secret".to_vec()),
            app_version: Arc::new("test".into()),
            backend_kind: Arc::new("android_native".into()),
        };
        (dir, state)
    }
    async fn request(
        s: &AppState,
        method: &str,
        path: &str,
        token: &str,
        body: Value,
    ) -> (StatusCode, Value) {
        let response = router(s.clone())
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .extension(ConnectInfo(
                        "127.0.0.1:12345".parse::<SocketAddr>().unwrap(),
                    ))
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let raw = to_bytes(response.into_body(), 8 * 1024 * 1024)
            .await
            .unwrap();
        (status, serde_json::from_slice(&raw).unwrap_or(Value::Null))
    }
    fn token(s: &AppState, id: i64) -> String {
        crate::auth::create_token(&s.secret, id, 0)
    }
    fn fingerprint(s: &AppState) -> String {
        let db = s.db.lock().unwrap();
        let mut values = Vec::new();
        let tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        for table in tables {
            let mut statement = db
                .prepare(&format!("SELECT * FROM \"{table}\" ORDER BY rowid"))
                .unwrap();
            let columns = statement.column_count();
            let rows = statement
                .query_map([], |r| {
                    Ok((0..columns)
                        .map(|i| format!("{:?}", r.get_ref(i).unwrap()))
                        .collect::<Vec<_>>())
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            values.push(format!("{table}:{rows:?}"));
        }
        values.join("\n")
    }
    #[tokio::test]
    async fn owner_business_writes_and_nonallowlisted_reads_are_denied_without_mutation() {
        let (_dir, s) = fixture();
        let token = token(&s, 1);
        let before = fingerprint(&s);
        let writes = [
            ("POST", "/api/items"),
            ("PATCH", "/api/items/1"),
            ("POST", "/api/users"),
            ("PATCH", "/api/users/2"),
            ("POST", "/api/stock/receive"),
            ("PATCH", "/api/stock/receipts/1"),
            ("POST", "/api/purchases"),
            ("POST", "/api/purchases/1/receive"),
            ("POST", "/api/purchases/1/cancel"),
            ("POST", "/api/waste"),
            ("POST", "/api/waste/1/confirm"),
            ("POST", "/api/waste/1/reject"),
            ("POST", "/api/counts"),
            ("PATCH", "/api/counts/1"),
            ("POST", "/api/counts/1/verify"),
            ("POST", "/api/counts/1/reject"),
            ("POST", "/api/count-comparisons/preview"),
            ("POST", "/api/count-comparisons"),
            ("GET", "/api/items"),
            ("GET", "/api/stock"),
            ("GET", "/api/consumption"),
            ("GET", "/api/users"),
            ("DELETE", "/api/future-write"),
            ("HEAD", "/api/owner/dashboard"),
        ];
        for (method, path) in writes {
            assert_eq!(
                request(&s, method, path, &token, json!({})).await.0,
                StatusCode::FORBIDDEN,
                "{method} {path}"
            );
        }
        assert_eq!(before, fingerprint(&s));
        assert_eq!(
            request(&s, "GET", "/api/auth/me", &token, json!({}))
                .await
                .0,
            StatusCode::OK
        );
        assert_eq!(
            request(&s, "GET", "/api/owner/dashboard", &token, json!({}))
                .await
                .0,
            StatusCode::OK
        );
        assert_eq!(before, fingerprint(&s));
    }
    #[tokio::test]
    async fn existing_roles_and_admin_owner_management_keep_permissions() {
        let (_dir, s) = fixture();
        for id in [1, 2, 3] {
            assert_eq!(
                request(&s, "GET", "/api/owner/dashboard", &token(&s, id), json!({}))
                    .await
                    .0,
                StatusCode::OK
            );
        }
        for id in [4, 5] {
            assert_eq!(
                request(&s, "GET", "/api/owner/dashboard", &token(&s, id), json!({}))
                    .await
                    .0,
                StatusCode::FORBIDDEN
            );
        }
        for id in [2, 3, 4] {
            assert_eq!(
                request(&s, "GET", "/api/stock", &token(&s, id), json!({}))
                    .await
                    .0,
                StatusCode::OK
            );
        }
        for id in [2, 3] {
            assert_eq!(
                request(&s, "GET", "/api/consumption", &token(&s, id), json!({}))
                    .await
                    .0,
                StatusCode::OK
            );
        }
        assert_eq!(
            request(&s, "GET", "/api/consumption", &token(&s, 4), json!({}))
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        let (status,user)=request(&s,"POST","/api/users",&token(&s,2),json!({"username":"newowner","display_name":"Owner","pin":"5678","role":"owner_readonly"})).await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(user["role"], "owner_readonly");
        assert_eq!(
            request(
                &s,
                "PATCH",
                "/api/users/4",
                &token(&s, 2),
                json!({"role":"owner_readonly"})
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(
            request(&s, "GET", "/api/auth/me", &token(&s, 4), json!({}))
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(role_level("owner_readonly"), -1);
    }
    #[tokio::test]
    async fn owner_first_pin_change_and_admin_revocation_are_enforced() {
        let (_dir, s) = fixture();
        let old = token(&s, 1);
        s.db.lock()
            .unwrap()
            .execute("UPDATE users SET must_change_pin=1 WHERE id=1", [])
            .unwrap();
        assert_eq!(
            request(&s, "GET", "/api/owner/dashboard", &old, json!({}))
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        let (status, changed) = request(
            &s,
            "POST",
            "/api/auth/change-pin",
            &old,
            json!({"current_pin":"1234","new_pin":"5678","user_id":2}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let fresh = changed["token"].as_str().unwrap();
        assert_eq!(
            request(&s, "GET", "/api/auth/me", &old, json!({})).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request(&s, "GET", "/api/owner/dashboard", fresh, json!({}))
                .await
                .0,
            StatusCode::OK
        );
        for path in ["/api/health", "/api/auth/login-options"] {
            assert_eq!(
                request(&s, "GET", path, &old, json!({})).await.0,
                StatusCode::OK
            );
        }
        assert_eq!(
            request(
                &s,
                "POST",
                "/api/auth/login",
                &old,
                json!({"username":"user1","pin":"5678"})
            )
            .await
            .0,
            StatusCode::OK
        );
        let admin_hash: String =
            s.db.lock()
                .unwrap()
                .query_row("SELECT pin_hash FROM users WHERE id=2", [], |r| r.get(0))
                .unwrap();
        assert!(crate::auth::verify_pin("1234", &admin_hash));
        assert_eq!(
            request(
                &s,
                "PATCH",
                "/api/users/1",
                &token(&s, 2),
                json!({"active":false})
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(
            request(&s, "GET", "/api/owner/dashboard", fresh, json!({}))
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
    }
    #[test]
    fn snapshot_has_deduplicated_shortages_separate_expiry_and_all_pending_backlog() {
        let (_dir, s) = fixture();
        let db = s.db.lock().unwrap();
        db.execute_batch("INSERT INTO batches(item_id,qty,initial_qty,expiry_date) VALUES(1,10,10,'2026-11-01'),(1,10,10,'2026-11-02'),(1,10,10,'2026-11-05'),(1,10,10,'2026-11-06');
          INSERT INTO count_sessions(id,created_by,created_at,status,count_type,business_date) VALUES(1,4,'2026-11-02 01:00:00','completed','daily','2026-11-02'),(2,4,'2026-10-01 01:00:00','submitted','weekly',NULL),(3,4,'2026-11-02 01:00:00','submitted','weekly',NULL);
          INSERT INTO count_entries(session_id,item_id,expected_qty,qty_counted,is_enough) VALUES(1,1,10,10,0),(1,1,10,10,0);
          INSERT INTO waste_records(item_id,qty,reason,status,reported_by,reported_at) VALUES(1,10,'expired','pending',4,'2026-10-01 01:00:00');").unwrap();
        let empty_day = snapshot(
            &db,
            "2026-11-03 04:00:00",
            NaiveDate::from_ymd_opt(2026, 11, 3).unwrap(),
        )
        .unwrap();
        assert_eq!(empty_day["summary"]["daily_count_completed"], false);
        assert!(empty_day["counts"]["daily_latest"].is_null());
        let result = snapshot(
            &db,
            "2026-11-02 04:00:00",
            NaiveDate::from_ymd_opt(2026, 11, 2).unwrap(),
        )
        .unwrap();
        assert_eq!(result["summary"]["daily_shortages"], 1);
        assert_eq!(result["summary"]["daily_count_completed"], true);
        assert_eq!(result["counts"]["daily_latest"]["id"], 1);
        assert_eq!(result["summary"]["expired_batches"], 1);
        assert_eq!(result["summary"]["expiring_soon_batches"], 2);
        assert_eq!(result["summary"]["pending_counts"], 2);
        assert_eq!(result["summary"]["overdue_counts"], 1);
        assert_eq!(result["summary"]["overdue_waste"], 1);
        assert_eq!(result["counts"]["pending"].as_array().unwrap().len(), 2);
        assert_eq!(result["counts"]["recent"][0]["id"], 3);
        assert_eq!(result["consumption"]["items"][0]["daily_shortage"], true);
    }
}
