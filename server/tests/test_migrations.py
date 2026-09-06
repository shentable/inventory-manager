"""Alembic 必须同时支持新库和旧 create_all 库升级。"""

from pathlib import Path
import sqlite3

from alembic import command
from alembic.config import Config


def _upgrade(monkeypatch, path: Path) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{path}")
    config = Config(str(Path(__file__).parents[1] / "alembic.ini"))
    command.upgrade(config, "head")


def test_fresh_database_migration(monkeypatch, tmp_path):
    path = tmp_path / "fresh.db"
    _upgrade(monkeypatch, path)
    with sqlite3.connect(path) as conn:
        tables = {row[0] for row in conn.execute("select name from sqlite_master where type='table'")}
        assert {"users", "stock_movements", "login_attempts", "store_meta", "alembic_version"} <= tables
        meta = conn.execute(
            "select store_id, schema_version from store_meta where id = 1"
        ).fetchone()
        assert meta is not None
        assert len(meta[0]) == 36
        assert meta[1] == "20260904_08"
        count_columns = {row[1] for row in conn.execute("pragma table_info(count_sessions)")}
        entry_columns = {row[1] for row in conn.execute("pragma table_info(count_entries)")}
        assert "count_type" in count_columns
        assert "business_date" in count_columns
        assert {"review_reason", "review_note"} <= count_columns
        assert "is_enough" in entry_columns
        assert "reported_qty" in entry_columns
        item_columns = {row[1] for row in conn.execute("pragma table_info(items)")}
        assert "daily_count_enabled" in item_columns
        assert "weekly_count_enabled" in item_columns
        assert "reviewed_qty" in entry_columns
        waste_columns = {row[1] for row in conn.execute("pragma table_info(waste_records)")}
        assert {"description", "photo_mime", "photo_base64"} <= waste_columns
        indexes = {row[1] for row in conn.execute("pragma index_list(count_sessions)")}
        assert "uq_count_sessions_daily_date" in indexes


def test_legacy_database_migration(monkeypatch, tmp_path):
    path = tmp_path / "legacy.db"
    with sqlite3.connect(path) as conn:
        conn.executescript(
            """
            CREATE TABLE users (
              id INTEGER PRIMARY KEY, username VARCHAR(64) NOT NULL UNIQUE,
              display_name VARCHAR(128) NOT NULL, pin_hash VARCHAR(256) NOT NULL,
              role VARCHAR(16) NOT NULL, active BOOLEAN NOT NULL, created_at DATETIME NOT NULL
            );
            CREATE TABLE purchases (
              id INTEGER PRIMARY KEY, status VARCHAR(16) NOT NULL, created_by INTEGER NOT NULL,
              created_at DATETIME NOT NULL, received_at DATETIME, note VARCHAR(255)
            );
            """
        )
    _upgrade(monkeypatch, path)
    with sqlite3.connect(path) as conn:
        user_columns = {row[1] for row in conn.execute("pragma table_info(users)")}
        purchase_columns = {row[1] for row in conn.execute("pragma table_info(purchases)")}
        assert {"must_change_pin", "token_version"} <= user_columns
        assert {"handled_by", "handled_at"} <= purchase_columns
        assert conn.execute("select count(*) from store_meta").fetchone()[0] == 1
