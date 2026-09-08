"""SQLAlchemy 2.0 ORM 模型（Mapped / mapped_column）。"""
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base, utcnow
from .quantity import QuantityColumn


class StoreMeta(Base):
    """数据库级身份；随备份迁移，不能在服务切换时重新生成。"""

    __tablename__ = "store_meta"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    store_id: Mapped[str] = mapped_column(String(36), unique=True, nullable=False)
    schema_version: Mapped[str] = mapped_column(String(32), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(128))
    pin_hash: Mapped[str] = mapped_column(String(256))
    role: Mapped[str] = mapped_column(String(16), default="staff")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    must_change_pin: Mapped[bool] = mapped_column(Boolean, default=True)
    token_version: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class LoginAttempt(Base):
    """持久化登录失败计数，避免服务重启绕过限流。"""

    __tablename__ = "login_attempts"
    __table_args__ = (UniqueConstraint("username", "source_ip", name="uq_login_attempt_scope"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(64), index=True)
    source_ip: Mapped[str] = mapped_column(String(64))
    failed_count: Mapped[int] = mapped_column(Integer, default=0)
    window_started_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class Item(Base):
    __tablename__ = "items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    category: Mapped[str] = mapped_column(String(64), default="")
    unit: Mapped[str] = mapped_column(String(16), default="个")
    shelf_life_days: Mapped[int] = mapped_column(Integer, default=7)
    min_stock: Mapped[float] = mapped_column(QuantityColumn, default=0)
    daily_count_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    weekly_count_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Batch(Base):
    __tablename__ = "batches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id"), index=True)
    qty: Mapped[float] = mapped_column(QuantityColumn, default=0)          # 剩余数量
    initial_qty: Mapped[float] = mapped_column(QuantityColumn, default=0)  # 初始数量
    expiry_date: Mapped[str] = mapped_column(String(10))          # YYYY-MM-DD
    received_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    source: Mapped[str] = mapped_column(String(16), default="init")  # purchase|receive|init|adjust
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)

    item: Mapped["Item"] = relationship()


class StockMovement(Base):
    """不可变库存流水；Batch.qty 是当前余额，流水是审计来源。"""

    __tablename__ = "stock_movements"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id"), index=True)
    batch_id: Mapped[int] = mapped_column(ForeignKey("batches.id"), index=True)
    delta: Mapped[float] = mapped_column(QuantityColumn)
    operation: Mapped[str] = mapped_column(String(32))
    reference_type: Mapped[str] = mapped_column(String(32))
    reference_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    actor_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    item: Mapped["Item"] = relationship()
    batch: Mapped["Batch"] = relationship()


class StockReceiptCorrection(Base):
    __tablename__ = "stock_receipt_corrections"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    batch_id: Mapped[int] = mapped_column(ForeignKey("batches.id"), index=True)
    old_qty: Mapped[float] = mapped_column(QuantityColumn)
    new_qty: Mapped[float] = mapped_column(QuantityColumn)
    old_expiry_date: Mapped[str] = mapped_column(String(10))
    new_expiry_date: Mapped[str] = mapped_column(String(10))
    old_note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    new_note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    reason: Mapped[str] = mapped_column(String(255))
    actor_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Purchase(Base):
    __tablename__ = "purchases"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    status: Mapped[str] = mapped_column(String(16), default="ordered")  # ordered|received|cancelled
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    received_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    handled_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    handled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)

    items: Mapped[list["PurchaseItem"]] = relationship(
        back_populates="purchase", cascade="all, delete-orphan"
    )


class PurchaseItem(Base):
    __tablename__ = "purchase_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    purchase_id: Mapped[int] = mapped_column(ForeignKey("purchases.id"), index=True)
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id"))
    qty: Mapped[float] = mapped_column(QuantityColumn)

    purchase: Mapped["Purchase"] = relationship(back_populates="items")
    item: Mapped["Item"] = relationship()


class CountSession(Base):
    __tablename__ = "count_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    count_type: Mapped[str] = mapped_column(String(16), default="weekly")  # daily|weekly
    business_date: Mapped[str | None] = mapped_column(String(10), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="submitted")  # submitted|verified|rejected
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    verified_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    review_reason: Mapped[str | None] = mapped_column(String(32), nullable=True)
    review_note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # 迁移层添加真实外键；ORM 元数据不声明反向外键，避免 SQLite drop_all 的循环依赖。
    comparison_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)

    entries: Mapped[list["CountEntry"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )


class CountEntry(Base):
    __tablename__ = "count_entries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("count_sessions.id"), index=True)
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id"))
    qty_counted: Mapped[float] = mapped_column(QuantityColumn)
    expected_qty: Mapped[float] = mapped_column(QuantityColumn)  # 提交时服务器快照
    is_enough: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    reported_qty: Mapped[float | None] = mapped_column(QuantityColumn, nullable=True)
    reviewed_qty: Mapped[float | None] = mapped_column(QuantityColumn, nullable=True)

    session: Mapped["CountSession"] = relationship(back_populates="entries")
    item: Mapped["Item"] = relationship()


class CountComparison(Base):
    """两份独立每周盘点的不可变比对与最终处置。"""

    __tablename__ = "count_comparisons"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    first_session_id: Mapped[int] = mapped_column(ForeignKey("count_sessions.id"))
    second_session_id: Mapped[int] = mapped_column(ForeignKey("count_sessions.id"))
    resolution: Mapped[str] = mapped_column(String(32))
    trusted_session_id: Mapped[int | None] = mapped_column(
        ForeignKey("count_sessions.id"), nullable=True
    )
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    confirmed_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    confirmed_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class CountComparisonEntry(Base):
    __tablename__ = "count_comparison_entries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    comparison_id: Mapped[int] = mapped_column(
        ForeignKey("count_comparisons.id", ondelete="CASCADE"), index=True
    )
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id"))
    first_qty: Mapped[float | None] = mapped_column(QuantityColumn, nullable=True)
    second_qty: Mapped[float | None] = mapped_column(QuantityColumn, nullable=True)
    final_qty: Mapped[float | None] = mapped_column(QuantityColumn, nullable=True)
    result: Mapped[str] = mapped_column(String(24))


class WasteRecord(Base):
    __tablename__ = "waste_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id"), index=True)
    batch_id: Mapped[int | None] = mapped_column(ForeignKey("batches.id"), nullable=True)
    qty: Mapped[float] = mapped_column(QuantityColumn)
    reason: Mapped[str] = mapped_column(String(64))
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)
    photo_mime: Mapped[str | None] = mapped_column(String(32), nullable=True)
    photo_base64: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="pending")  # pending|confirmed|rejected
    reported_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    reported_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    confirmed_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    item: Mapped["Item"] = relationship()
