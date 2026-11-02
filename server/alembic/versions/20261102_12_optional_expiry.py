"""Optional expiry tracking, preserving existing dates and all audit references."""
import re
from alembic import op
import sqlalchemy as sa

revision = "20261102_12"
down_revision = "20261102_11"
branch_labels = None
depends_on = None


def upgrade():
    # SQLite cannot drop NOT NULL in place. Rebuild using the original DDL and
    # restore every explicit index/trigger, with FK enforcement disabled outside
    # a transaction so referenced batch ids are never cascaded or rewritten.
    with op.get_context().autocommit_block():
        db = op.get_bind()
        foreign_keys = db.exec_driver_sql("PRAGMA foreign_keys").scalar()
        db.exec_driver_sql("PRAGMA foreign_keys=OFF")
        db.exec_driver_sql("BEGIN IMMEDIATE")
        try:
            columns = {c["name"] for c in sa.inspect(db).get_columns("items")}
            if "expiry_enabled" not in columns:
                db.exec_driver_sql("ALTER TABLE items ADD COLUMN expiry_enabled BOOLEAN NOT NULL DEFAULT 1")
            for table, fields in [("batches", ["expiry_date"]), ("stock_receipt_corrections", ["old_expiry_date", "new_expiry_date"])]:
                ddl = db.exec_driver_sql("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)).scalar()
                objects = db.exec_driver_sql("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL", (table,)).scalars().all()
                for field in fields:
                    ddl = re.sub(r'("?' + field + r'"?\s+\w+(?:\([^)]*\))?)\s+NOT NULL', r'\1', ddl, flags=re.I)
                temporary = "_expiry_" + table
                ddl = re.sub(r'^(CREATE TABLE\s+)(?:"' + table + r'"|' + table + r')', r'\1' + temporary, ddl, count=1, flags=re.I)
                db.exec_driver_sql(ddl)
                db.exec_driver_sql(f'INSERT INTO "{temporary}" SELECT * FROM "{table}"')
                db.exec_driver_sql(f'DROP TABLE "{table}"')
                db.exec_driver_sql(f'ALTER TABLE "{temporary}" RENAME TO "{table}"')
                for sql in objects:
                    db.exec_driver_sql(sql)
            db.exec_driver_sql("CREATE TABLE IF NOT EXISTS batch_expiry_updates (id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES batches(id), old_expiry_date VARCHAR(10), new_expiry_date VARCHAR(10) NOT NULL, actor_id INTEGER NOT NULL REFERENCES users(id), created_at DATETIME NOT NULL)")
            db.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_batch_expiry_updates_batch_id ON batch_expiry_updates(batch_id)")
            db.exec_driver_sql("UPDATE store_meta SET schema_version='20261102_12' WHERE id=1")
            db.exec_driver_sql("COMMIT")
        except Exception:
            db.exec_driver_sql("ROLLBACK")
            raise
        finally:
            db.exec_driver_sql(f"PRAGMA foreign_keys={int(foreign_keys)}")


def downgrade():
    db = op.get_bind()
    if db.exec_driver_sql("SELECT 1 FROM stock_receipt_corrections LIMIT 1").first():
        raise RuntimeError("已有入库更正审计记录，不能降级丢失历史")
    if db.exec_driver_sql("SELECT 1 FROM batches WHERE qty % 10 != 0 OR initial_qty % 10 != 0 LIMIT 1").first():
        raise RuntimeError("数据库含小数数量，不能降级到整数库存版本")
    raise RuntimeError("可空效期与补填审计不能安全降级")
