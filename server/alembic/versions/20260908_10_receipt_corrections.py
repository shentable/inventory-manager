"""Auditable direct receipt corrections.

Revision ID: 20260908_10
Revises: 20260908_09
"""
from alembic import op
import sqlalchemy as sa

revision = '20260908_10'
down_revision = '20260908_09'
branch_labels = None
depends_on = None


def upgrade():
    if not sa.inspect(op.get_bind()).has_table('stock_receipt_corrections'):
        op.create_table('stock_receipt_corrections',
            sa.Column('id', sa.Integer(), primary_key=True),
            sa.Column('batch_id', sa.Integer(), sa.ForeignKey('batches.id'), nullable=False),
            sa.Column('old_qty', sa.Integer(), nullable=False),
            sa.Column('new_qty', sa.Integer(), nullable=False),
            sa.Column('old_expiry_date', sa.String(10), nullable=False),
            sa.Column('new_expiry_date', sa.String(10), nullable=False),
            sa.Column('old_note', sa.String(255)),
            sa.Column('new_note', sa.String(255)),
            sa.Column('reason', sa.String(255), nullable=False),
            sa.Column('actor_id', sa.Integer(), sa.ForeignKey('users.id'), nullable=False),
            sa.Column('created_at', sa.DateTime(), nullable=False))
    op.execute('CREATE INDEX IF NOT EXISTS ix_stock_receipt_corrections_batch_id ON stock_receipt_corrections(batch_id)')
    op.execute("UPDATE store_meta SET schema_version='20260908_10' WHERE id=1")


def downgrade():
    if op.get_bind().execute(sa.text('SELECT 1 FROM stock_receipt_corrections LIMIT 1')).first():
        raise RuntimeError('已有入库更正审计记录，不能降级丢失历史')
    op.drop_table('stock_receipt_corrections')
    op.execute("UPDATE store_meta SET schema_version='20260908_09' WHERE id=1")
