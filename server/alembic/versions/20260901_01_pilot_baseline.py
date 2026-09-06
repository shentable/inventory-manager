"""试运行数据库基线，并兼容升级旧 create_all 数据库。"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "20260901_01"
down_revision = None
branch_labels = None
depends_on = None


def _columns(table: str) -> set[str]:
    return {column["name"] for column in inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    # create_all 负责新库完整建表以及旧库新增表；随后补旧表缺失列。
    from app import models  # noqa: F401
    from app.database import Base

    bind = op.get_bind()
    Base.metadata.create_all(bind=bind)

    user_columns = _columns("users")
    if "must_change_pin" not in user_columns:
        op.add_column(
            "users",
            sa.Column("must_change_pin", sa.Boolean(), nullable=False, server_default=sa.true()),
        )
    if "token_version" not in user_columns:
        op.add_column(
            "users",
            sa.Column("token_version", sa.Integer(), nullable=False, server_default="0"),
        )

    purchase_columns = _columns("purchases")
    if "handled_by" not in purchase_columns:
        op.add_column("purchases", sa.Column("handled_by", sa.Integer(), nullable=True))
    if "handled_at" not in purchase_columns:
        op.add_column("purchases", sa.Column("handled_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    inspector = inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    if "stock_movements" in tables:
        op.drop_table("stock_movements")
    if "login_attempts" in tables:
        op.drop_table("login_attempts")
    if "purchases" in tables:
        columns = _columns("purchases")
        with op.batch_alter_table("purchases") as batch:
            if "handled_at" in columns:
                batch.drop_column("handled_at")
            if "handled_by" in columns:
                batch.drop_column("handled_by")
    if "users" in tables:
        columns = _columns("users")
        with op.batch_alter_table("users") as batch:
            if "token_version" in columns:
                batch.drop_column("token_version")
            if "must_change_pin" in columns:
                batch.drop_column("must_change_pin")
