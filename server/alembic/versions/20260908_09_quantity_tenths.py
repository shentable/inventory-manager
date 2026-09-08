"""Store all inventory quantities as integer tenths.

Revision ID: 20260908_09
Revises: 20260904_08
"""
from alembic import op
import sqlalchemy as sa

revision = "20260908_09"
down_revision = "20260904_08"
branch_labels = None
depends_on = None

QUANTITIES = {
    "items": ["min_stock"],
    "batches": ["qty", "initial_qty"],
    "stock_movements": ["delta"],
    "purchase_items": ["qty"],
    "count_entries": ["qty_counted", "expected_qty", "reported_qty", "reviewed_qty"],
    "count_comparison_entries": ["first_qty", "second_qty", "final_qty"],
    "waste_records": ["qty"],
}


def upgrade():
    for table, columns in QUANTITIES.items():
        assignments = ", ".join(f"{column} = CAST(round({column} * 10) AS INTEGER)" for column in columns)
        op.execute(f"UPDATE {table} SET {assignments}")
    op.execute("UPDATE store_meta SET schema_version='20260908_09' WHERE id=1")


def downgrade():
    # Refuse a downgrade that would discard any fractional quantity or audit entry.
    for table, columns in QUANTITIES.items():
        fractional = " OR ".join(f"{column} % 10 != 0" for column in columns)
        if op.get_bind().execute(sa.text(f"SELECT 1 FROM {table} WHERE {fractional} LIMIT 1")).first():
            raise RuntimeError("数据库含小数数量，不能降级到整数库存版本")
    for table, columns in QUANTITIES.items():
        op.execute(f"UPDATE {table} SET " + ", ".join(f"{column} = {column} / 10" for column in columns))
    op.execute("UPDATE store_meta SET schema_version='20260904_08' WHERE id=1")
