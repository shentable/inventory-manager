"""Require reported daily quantity for selected items.

Revision ID: 20261102_11
Revises: 20260908_10
"""
from alembic import op
import sqlalchemy as sa

revision = "20261102_11"
down_revision = "20260908_10"
branch_labels = None
depends_on = None


def upgrade():
    columns = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("items")}
    if "daily_quantity_required" not in columns:
        op.add_column("items", sa.Column("daily_quantity_required", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.execute("UPDATE store_meta SET schema_version='20261102_11' WHERE id=1")


def downgrade():
    op.drop_column("items", "daily_quantity_required")
    op.execute("UPDATE store_meta SET schema_version='20260908_10' WHERE id=1")
