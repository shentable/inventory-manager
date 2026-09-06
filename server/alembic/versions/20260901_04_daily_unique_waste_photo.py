"""unique daily counts and waste evidence

Revision ID: 20260901_04
Revises: 20260901_03
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "20260901_04"
down_revision = "20260901_03"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = inspect(op.get_bind())
    count_columns = {c["name"] for c in inspector.get_columns("count_sessions")}
    waste_columns = {c["name"] for c in inspector.get_columns("waste_records")}
    if "business_date" not in count_columns:
        op.add_column("count_sessions", sa.Column("business_date", sa.String(10), nullable=True))
    if "description" not in waste_columns:
        op.add_column("waste_records", sa.Column("description", sa.String(500), nullable=True))
    if "photo_mime" not in waste_columns:
        op.add_column("waste_records", sa.Column("photo_mime", sa.String(32), nullable=True))
    if "photo_base64" not in waste_columns:
        op.add_column("waste_records", sa.Column("photo_base64", sa.Text(), nullable=True))

    # 旧库同一天可能有多条每日盘点：保留最新一条为有效结果，其余标记为 superseded。
    op.execute("""
        UPDATE count_sessions SET status='superseded', business_date=NULL
        WHERE count_type='daily' AND id NOT IN (
          SELECT max(id) FROM count_sessions WHERE count_type='daily'
          GROUP BY date(created_at, '+8 hours')
        )
    """)
    op.execute("""
        UPDATE count_sessions SET business_date=date(created_at, '+8 hours')
        WHERE count_type='daily' AND status<>'superseded'
    """)
    op.create_index(
        "uq_count_sessions_daily_date",
        "count_sessions",
        ["business_date"],
        unique=True,
        sqlite_where=sa.text("count_type='daily' AND business_date IS NOT NULL"),
    )
    op.execute("UPDATE store_meta SET schema_version='20260901_04' WHERE id=1")


def downgrade() -> None:
    op.drop_index("uq_count_sessions_daily_date", table_name="count_sessions")
    op.drop_column("waste_records", "photo_base64")
    op.drop_column("waste_records", "photo_mime")
    op.drop_column("waste_records", "description")
    op.drop_column("count_sessions", "business_date")
    op.execute("UPDATE store_meta SET schema_version='20260901_03' WHERE id=1")
