use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;
use uuid::Uuid;

pub const DB_SCHEMA: &str = "20260904_08";

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
