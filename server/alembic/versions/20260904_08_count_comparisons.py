"""add paired count comparisons

Revision ID: 20260904_08
Revises: 20260904_07
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "20260904_08"
down_revision = "20260904_07"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    if "count_comparisons" not in tables:
        op.create_table(
            "count_comparisons",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("first_session_id", sa.Integer(), sa.ForeignKey("count_sessions.id"), nullable=False),
            sa.Column("second_session_id", sa.Integer(), sa.ForeignKey("count_sessions.id"), nullable=False),
            sa.Column("resolution", sa.String(32), nullable=False),
            sa.Column("trusted_session_id", sa.Integer(), sa.ForeignKey("count_sessions.id"), nullable=True),
            sa.Column("note", sa.String(255), nullable=True),
            sa.Column("confirmed_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
            sa.Column("confirmed_at", sa.DateTime(), nullable=False),
        )
    if "count_comparison_entries" not in tables:
        op.create_table(
            "count_comparison_entries",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("comparison_id", sa.Integer(), sa.ForeignKey("count_comparisons.id", ondelete="CASCADE"), nullable=False),
            sa.Column("item_id", sa.Integer(), sa.ForeignKey("items.id"), nullable=False),
            sa.Column("first_qty", sa.Integer(), nullable=True),
            sa.Column("second_qty", sa.Integer(), nullable=True),
            sa.Column("final_qty", sa.Integer(), nullable=True),
            sa.Column("result", sa.String(24), nullable=False),
            sa.UniqueConstraint("comparison_id", "item_id", name="uq_count_comparison_item"),
        )
        op.create_index("ix_count_comparison_entries_comparison_id", "count_comparison_entries", ["comparison_id"])
    columns = {c["name"] for c in inspect(op.get_bind()).get_columns("count_sessions")}
    if "comparison_id" not in columns:
        op.add_column("count_sessions", sa.Column("comparison_id", sa.Integer(), sa.ForeignKey("count_comparisons.id"), nullable=True))
        op.create_index("ix_count_sessions_comparison_id", "count_sessions", ["comparison_id"])
    op.execute("UPDATE store_meta SET schema_version='20260904_08' WHERE id=1")


def downgrade() -> None:
    op.drop_index("ix_count_sessions_comparison_id", table_name="count_sessions")
    op.drop_column("count_sessions", "comparison_id")
    op.drop_index("ix_count_comparison_entries_comparison_id", table_name="count_comparison_entries")
    op.drop_table("count_comparison_entries")
    op.drop_table("count_comparisons")
    op.execute("UPDATE store_meta SET schema_version='20260904_07' WHERE id=1")
