"""Pydantic v2 请求/响应模型。"""
import re
from datetime import date, datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .quantity import Quantity, QuantityInput

PIN_RE = re.compile(r"^\d{4,6}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

Role = Literal["staff", "manager", "admin"]


def _check_date(v: str) -> str:
    if not DATE_RE.match(v):
        raise ValueError("效期必须为 YYYY-MM-DD")
    try:
        date.fromisoformat(v)
    except ValueError as exc:
        raise ValueError("效期必须为有效日期 YYYY-MM-DD") from exc
    return v


# ---------- 认证 ----------

class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    pin: str = Field(pattern=r"^\d{4,6}$")

    @field_validator("username")
    @classmethod
    def _normalize_username(cls, v: str) -> str:
        normalized = v.strip().lower()
        if not normalized:
            raise ValueError("用户名不能为空")
        return normalized


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    display_name: str
    role: str
    active: bool
    must_change_pin: bool
    created_at: datetime


class LoginResponse(BaseModel):
    token: str
    user: UserOut


class LoginOptionsResponse(BaseModel):
    users: list[UserOut]


class ChangePinRequest(BaseModel):
    current_pin: str
    new_pin: str

    @field_validator("current_pin", "new_pin")
    @classmethod
    def _check_pin(cls, v: str) -> str:
        if not PIN_RE.match(v):
            raise ValueError("PIN 必须为 4-6 位数字")
        return v


class UserCreate(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    display_name: str = Field(min_length=1, max_length=128)
    pin: str
    role: Role = "staff"

    @field_validator("username")
    @classmethod
    def _normalize_username(cls, v: str) -> str:
        normalized = v.strip().lower()
        if not normalized:
            raise ValueError("用户名不能为空")
        return normalized

    @field_validator("pin")
    @classmethod
    def _check_pin(cls, v: str) -> str:
        if not PIN_RE.match(v):
            raise ValueError("PIN 必须为 4-6 位数字")
        return v


class UserUpdate(BaseModel):
    username: Optional[str] = Field(default=None, min_length=1, max_length=64)
    display_name: Optional[str] = Field(default=None, min_length=1, max_length=128)
    role: Optional[Role] = None
    active: Optional[bool] = None
    pin: Optional[str] = None

    @field_validator("username")
    @classmethod
    def _normalize_username(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        normalized = v.strip().lower()
        if not normalized:
            raise ValueError("用户名不能为空")
        return normalized

    @field_validator("pin")
    @classmethod
    def _check_pin(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and not PIN_RE.match(v):
            raise ValueError("PIN 必须为 4-6 位数字")
        return v


# ---------- 库存品 ----------

class ItemCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    category: str = Field(default="", max_length=64)
    unit: str = Field(default="个", max_length=16)
    shelf_life_days: int = Field(default=7, ge=1)
    min_stock: QuantityInput = Field(default=0, ge=0)
    daily_count_enabled: bool = True
    weekly_count_enabled: bool = True
    sort_order: int = 0


class ItemUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=128)
    category: Optional[str] = Field(default=None, max_length=64)
    unit: Optional[str] = Field(default=None, max_length=16)
    shelf_life_days: Optional[int] = Field(default=None, ge=1)
    min_stock: Optional[QuantityInput] = Field(default=None, ge=0)
    daily_count_enabled: Optional[bool] = None
    weekly_count_enabled: Optional[bool] = None
    active: Optional[bool] = None
    sort_order: Optional[int] = None


class ItemOut(BaseModel):
    id: int
    name: str
    category: str
    unit: str
    shelf_life_days: int
    min_stock: Quantity
    daily_count_enabled: bool
    weekly_count_enabled: bool
    active: bool
    sort_order: int
    stock: Quantity  # 实时库存（批次剩余之和）
    last_count_at: Optional[datetime] = None
    last_count_qty: Optional[Quantity] = None
    last_count_type: Optional[str] = None
    last_count_enough: Optional[bool] = None


class BatchOut(BaseModel):
    id: int
    item_id: int
    qty: Quantity
    initial_qty: Quantity
    expiry_date: str
    received_at: datetime
    source: str
    note: Optional[str]
    days_to_expiry: int


class StockMovementOut(BaseModel):
    id: int
    item_id: int
    batch_id: int
    delta: Quantity
    operation: str
    reference_type: str
    reference_id: Optional[int]
    actor_id: int
    actor_name: str
    created_at: datetime


class StockItem(BaseModel):
    id: int
    name: str
    category: str
    unit: str
    shelf_life_days: int
    min_stock: Quantity
    daily_count_enabled: bool
    weekly_count_enabled: bool
    active: bool


class StockEntry(BaseModel):
    item: StockItem
    stock: Quantity
    nearest_expiry: Optional[str]
    batch_count: int


class StockReceiveItem(BaseModel):
    item_id: int
    qty: QuantityInput = Field(ge=0.1)
    expiry_date: str

    @field_validator("expiry_date")
    @classmethod
    def _check_expiry(cls, v: str) -> str:
        return _check_date(v)


class StockReceiveIn(BaseModel):
    items: list[StockReceiveItem] = Field(min_length=1)
    note: Optional[str] = Field(default=None, max_length=255)


class StockReceiptCorrectionIn(BaseModel):
    qty: QuantityInput = Field(ge=0)
    expiry_date: str
    note: Optional[str] = Field(default=None, max_length=255)
    reason: str = Field(min_length=1, max_length=255)
    expected_revision: int = Field(ge=0)

    @field_validator("expiry_date")
    @classmethod
    def _check_expiry(cls, value: str) -> str:
        return _check_date(value)


class ExpiryEntry(BaseModel):
    batch_id: int
    item_id: int
    item_name: str
    unit: str
    qty: Quantity
    expiry_date: str
    days_to_expiry: int


# ---------- 盘点 ----------

class CountEntryIn(BaseModel):
    item_id: int
    qty: Optional[QuantityInput] = Field(default=None, ge=0)
    enough: Optional[bool] = None


class CountCreate(BaseModel):
    count_type: Literal["daily", "weekly"] = "weekly"
    entries: list[CountEntryIn] = Field(min_length=1)
    note: Optional[str] = None
    overwrite_daily: bool = False


class CountEditIn(BaseModel):
    entries: list[CountEntryIn] = Field(min_length=1)
    note: Optional[str] = Field(default=None, max_length=255)


class CountReviewEntryIn(BaseModel):
    item_id: int
    qty: QuantityInput = Field(ge=0)
    expected_current_qty: Optional[QuantityInput] = Field(default=None, ge=0)


class CountVerifyIn(BaseModel):
    entries: list[CountReviewEntryIn] = Field(min_length=1)
    difference_reason: Optional[Literal["normal_consumption", "recount_corrected"]] = None
    difference_note: Optional[str] = Field(default=None, max_length=255)


class CountEntryOut(BaseModel):
    id: int
    item_id: int
    item_name: str
    unit: str
    expected_qty: Quantity
    qty_counted: Quantity
    diff: Quantity
    is_enough: Optional[bool]
    reported_qty: Optional[Quantity]
    reviewed_qty: Optional[Quantity]
    review_diff: Optional[Quantity]
    current_qty: Quantity


class CountOut(BaseModel):
    id: int
    status: str
    count_type: str
    business_date: Optional[str]
    note: Optional[str]
    created_by: int
    created_by_name: str
    created_at: datetime
    verified_by: Optional[int]
    verified_by_name: str
    verified_at: Optional[datetime]
    review_reason: Optional[str]
    review_note: Optional[str]
    comparison_id: Optional[int]
    entries_count: int
    difference_count: int
    enough_count: int
    not_enough_count: int
    quantity_count: int


class CountDetailOut(BaseModel):
    id: int
    status: str
    count_type: str
    business_date: Optional[str]
    note: Optional[str]
    created_by: int
    created_by_name: str
    created_at: datetime
    verified_by: Optional[int]
    verified_by_name: str
    verified_at: Optional[datetime]
    review_reason: Optional[str]
    review_note: Optional[str]
    comparison_id: Optional[int]
    entries: list[CountEntryOut]


# ---------- 报损 ----------

class WasteCreate(BaseModel):
    item_id: int
    qty: QuantityInput = Field(ge=0.1)
    reason: str = Field(min_length=1, max_length=64)
    description: Optional[str] = Field(default=None, max_length=500)
    photo_data: Optional[str] = None
    batch_id: Optional[int] = None


class WasteOut(BaseModel):
    id: int
    item_id: int
    item_name: str
    unit: str
    batch_id: Optional[int]
    batch_expiry_date: Optional[str]
    qty: Quantity
    reason: str
    description: Optional[str]
    has_photo: bool
    status: str
    reported_by: int
    reported_by_name: str
    reported_at: datetime
    confirmed_by: Optional[int]
    confirmed_at: Optional[datetime]


# ---------- 采购 ----------

class PurchaseItemIn(BaseModel):
    item_id: int
    qty: QuantityInput = Field(ge=0.1)


class PurchaseCreate(BaseModel):
    items: list[PurchaseItemIn] = Field(min_length=1)
    note: Optional[str] = None


class PurchaseLineOut(BaseModel):
    id: int
    item_id: int
    item_name: str
    unit: str
    qty: Quantity


class PurchaseOut(BaseModel):
    id: int
    status: str
    note: Optional[str]
    created_by: int
    created_by_name: str
    created_at: datetime
    received_at: Optional[datetime]
    items: list[PurchaseLineOut]


class PurchaseReceiveItem(BaseModel):
    purchase_item_id: int
    expiry_date: str

    @field_validator("expiry_date")
    @classmethod
    def _check_expiry(cls, v: str) -> str:
        return _check_date(v)


class PurchaseReceiveIn(BaseModel):
    items: list[PurchaseReceiveItem] = Field(min_length=1)


# ---------- 仪表盘 ----------

class DashboardOut(BaseModel):
    low_stock: int
    expiring_soon: int
    pending_waste: int
    pending_counts: int
    active_purchases: int
    daily_shortages: int
    recent_counts_3d: int
