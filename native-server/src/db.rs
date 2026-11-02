use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;
use uuid::Uuid;

pub const DB_SCHEMA: &str = "20260908_10";

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| rusqlite::Error::InvalidPath(parent.into()))?;
    }
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
    )?;
    migrate(&conn)?;
    Ok(conn)
}

fn has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for name in names {
        if name? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

// Narrowly widen the CHECK installed by the original SQLite bootstrap. Keep the
// schema version: no column/API contract changes, and older binaries must still
// be able to open the database (unknown roles already fail closed there).
fn migrate_legacy_user_roles(conn: &Connection) -> rusqlite::Result<()> {
    let sql: String = conn.query_row(
        "SELECT sql FROM sqlite_schema WHERE type='table' AND name='users'",
        [],
        |r| r.get(0),
    )?;
    // Match only this complete CHECK, ignoring SQL whitespace and keyword case.
    // Keep byte offsets to edit the original DDL without losing other checks,
    // defaults, foreign keys, or AUTOINCREMENT. Quoted string contents stay exact.
    let mut normalized = String::new();
    let mut offsets = Vec::new();
    let mut quoted = false;
    for (offset, ch) in sql.char_indices() {
        if ch == '\'' {
            quoted = !quoted;
        }
        if quoted || !ch.is_ascii_whitespace() {
            normalized.push(if quoted { ch } else { ch.to_ascii_lowercase() });
            offsets.extend(std::iter::repeat_n(offset, ch.len_utf8()));
        }
    }
    let old_check = "check(rolein('staff','manager','admin'))";
    let Some(start) = normalized.find(old_check) else {
        return Ok(());
    };
    let end = offsets[start + old_check.len() - 1] + 1;
    let mut widened = sql.clone();
    widened.replace_range(
        offsets[start]..end,
        "CHECK (role IN ('staff', 'manager', 'admin', 'owner_readonly'))",
    );
    let definition = &widened[widened.find('(').ok_or(rusqlite::Error::InvalidQuery)?..];
    // SQLite's documented table-rebuild procedure requires FK enforcement off
    // before BEGIN; never silently disable checks inside a caller's transaction.
    if !conn.is_autocommit() {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let foreign_keys: bool = conn.pragma_query_value(None, "foreign_keys", |r| r.get(0))?;
    let legacy_alter_table: bool =
        conn.pragma_query_value(None, "legacy_alter_table", |r| r.get(0))?;
    conn.pragma_update(None, "foreign_keys", false)?;
    let result = (|| -> rusqlite::Result<()> {
        // Views and triggers on other tables may refer to users. While the old
        // table is dropped, disable ALTER's schema rewrite/validation; those
        // references retain their original target name throughout the rebuild.
        conn.pragma_update(None, "legacy_alter_table", true)?;
        let tx = conn.unchecked_transaction()?;
        let objects = {
            let mut stmt = tx.prepare(
                "SELECT sql FROM sqlite_schema WHERE tbl_name='users' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name",
            )?;
            stmt.query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        let columns = {
            let mut stmt = tx.prepare("PRAGMA table_info(users)")?;
            stmt.query_map([], |r| r.get::<_, String>(1))?
                .collect::<rusqlite::Result<Vec<_>>>()?
                .into_iter()
                .map(|name| format!("\"{}\"", name.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(",")
        };
        let autoincrement = sql.to_ascii_lowercase().contains("autoincrement");
        let sequence = if autoincrement {
            tx.query_row(
                "SELECT seq FROM sqlite_sequence WHERE name='users'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
        } else {
            None
        };
        tx.execute_batch(&format!(
            "CREATE TABLE __users_owner_role_migration {definition};\
             INSERT INTO __users_owner_role_migration ({columns}) SELECT {columns} FROM users;\
             DROP TABLE users;\
             ALTER TABLE __users_owner_role_migration RENAME TO users;"
        ))?;
        for object in objects {
            tx.execute_batch(&object)?;
        }
        if autoincrement {
            tx.execute("DELETE FROM sqlite_sequence WHERE name='users'", [])?;
            if let Some(sequence) = sequence {
                tx.execute(
                    "INSERT INTO sqlite_sequence(name,seq) VALUES('users',?1)",
                    [sequence],
                )?;
            }
        }
        // A failed check rolls the complete rebuild back, including indexes,
        // triggers and sqlite_sequence. Existing references never get renamed.
        if tx.prepare("PRAGMA foreign_key_check")?.exists([])? {
            return Err(rusqlite::Error::InvalidQuery);
        }
        tx.commit()
    })();
    // Restore the caller's enforcement setting on both success and failure.
    let restored_alter = conn.pragma_update(None, "legacy_alter_table", legacy_alter_table);
    let restored_fk = conn.pragma_update(None, "foreign_keys", foreign_keys);
    result.and(restored_alter).and(restored_fk)
}

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let existing_version: Option<String> = conn
        .query_row("SELECT version_num FROM alembic_version LIMIT 1", [], |r| {
            r.get(0)
        })
        .optional()
        .or_else(|err| match err {
            rusqlite::Error::SqliteFailure(_, Some(ref message))
                if message.contains("no such table") =>
            {
                Ok(None)
            }
            other => Err(other),
        })?;
    if existing_version.as_deref().is_some_and(|v| {
        v != "20260901_01"
            && v != "20260901_02"
            && v != "20260901_03"
            && v != "20260901_04"
            && v != "20260904_05"
            && v != "20260904_06"
            && v != "20260904_07"
            && v != "20260904_08"
            && v != "20260908_09"
            && v != DB_SCHEMA
    }) {
        return Err(rusqlite::Error::InvalidQuery); // 不得静默降级未知的新 schema
    }
    conn.execute_batch(include_str!("../migrations/20260901_02.sql"))?;
    // 兼容早期由 create_all 建立、缺少安全字段的数据库。
    if !has_column(conn, "users", "must_change_pin")? {
        conn.execute_batch(
            "ALTER TABLE users ADD COLUMN must_change_pin BOOLEAN NOT NULL DEFAULT 1",
        )?;
    }
    if !has_column(conn, "users", "token_version")? {
        conn.execute_batch(
            "ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0",
        )?;
    }
    migrate_legacy_user_roles(conn)?;
    if !has_column(conn, "purchases", "handled_by")? {
        conn.execute_batch("ALTER TABLE purchases ADD COLUMN handled_by INTEGER")?;
    }
    if !has_column(conn, "purchases", "handled_at")? {
        conn.execute_batch("ALTER TABLE purchases ADD COLUMN handled_at DATETIME")?;
    }
    if !has_column(conn, "count_sessions", "count_type")? {
        conn.execute_batch(
            "ALTER TABLE count_sessions ADD COLUMN count_type VARCHAR(16) NOT NULL DEFAULT 'weekly'",
        )?;
    }
    if !has_column(conn, "count_entries", "is_enough")? {
        conn.execute_batch("ALTER TABLE count_entries ADD COLUMN is_enough BOOLEAN")?;
    }
    if !has_column(conn, "count_sessions", "business_date")? {
        conn.execute_batch(
            "ALTER TABLE count_sessions ADD COLUMN business_date VARCHAR(10);
             UPDATE count_sessions SET status='superseded',business_date=NULL
             WHERE count_type='daily' AND id NOT IN (
               SELECT max(id) FROM count_sessions WHERE count_type='daily'
               GROUP BY date(created_at,'+8 hours')
             );
             UPDATE count_sessions SET business_date=date(created_at,'+8 hours')
             WHERE count_type='daily' AND status<>'superseded';",
        )?;
    }
    if !has_column(conn, "count_sessions", "review_reason")? {
        conn.execute_batch("ALTER TABLE count_sessions ADD COLUMN review_reason VARCHAR(32)")?;
    }
    if !has_column(conn, "count_sessions", "review_note")? {
        conn.execute_batch("ALTER TABLE count_sessions ADD COLUMN review_note VARCHAR(255)")?;
    }
    if !has_column(conn, "count_entries", "reviewed_qty")? {
        conn.execute_batch("ALTER TABLE count_entries ADD COLUMN reviewed_qty INTEGER")?;
    }
    if !has_column(conn, "count_entries", "reported_qty")? {
        conn.execute_batch("ALTER TABLE count_entries ADD COLUMN reported_qty INTEGER")?;
    }
    if !has_column(conn, "items", "daily_count_enabled")? {
        conn.execute_batch(
            "ALTER TABLE items ADD COLUMN daily_count_enabled BOOLEAN NOT NULL DEFAULT 1",
        )?;
    }
    if !has_column(conn, "items", "weekly_count_enabled")? {
        conn.execute_batch(
            "ALTER TABLE items ADD COLUMN weekly_count_enabled BOOLEAN NOT NULL DEFAULT 1",
        )?;
    }
    if !has_column(conn, "waste_records", "description")? {
        conn.execute_batch("ALTER TABLE waste_records ADD COLUMN description VARCHAR(500)")?;
    }
    if !has_column(conn, "waste_records", "photo_mime")? {
        conn.execute_batch("ALTER TABLE waste_records ADD COLUMN photo_mime VARCHAR(32)")?;
    }
    if !has_column(conn, "waste_records", "photo_base64")? {
        conn.execute_batch("ALTER TABLE waste_records ADD COLUMN photo_base64 TEXT")?;
    }
    conn.execute_batch(include_str!("../migrations/20260904_08.sql"))?;
    if !has_column(conn, "count_sessions", "comparison_id")? {
        conn.execute_batch(
            "ALTER TABLE count_sessions ADD COLUMN comparison_id INTEGER REFERENCES count_comparisons(id);
             CREATE INDEX IF NOT EXISTS ix_count_sessions_comparison_id ON count_sessions(comparison_id);",
        )?;
    }
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_count_sessions_daily_date
         ON count_sessions(business_date)
         WHERE count_type='daily' AND business_date IS NOT NULL;",
    )?;
    // The scale conversion and version stamp must commit together. A database
    // created by the current Python test/bootstrap metadata may already be scaled.
    let recorded_schema: Option<String> = conn
        .query_row(
            "SELECT schema_version FROM store_meta WHERE id=1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    conn.execute_batch("SAVEPOINT quantity_migration")?;
    if !matches!(
        existing_version.as_deref(),
        Some("20260908_09" | "20260908_10")
    ) && !matches!(
        recorded_schema.as_deref(),
        Some("20260908_09" | "20260908_10")
    ) {
        if let Err(err) = conn.execute_batch(include_str!("../migrations/20260908_09.sql")) {
            conn.execute_batch("ROLLBACK TO quantity_migration; RELEASE quantity_migration")?;
            return Err(err);
        }
    }
    conn.execute_batch(include_str!("../migrations/20260908_10.sql"))?;
    let store_id: Option<String> = conn
        .query_row("SELECT store_id FROM store_meta WHERE id=1", [], |row| {
            row.get(0)
        })
        .optional()?;
    if store_id.is_none() {
        conn.execute(
            "INSERT INTO store_meta(id,store_id,schema_version,created_at) VALUES(1,?1,?2,CURRENT_TIMESTAMP)",
            params![Uuid::new_v4().to_string(), DB_SCHEMA],
        )?;
    } else {
        conn.execute(
            "UPDATE store_meta SET schema_version=?1 WHERE id=1",
            [DB_SCHEMA],
        )?;
    }
    let has_version: i64 =
        conn.query_row("SELECT count(*) FROM alembic_version", [], |r| r.get(0))?;
    if has_version == 0 {
        conn.execute(
            "INSERT INTO alembic_version(version_num) VALUES(?1)",
            [DB_SCHEMA],
        )?;
    } else {
        conn.execute("UPDATE alembic_version SET version_num=?1", [DB_SCHEMA])?;
    }
    conn.execute_batch("RELEASE quantity_migration")?;
    Ok(())
}

pub fn bootstrap_admin(conn: &Connection, pin: Option<&str>) -> anyhow::Result<()> {
    let count: i64 = conn.query_row("SELECT count(*) FROM users", [], |r| r.get(0))?;
    if count == 0 {
        let pin = pin.ok_or_else(|| {
            anyhow::anyhow!("空库必须通过 --bootstrap-pin-file 提供临时管理员 PIN")
        })?;
        if !(4..=6).contains(&pin.len()) || !pin.bytes().all(|b| b.is_ascii_digit()) {
            anyhow::bail!("临时管理员 PIN 必须为 4-6 位数字");
        }
        conn.execute(
            "INSERT INTO users(username,display_name,pin_hash,role,active,must_change_pin,token_version,created_at) VALUES('admin','管理员',?1,'admin',1,1,0,CURRENT_TIMESTAMP)",
            [crate::auth::hash_pin(pin)],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // The deployed bootstrap differs from the native fresh schema: AUTOINCREMENT,
    // three CHECKs, strftime default, and both historical username indexes.
    const LEGACY_USERS: &str = "
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
          pin_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('staff', 'manager', 'admin')),
          active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
          must_change_pin INTEGER NOT NULL DEFAULT 1 CHECK (must_change_pin IN (0, 1)),
          token_version INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        CREATE INDEX idx_users_username ON users(username);
        CREATE INDEX ix_users_username ON users(username);
    ";

    #[test]
    fn deployed_users_check_upgrade_preserves_data_constraints_and_dependents() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(LEGACY_USERS).unwrap();
        migrate(&conn).unwrap();
        // Reproduce the existing deployed schema at the current schema version.
        // migrate already widened it; reconstruct the fixture before populating.
        conn.execute_batch("DROP TABLE users").unwrap();
        conn.execute_batch(LEGACY_USERS).unwrap();
        conn.execute_batch("
            CREATE TABLE user_audit(user_id INTEGER REFERENCES users(id), action TEXT);
            CREATE TRIGGER audit_user AFTER INSERT ON users BEGIN
              INSERT INTO user_audit VALUES(new.id, 'created'); END;
            CREATE VIEW user_names AS SELECT id,username FROM users;
            CREATE TABLE external_events(user_id INTEGER REFERENCES users(id));
            CREATE TRIGGER audit_event AFTER INSERT ON external_events BEGIN
              INSERT INTO user_audit SELECT id,'event' FROM users WHERE id=new.user_id; END;
            INSERT INTO users(id,username,display_name,pin_hash,role,active,must_change_pin,token_version,created_at)
              VALUES(7,'legacy-admin','Original name','original-hash','admin',0,0,42,'2026-01-02T03:04:05.678Z');
            INSERT INTO users(id,username,display_name,pin_hash) VALUES(100,'deleted','Deleted','x');
            DELETE FROM user_audit WHERE user_id=100;
            DELETE FROM users WHERE id=100;
            INSERT INTO purchases(id,created_by) VALUES(4,7);
        ").unwrap();
        let before: String = conn.query_row("SELECT json_array(id,username,display_name,pin_hash,role,active,must_change_pin,token_version,created_at) FROM users WHERE id=7", [], |r| r.get(0)).unwrap();
        let schema_objects = |conn: &Connection| {
            conn.prepare("SELECT type,name,sql FROM sqlite_schema WHERE type IN ('index','trigger','view') ORDER BY type,name").unwrap()
                .query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?))).unwrap()
                .collect::<rusqlite::Result<Vec<_>>>().unwrap()
        };
        let objects_before = schema_objects(&conn);
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        let after: String = conn.query_row("SELECT json_array(id,username,display_name,pin_hash,role,active,must_change_pin,token_version,created_at) FROM users WHERE id=7", [], |r| r.get(0)).unwrap();
        assert_eq!(before, after);
        assert_eq!(objects_before, schema_objects(&conn));
        assert_eq!(
            conn.query_row("SELECT created_by FROM purchases WHERE id=4", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            7
        );
        assert!(
            !conn
                .prepare("PRAGMA foreign_key_check")
                .unwrap()
                .exists([])
                .unwrap()
        );
        assert!(
            conn.pragma_query_value(None, "foreign_keys", |r| r.get::<_, bool>(0))
                .unwrap()
        );
        assert!(
            !conn
                .pragma_query_value(None, "legacy_alter_table", |r| r.get::<_, bool>(0))
                .unwrap()
        );
        conn.execute("INSERT INTO users(username,display_name,pin_hash,role) VALUES('owner','Owner','hash','owner_readonly')", []).unwrap();
        let owner_id = conn.last_insert_rowid();
        assert_eq!(owner_id, 101); // deleted IDs must not be reused
        conn.execute("INSERT INTO external_events VALUES(?1)", [owner_id])
            .unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM user_audit WHERE user_id=?1",
                [owner_id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM user_names", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        for sql in [
            "UPDATE users SET role='superadmin' WHERE id=7",
            "UPDATE users SET active=2 WHERE id=7",
            "UPDATE users SET must_change_pin=2 WHERE id=7",
            "UPDATE users SET username='owner' WHERE id=7",
            "DELETE FROM users WHERE id=7",
        ] {
            assert!(conn.execute(sql, []).is_err(), "constraint lost: {sql}");
        }
        assert_eq!(
            conn.query_row("SELECT version_num FROM alembic_version", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            DB_SCHEMA
        );
        assert_eq!(
            conn.query_row("SELECT schema_version FROM store_meta", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            DB_SCHEMA
        );
    }

    #[test]
    fn empty_user_sequence_and_caller_pragmas_are_preserved() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(LEGACY_USERS).unwrap();
        conn.execute_batch("PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON;
            ALTER TABLE users ADD COLUMN supervisor_id INTEGER REFERENCES users(id);
            ALTER TABLE users ADD COLUMN label TEXT GENERATED ALWAYS AS (username || ':' || role) VIRTUAL;").unwrap();
        migrate_legacy_user_roles(&conn).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM sqlite_sequence WHERE name='users'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert!(
            !conn
                .pragma_query_value(None, "foreign_keys", |r| r.get::<_, bool>(0))
                .unwrap()
        );
        assert!(
            conn.pragma_query_value(None, "legacy_alter_table", |r| r.get::<_, bool>(0))
                .unwrap()
        );
        conn.execute_batch("PRAGMA foreign_keys=ON;
            INSERT INTO users(id,username,display_name,pin_hash,role,supervisor_id) VALUES(1,'owner','Owner','x','owner_readonly',1);").unwrap();
        assert_eq!(
            conn.query_row("SELECT label FROM users", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "owner:owner_readonly"
        );
        assert_eq!(
            conn.query_row(
                "SELECT \"table\" FROM pragma_foreign_key_list('users')",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "users"
        );
        assert!(
            conn.execute("UPDATE users SET supervisor_id=999", [])
                .is_err()
        );
    }

    #[test]
    fn failed_user_role_rebuild_is_atomic_and_restores_pragmas() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(LEGACY_USERS).unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
            CREATE TABLE child(user_id INTEGER REFERENCES users(id));
            INSERT INTO users(username,display_name,pin_hash) VALUES('staff','Staff','hash');
            CREATE TRIGGER audit_user AFTER UPDATE ON users BEGIN SELECT 1; END;
            PRAGMA foreign_keys=OFF;
            INSERT INTO child VALUES(999);
            PRAGMA foreign_keys=ON;",
        )
        .unwrap();
        let ddl: String = conn
            .query_row(
                "SELECT sql FROM sqlite_schema WHERE name='users'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        // Integrity failure happens after DROP/RENAME/recreate, forcing rollback.
        assert!(migrate_legacy_user_roles(&conn).is_err());
        assert_eq!(
            conn.query_row(
                "SELECT sql FROM sqlite_schema WHERE name='users'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            ddl
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM users", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(conn.query_row("SELECT count(*) FROM sqlite_schema WHERE tbl_name='users' AND type IN ('index','trigger')", [], |r|r.get::<_,i64>(0)).unwrap(),4);
        assert!(
            conn.pragma_query_value(None, "foreign_keys", |r| r.get::<_, bool>(0))
                .unwrap()
        );
        assert!(
            !conn
                .pragma_query_value(None, "legacy_alter_table", |r| r.get::<_, bool>(0))
                .unwrap()
        );
        assert!(conn.is_autocommit());
        assert!(
            conn.execute("UPDATE users SET role='owner_readonly'", [])
                .is_err()
        );
        assert_eq!(
            conn.query_row(
                "SELECT seq FROM sqlite_sequence WHERE name='users'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }

    #[test]
    fn upgrading_tenths_does_not_scale_quantities_again() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn.execute_batch("UPDATE alembic_version SET version_num='20260908_09'; UPDATE store_meta SET schema_version='20260908_09'; INSERT INTO items(id,name,min_stock) VALUES(1,'Tenths',3);").unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        assert_eq!(
            conn.query_row("SELECT min_stock FROM items", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            3
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM stock_receipt_corrections", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap(),
            0
        );
    }

    #[test]
    fn legacy_quantities_scale_once() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn.execute_batch("
            UPDATE alembic_version SET version_num='20260904_08';
            UPDATE store_meta SET schema_version='20260904_08';
            INSERT INTO users(id,username,display_name,pin_hash,role) VALUES(1,'legacy','Legacy','x','manager');
            INSERT INTO purchases(id,created_by) VALUES(1,1);
            INSERT INTO count_sessions(id,created_by) VALUES(1,1),(2,1);
            INSERT INTO count_comparisons(id,first_session_id,second_session_id,resolution,confirmed_by) VALUES(1,1,2,'no_difference',1);
            INSERT INTO items(id,name,min_stock) VALUES(1,'Legacy',5);
            INSERT INTO batches(id,item_id,qty,initial_qty,expiry_date) VALUES(1,1,5,8,'2099-01-01');
            INSERT INTO stock_movements(item_id,batch_id,delta,operation,reference_type,actor_id) VALUES(1,1,-3,'waste','waste',1);
            INSERT INTO count_entries(session_id,item_id,qty_counted,expected_qty,reported_qty,reviewed_qty) VALUES(1,1,5,8,NULL,5);
            INSERT INTO count_comparison_entries(comparison_id,item_id,first_qty,second_qty,final_qty,result) VALUES(1,1,5,6,5,'different');
            INSERT INTO purchase_items(purchase_id,item_id,qty) VALUES(1,1,8);
            INSERT INTO waste_records(item_id,qty,reason,reported_by) VALUES(1,3,'broken',1);
        ").unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        for (sql, expected) in [
            ("SELECT min_stock FROM items", 50),
            ("SELECT qty FROM batches", 50),
            ("SELECT initial_qty FROM batches", 80),
            ("SELECT delta FROM stock_movements", -30),
            ("SELECT qty_counted FROM count_entries", 50),
            ("SELECT expected_qty FROM count_entries", 80),
            ("SELECT reviewed_qty FROM count_entries", 50),
            ("SELECT first_qty FROM count_comparison_entries", 50),
            ("SELECT second_qty FROM count_comparison_entries", 60),
            ("SELECT final_qty FROM count_comparison_entries", 50),
            ("SELECT qty FROM purchase_items", 80),
            ("SELECT qty FROM waste_records", 30),
        ] {
            assert_eq!(
                conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap(),
                expected
            );
        }
        assert!(
            conn.query_row("SELECT reported_qty FROM count_entries", [], |r| r
                .get::<_, Option<i64>>(0))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn refuses_unknown_future_schema() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE alembic_version(version_num TEXT PRIMARY KEY);\
             INSERT INTO alembic_version VALUES('20990101_01');",
        )
        .unwrap();
        assert!(migrate(&conn).is_err());
    }
}
