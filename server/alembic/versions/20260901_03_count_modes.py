"""add daily and weekly count modes

Revision ID: 20260901_03
Revises: 20260901_02
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "20260901_03"
down_revision = "20260901_02"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = inspect(op.get_bind())
    session_columns = {column["name"] for column in inspector.get_columns("count_sessions")}
    entry_columns = {column["name"] for column in inspector.get_columns("count_entries")}
    if "count_type" not in session_columns:
        op.add_column(
            "count_sessions",
            sa.Column("count_type", sa.String(length=16), nullable=False, server_default="weekly"),
        )
    if "is_enough" not in entry_columns:
        op.add_column("count_entries", sa.Column("is_enough", sa.Boolean(), nullable=True))
    op.execute("UPDATE store_meta SET schema_version = '20260901_03' WHERE id = 1")


def downgrade() -> None:
    op.execute("UPDATE store_meta SET schema_version = '20260901_02' WHERE id = 1")
    op.drop_column("count_entries", "is_enough")
    op.drop_column("count_sessions", "count_type")
