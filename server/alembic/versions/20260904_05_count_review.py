"""add two-person count review audit fields

Revision ID: 20260904_05
Revises: 20260901_04
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "20260904_05"
down_revision = "20260901_04"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = inspect(op.get_bind())
    session_columns = {c["name"] for c in inspector.get_columns("count_sessions")}
    entry_columns = {c["name"] for c in inspector.get_columns("count_entries")}
    if "review_reason" not in session_columns:
        op.add_column("count_sessions", sa.Column("review_reason", sa.String(32), nullable=True))
    if "review_note" not in session_columns:
        op.add_column("count_sessions", sa.Column("review_note", sa.String(255), nullable=True))
    if "reviewed_qty" not in entry_columns:
        op.add_column("count_entries", sa.Column("reviewed_qty", sa.Integer(), nullable=True))
    op.execute("UPDATE store_meta SET schema_version='20260904_05' WHERE id=1")


def downgrade() -> None:
    op.drop_column("count_entries", "reviewed_qty")
    op.drop_column("count_sessions", "review_note")
    op.drop_column("count_sessions", "review_reason")
    op.execute("UPDATE store_meta SET schema_version='20260901_04' WHERE id=1")
