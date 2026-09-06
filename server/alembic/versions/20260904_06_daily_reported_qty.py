"""add optional reported quantity to daily count entries

Revision ID: 20260904_06
Revises: 20260904_05
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "20260904_06"
down_revision = "20260904_05"
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = {c["name"] for c in inspect(op.get_bind()).get_columns("count_entries")}
    if "reported_qty" not in columns:
        op.add_column("count_entries", sa.Column("reported_qty", sa.Integer(), nullable=True))
    op.execute("UPDATE store_meta SET schema_version='20260904_06' WHERE id=1")


def downgrade() -> None:
    op.drop_column("count_entries", "reported_qty")
    op.execute("UPDATE store_meta SET schema_version='20260904_05' WHERE id=1")
