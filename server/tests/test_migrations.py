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
        assert meta[1] == "20260908_10"
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


def test_receipt_audit_upgrade_keeps_tenths_and_blocks_history_loss(monkeypatch, tmp_path):
    import pytest
    path=tmp_path/'receipts.db'
    monkeypatch.setenv('DATABASE_URL',f'sqlite:///{path}')
    config=Config(str(Path(__file__).parents[1]/'alembic.ini'))
    command.upgrade(config,'20260908_09')
    with sqlite3.connect(path) as conn:
        conn.execute("INSERT INTO items(id,name,category,unit,shelf_life_days,min_stock,active,sort_order,created_at,daily_count_enabled,weekly_count_enabled) VALUES(1,'小数','','kg',7,3,1,0,CURRENT_TIMESTAMP,1,1)")
    command.upgrade(config,'head')
    command.upgrade(config,'head')
    with sqlite3.connect(path) as conn:
        assert conn.execute('SELECT min_stock FROM items').fetchone()[0]==3
        # Fixture writes intentionally omit FK parents: this tests the downgrade guard only.
        conn.execute("INSERT INTO stock_receipt_corrections(batch_id,old_qty,new_qty,old_expiry_date,new_expiry_date,reason,actor_id,created_at) VALUES(1,12,8,'2099-01-01','2099-01-01','audit',1,CURRENT_TIMESTAMP)")
    with pytest.raises(RuntimeError,match='审计记录'):
        command.downgrade(config,'20260908_09')
    with sqlite3.connect(path) as conn:
        assert conn.execute('SELECT new_qty FROM stock_receipt_corrections').fetchone()[0]==8


def test_quantity_migration_scales_history_once_and_refuses_lossy_downgrade(monkeypatch, tmp_path):
    path = tmp_path / "integer-quantities.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{path}")
    config = Config(str(Path(__file__).parents[1] / "alembic.ini"))
    command.upgrade(config, "20260904_08")
    fields = {
        "items": ["min_stock"], "batches": ["qty", "initial_qty"],
        "stock_movements": ["delta"], "purchase_items": ["qty"],
        "count_entries": ["qty_counted", "expected_qty", "reported_qty", "reviewed_qty"],
        "count_comparison_entries": ["first_qty", "second_qty", "final_qty"],
        "waste_records": ["qty"],
    }
    with sqlite3.connect(path) as conn:
        # A legacy fixture for each quantity column, including optional history.
        for table, quantities in fields.items():
            values = {}
            for _, name, kind, required, default, primary in conn.execute(f"PRAGMA table_info({table})"):
                if required or primary or name in quantities:
                    values[name] = 1 if "INT" in kind or "BOOL" in kind else "2026-09-08 00:00:00"
            values.update({name: -5 if name == "delta" else 5 for name in quantities})
            if table == "count_entries": values["reported_qty"] = None
            conn.execute(f"INSERT INTO {table}({','.join(values)}) VALUES({','.join('?' for _ in values)})", list(values.values()))
    command.upgrade(config, "head")
    command.upgrade(config, "head")
    with sqlite3.connect(path) as conn:
        for table, quantities in fields.items():
            for column in quantities:
                expected = None if column == "reported_qty" else -50 if column == "delta" else 50
                assert conn.execute(f"SELECT {column} FROM {table}").fetchone()[0] == expected
        conn.execute("UPDATE batches SET qty=49")
    import pytest
    with pytest.raises(RuntimeError, match="小数数量"):
        command.downgrade(config, "20260904_08")
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT qty FROM batches").fetchone()[0] == 49
        assert conn.execute("SELECT min_stock FROM items").fetchone()[0] == 50
