"""Add stable store identity shared by Python and Android native backends."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "20260901_02"
down_revision = "20260901_01"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 01 的兼容路径通过 metadata.create_all 建新库，因此使用当前模型时表可能已存在。
    if "store_meta" not in inspect(op.get_bind()).get_table_names():
        op.create_table(
            "store_meta",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("store_id", sa.String(length=36), nullable=False, unique=True),
            sa.Column("schema_version", sa.String(length=32), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
        )
    # SQLite 自带 randomblob，避免迁移依赖运行时 Python UUID 回调。
    op.execute(
        """
        INSERT OR IGNORE INTO store_meta (id, store_id, schema_version, created_at)
        VALUES (
          1,
          lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
          substr(lower(hex(randomblob(2))), 2) || '-' ||
          substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
          lower(hex(randomblob(6))),
          '20260901_02',
          CURRENT_TIMESTAMP
        )
        """
    )


def downgrade() -> None:
    op.drop_table("store_meta")
