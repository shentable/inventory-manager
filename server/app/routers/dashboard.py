"""仪表盘统计。"""
from datetime import timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..database import utcnow
from ..deps import get_db, require_role
from ..inventory import item_stock, today
from ..models import Batch, CountEntry, CountSession, Item, Purchase, User, WasteRecord
from ..schemas import DashboardOut

router = APIRouter(prefix="/api", tags=["dashboard"])

EXPIRING_SOON_DAYS = 3  # 与 /api/expiry 默认窗口一致


@router.get("/dashboard", response_model=DashboardOut)
def dashboard(
    db: Session = Depends(get_db),
    user: User = Depends(require_role("staff")),
):
    items = db.scalars(select(Item).where(Item.active.is_(True))).all()
    low_stock = sum(1 for it in items if item_stock(db, it.id) < it.min_stock)
    cutoff = (today() + timedelta(days=EXPIRING_SOON_DAYS)).isoformat()
    expiring = db.scalar(
        select(func.count(Batch.id)).where(Batch.qty > 0, Batch.expiry_date <= cutoff)
    ) or 0
    pending_waste = db.scalar(
        select(func.count(WasteRecord.id)).where(WasteRecord.status == "pending")
    ) or 0
    pending_counts = db.scalar(
        select(func.count(CountSession.id)).where(
            CountSession.count_type == "weekly",
            CountSession.status == "submitted",
            CountSession.created_at >= utcnow() - timedelta(hours=72),
        )
    ) or 0
    active_purchases = db.scalar(
        select(func.count(Purchase.id)).where(Purchase.status == "ordered")
    ) or 0
    daily_shortages = db.scalar(
        select(func.count(CountEntry.id))
        .join(CountSession, CountEntry.session_id == CountSession.id)
        .where(
            CountSession.count_type == "daily",
            CountSession.business_date == today().isoformat(),
            CountSession.status == "completed",
            CountEntry.is_enough.is_(False),
        )
    ) or 0
    recent_stmt = select(func.count(CountSession.id)).where(
        CountSession.count_type == "weekly",
        CountSession.created_at >= utcnow() - timedelta(days=3),
    )
    if user.role == "staff":
        recent_stmt = recent_stmt.where(CountSession.created_by == user.id)
    recent_counts_3d = db.scalar(recent_stmt) or 0
    return DashboardOut(
        low_stock=low_stock,
        expiring_soon=int(expiring),
        pending_waste=int(pending_waste),
        pending_counts=int(pending_counts),
        active_purchases=int(active_purchases),
        daily_shortages=int(daily_shortages),
        recent_counts_3d=int(recent_counts_3d),
    )
