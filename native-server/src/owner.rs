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
    let store_id: String = db.query_row("SELECT store_id FROM store_meta WHERE id=1", [], |r| {
        r.get(0)
    })?;
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
    // Daily observations are replenishment references only. Select the latest
    // completed response per material independently of the bounded session list.
    let mut statement = db.prepare("SELECT item_id,session_id,business_date,created_at,is_enough,reported_qty FROM (SELECT e.item_id,c.id AS session_id,c.business_date,c.created_at,e.is_enough,e.reported_qty,row_number() OVER (PARTITION BY e.item_id ORDER BY julianday(c.created_at) DESC,c.id DESC,e.id DESC) AS position FROM count_entries e JOIN count_sessions c ON c.id=e.session_id JOIN items i ON i.id=e.item_id WHERE i.active=1 AND c.count_type='daily' AND c.status='completed' AND e.is_enough IN (0,1)) WHERE position=1 ORDER BY item_id")?;
    let daily_latest_by_item = statement.query_map([], |r| Ok(json!({"item_id":r.get::<_,i64>(0)?,"session_id":r.get::<_,i64>(1)?,"business_date":r.get::<_,Option<String>>(2)?,"created_at":r.get::<_,String>(3)?,"is_enough":r.get::<_,bool>(4)?,"reported_qty":r.get::<_,Option<Quantity>>(5)?})))?.collect::<Result<Vec<_>,_>>()?;
    // submitted weekly observations are useful, but their existing status must
    // remain visible so clients do not present them as confirmed results.
    let latest_id = db.query_row("SELECT id FROM count_sessions WHERE (count_type='daily' AND status='completed') OR (count_type='weekly' AND status IN ('submitted','verified')) ORDER BY julianday(created_at) DESC,id DESC LIMIT 1", [], |r| r.get::<_,i64>(0)).optional()?;
    let latest = latest_id.map(|id| count_detail_json(db, id)).transpose()?;
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
        json!({"store_id":store_id,"as_of":as_of.replace(' ',"T")+"Z","business_date":date,"summary":summary,"stock":stock,"expiry":{"expired":expired,"upcoming":upcoming},"consumption":consumption,"counts":{"pending":pending,"recent":recent,"recent_limit":20,"daily_shortages":shortages,"daily_latest":daily_latest,"daily_latest_by_item":daily_latest_by_item,"latest":latest},"waste":waste,"purchases":purchases}),
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
    #[test]
    fn daily_reference_is_per_material_and_does_not_change_count_or_consumption() {
        fn material(data: &Value) -> &Value {
            data["consumption"]["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["item_id"] == 1)
                .unwrap()
        }
        let (_dir, s) = fixture();
        let today = NaiveDate::from_ymd_opt(2026, 9, 8).unwrap();
        let as_of = "2026-09-08 04:00:00";
        {
            let db = s.db.lock().unwrap();
            db.execute_batch("INSERT INTO items(id,name,unit) VALUES(2,'Milk','box'),(3,'No response','bag');
              INSERT INTO count_sessions(id,created_by,created_at,status,count_type) VALUES
                (1,4,'2026-08-30 03:55:00','verified','weekly'),(2,3,'2026-08-30 04:00:00','verified','weekly'),
                (3,4,'2026-09-06 03:55:00','verified','weekly'),(4,3,'2026-09-06 04:00:00','verified','weekly');
              INSERT INTO count_comparisons(id,first_session_id,second_session_id,resolution,confirmed_by,confirmed_at) VALUES
                (1,1,2,'no_difference',2,'2026-08-30 04:02:00'),(2,3,4,'no_difference',2,'2026-09-06 04:02:00');
              INSERT INTO count_comparison_entries(comparison_id,item_id,first_qty,second_qty,final_qty,result) VALUES
                (1,1,1000,1000,1000,'same'),(2,1,450,450,450,'same');").unwrap();
        }
        let baseline = snapshot(&s.db.lock().unwrap(), as_of, today).unwrap();
        assert!(
            baseline["counts"]["daily_latest_by_item"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            material(&baseline)["periods"][0]["closing_qty"].as_f64(),
            Some(45.0)
        );
        {
            let db = s.db.lock().unwrap();
            db.execute_batch("INSERT INTO count_sessions(id,created_by,created_at,status,count_type,business_date) VALUES
                (10,4,'2026-09-07 02:00:00','completed','daily','2026-09-07'),
                (11,4,'2026-09-08T02:00:00Z','completed','daily','2026-09-08'),
                (12,4,'2026-09-08 03:00:00','completed','daily',NULL),
                (13,4,'2026-09-09 03:00:00','superseded','daily',NULL),
                (14,4,'2026-09-09 04:00:00','rejected','daily',NULL),
                (15,4,'2026-09-08 03:30:00','completed','daily',NULL);
              INSERT INTO count_entries(session_id,item_id,qty_counted,expected_qty,is_enough,reported_qty) VALUES
                (10,1,9900,9900,1,NULL),(10,2,0,0,0,0),
                (11,1,9900,9900,1,NULL),(12,1,0,0,0,0),
                (13,1,9900,9900,1,9900),(14,2,9900,9900,1,9900),(15,3,9900,9900,NULL,9900);").unwrap();
            for id in 20..45 {
                db.execute("INSERT INTO count_sessions(id,created_by,created_at,status,count_type) VALUES(?1,4,'2026-09-10 04:00:00','rejected','weekly')", [id]).unwrap();
            }
        }
        let before = fingerprint(&s);
        let result = snapshot(&s.db.lock().unwrap(), as_of, today).unwrap();
        let references = result["counts"]["daily_latest_by_item"].as_array().unwrap();
        assert_eq!(references.len(), 2);
        assert_eq!(references[0]["session_id"], 12);
        assert_eq!(references[0]["is_enough"], false);
        assert_eq!(references[0]["reported_qty"], 0);
        assert_eq!(references[1]["item_id"], 2);
        assert_eq!(references[1]["business_date"], "2026-09-07");
        assert_eq!(references[1]["reported_qty"], 0);
        assert_eq!(result["counts"]["recent"].as_array().unwrap().len(), 20);
        assert_eq!(before, fingerprint(&s));
        for key in [
            "periods",
            "last_count_qty",
            "last_count_at",
            "consumption",
            "daily_rate",
            "estimated_qty",
            "book_stock",
            "replenishment_gap",
        ] {
            assert_eq!(
                material(&baseline)[key],
                material(&result)[key],
                "Daily feedback must not change {key}"
            );
        }
        assert_eq!(baseline["stock"][0]["stock"], result["stock"][0]["stock"]);
        {
            let db = s.db.lock().unwrap();
            db.execute(
                "UPDATE count_entries SET reported_qty=NULL,is_enough=1 WHERE session_id=12",
                [],
            )
            .unwrap();
        }
        let changed = snapshot(&s.db.lock().unwrap(), as_of, today).unwrap();
        assert!(changed["counts"]["daily_latest_by_item"][0]["reported_qty"].is_null());
        assert_eq!(
            changed["counts"]["daily_latest_by_item"][0]["is_enough"],
            true
        );
        for key in [
            "periods",
            "last_count_qty",
            "last_count_at",
            "consumption",
            "daily_rate",
            "estimated_qty",
            "book_stock",
            "replenishment_gap",
        ] {
            assert_eq!(
                material(&result)[key],
                material(&changed)[key],
                "Changing daily feedback must not change {key}"
            );
        }
    }
    #[test]
    fn latest_count_orders_mixed_timestamp_formats_by_time() {
        let (_dir, s) = fixture();
        let db = s.db.lock().unwrap();
        db.execute_batch(
            "INSERT INTO count_sessions(id,created_by,created_at,status,count_type) VALUES
          (1,4,'2020-01-02T01:00:00Z','submitted','weekly'),
          (2,4,'2020-01-02 02:00:00','submitted','weekly');",
        )
        .unwrap();
        let result = snapshot(
            &db,
            "2020-01-03 00:00:00",
            NaiveDate::from_ymd_opt(2020, 1, 3).unwrap(),
        )
        .unwrap();
        assert_eq!(result["counts"]["latest"]["id"], 2);
    }
    #[tokio::test]
    async fn latest_count_is_cross_day_valid_complete_and_read_only() {
        let (_dir, s) = fixture();
        let auth = token(&s, 1);
        let before = fingerprint(&s);
        let (status, empty) = request(&s, "GET", "/api/owner/dashboard", &auth, json!({})).await;
        assert_eq!(status, StatusCode::OK);
        assert!(empty["counts"]["latest"].is_null());
        let store_id: String =
            s.db.lock()
                .unwrap()
                .query_row("SELECT store_id FROM store_meta WHERE id=1", [], |r| {
                    r.get(0)
                })
                .unwrap();
        assert_eq!(empty["store_id"], store_id);
        assert_eq!(before, fingerprint(&s));

        {
            let db = s.db.lock().unwrap();
            db.execute_batch("INSERT INTO count_sessions(id,created_by,created_at,status,count_type,business_date) VALUES
              (1,4,'2020-01-01 01:00:00','completed','daily','2020-01-01'),
              (2,4,'2020-01-02 01:00:00','verified','weekly',NULL),
              (3,4,'2020-01-02 01:00:00','submitted','weekly',NULL),
              (4,4,'2020-01-03 01:00:00','rejected','weekly',NULL),
              (5,4,'2020-01-04 01:00:00','superseded','daily',NULL),
              (6,4,'2019-01-01 01:00:00','completed','daily','2019-01-01');
              INSERT INTO count_entries(session_id,item_id,expected_qty,qty_counted,reviewed_qty,reported_qty,is_enough) VALUES(3,1,10,7,NULL,7,0);").unwrap();
            // More than the recent-list limit must not hide the latest valid result.
            for id in 10..35 {
                db.execute("INSERT INTO count_sessions(id,created_by,created_at,status,count_type) VALUES(?1,4,'2020-01-05 01:00:00','rejected','weekly')", [id]).unwrap();
            }
        }
        let before = fingerprint(&s);
        let (status, result) = request(&s, "GET", "/api/owner/dashboard", &auth, json!({})).await;
        assert_eq!(status, StatusCode::OK);
        assert!(result["counts"]["daily_latest"].is_null());
        let latest = &result["counts"]["latest"];
        assert_eq!(latest["id"], 3);
        assert_eq!(latest["status"], "submitted");
        assert_eq!(latest["count_type"], "weekly");
        assert_eq!(latest["entries"][0]["qty_counted"], 0.7);
        assert!(latest["entries"][0]["reviewed_qty"].is_null());
        assert_eq!(latest["entries"][0]["reported_qty"], 0.7);
        assert_eq!(result["counts"]["recent"].as_array().unwrap().len(), 20);
        assert_eq!(before, fingerprint(&s));

        {
            let db = s.db.lock().unwrap();
            db.execute("UPDATE count_sessions SET status='rejected' WHERE id=3", [])
                .unwrap();
            db.execute("INSERT INTO count_entries(session_id,item_id,expected_qty,qty_counted,reviewed_qty) VALUES(2,1,10,8,9)", []).unwrap();
        }
        let before = fingerprint(&s);
        let (_, verified) = request(&s, "GET", "/api/owner/dashboard", &auth, json!({})).await;
        assert_eq!(verified["counts"]["latest"]["id"], 2);
        assert_eq!(verified["counts"]["latest"]["status"], "verified");
        assert_eq!(
            verified["counts"]["latest"]["entries"][0]["reviewed_qty"],
            0.9
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
                json!({"role":"manager"})
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
    async fn owner_pin_and_role_admin_bypasses_are_denied_without_mutation() {
        let (_dir, s) = fixture();
        for body in [
            json!({"pin":"5678"}),
            json!({"role":"staff"}),
            json!({"role":"staff","pin":"5678"}),
            json!({"role":"owner_readonly","pin":"5678"}),
        ] {
            let before = fingerprint(&s);
            for actor in [1, 2, 3, 4] {
                assert_eq!(
                    request(&s, "PATCH", "/api/users/1", &token(&s, actor), body.clone())
                        .await
                        .0,
                    StatusCode::FORBIDDEN
                );
                assert_eq!(before, fingerprint(&s));
            }
        }
        for body in [
            json!({"role":"owner_readonly"}),
            json!({"role":"owner_readonly","pin":"5678"}),
        ] {
            let before = fingerprint(&s);
            assert_eq!(
                request(&s, "PATCH", "/api/users/4", &token(&s, 2), body)
                    .await
                    .0,
                StatusCode::FORBIDDEN
            );
            assert_eq!(before, fingerprint(&s));
        }
        // Ordinary user resets and role updates retain their existing behavior.
        assert_eq!(
            request(
                &s,
                "PATCH",
                "/api/users/4",
                &token(&s, 2),
                json!({"role":"manager","pin":"5678"})
            )
            .await
            .0,
            StatusCode::OK
        );
        let db = s.db.lock().unwrap();
        let (hash, role, must_change): (String, String, bool) = db
            .query_row(
                "SELECT pin_hash,role,must_change_pin FROM users WHERE id=4",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert!(crate::auth::verify_pin("5678", &hash));
        assert_eq!(role, "manager");
        assert!(must_change);
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
        let before = fingerprint(&s);
        assert_eq!(
            request(
                &s,
                "POST",
                "/api/auth/change-pin",
                &old,
                json!({"current_pin":"9999","new_pin":"5678"})
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(before, fingerprint(&s));
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
