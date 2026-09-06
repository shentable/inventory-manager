"""add daily and weekly count switches to items

Revision ID: 20260904_07
Revises: 20260904_06
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "20260904_07"
down_revision = "20260904_06"
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = {c["name"] for c in inspect(op.get_bind()).get_columns("items")}
    if "daily_count_enabled" not in columns:
        op.add_column(
            "items",
            sa.Column("daily_count_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        )
    if "weekly_count_enabled" not in columns:
        op.add_column(
            "items",
            sa.Column("weekly_count_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        )
    op.execute("UPDATE store_meta SET schema_version='20260904_07' WHERE id=1")


def downgrade() -> None:
    op.drop_column("items", "weekly_count_enabled")
    op.drop_column("items", "daily_count_enabled")
    op.execute("UPDATE store_meta SET schema_version='20260904_06' WHERE id=1")
