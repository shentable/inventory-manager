"""库存总览与效期预警。"""
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..deps import get_db, require_role
from ..inventory import days_to_expiry, positive_batches, record_batch_creation, today
from ..models import Batch, Item, User
from ..schemas import BatchOut, ExpiryEntry, StockEntry, StockItem, StockReceiveIn

router = APIRouter(prefix="/api", tags=["stock"])


@router.get("/stock", response_model=list[StockEntry])
def get_stock(
    db: Session = Depends(get_db),
    _: User = Depends(require_role("staff")),
):
    items = db.scalars(
        select(Item).where(Item.active.is_(True)).order_by(Item.sort_order, Item.id)
    ).all()
    result = []
    for it in items:
        batches = positive_batches(db, it.id)
        stock = sum(b.qty for b in batches)
        nearest = min((b.expiry_date for b in batches), default=None)
        result.append(
            StockEntry(
                item=StockItem(
                    id=it.id,
                    name=it.name,
                    category=it.category,
                    unit=it.unit,
                    shelf_life_days=it.shelf_life_days,
                    min_stock=it.min_stock,
                    daily_count_enabled=it.daily_count_enabled,
                    weekly_count_enabled=it.weekly_count_enabled,
                    active=it.active,
                ),
                stock=stock,
                nearest_expiry=nearest,
                batch_count=len(batches),
            )
        )
    return result


@router.post("/stock/receive", response_model=list[BatchOut], status_code=201)
def receive_stock(
    payload: StockReceiveIn,
    db: Session = Depends(get_db),
    manager: User = Depends(require_role("manager")),
):
    """无需采购单直接入库，并为每一行创建批次及不可变流水。"""
    seen: set[int] = set()
    for line in payload.items:
        if line.item_id in seen:
            raise HTTPException(status_code=400, detail="入库条目重复")
        seen.add(line.item_id)
        if db.get(Item, line.item_id) is None:
            raise HTTPException(status_code=400, detail=f"库存品不存在：{line.item_id}")

    batches: list[Batch] = []
    try:
        for line in payload.items:
            batch = Batch(
                item_id=line.item_id,
                qty=line.qty,
                initial_qty=line.qty,
                expiry_date=line.expiry_date,
                source="receive",
                note=payload.note,
            )
            db.add(batch)
            db.flush()
            record_batch_creation(
                db, batch, manager.id, "stock_receive", "manual", None
            )
            batches.append(batch)
        db.commit()
    except Exception:
        db.rollback()
        raise

    return [
        BatchOut(
            id=batch.id,
            item_id=batch.item_id,
            qty=batch.qty,
            initial_qty=batch.initial_qty,
            expiry_date=batch.expiry_date,
            received_at=batch.received_at,
            source=batch.source,
            note=batch.note,
            days_to_expiry=days_to_expiry(batch.expiry_date),
        )
        for batch in batches
    ]


@router.get("/expiry", response_model=list[ExpiryEntry])
def expiry_list(
    days: int = Query(3, ge=0),
    db: Session = Depends(get_db),
    _: User = Depends(require_role("staff")),
):
    """days_to_expiry <= days 且 qty>0 的批次（含已过期），按到期时间排序。"""
    cutoff = (today() + timedelta(days=days)).isoformat()
    batches = db.scalars(
        select(Batch)
        .join(Item, Batch.item_id == Item.id)
        .where(Batch.qty > 0, Batch.expiry_date <= cutoff)
        .order_by(Batch.expiry_date, Batch.id)
    ).all()
    return [
        ExpiryEntry(
            batch_id=b.id,
            item_id=b.item_id,
            item_name=b.item.name,
            unit=b.item.unit,
            qty=b.qty,
            expiry_date=b.expiry_date,
            days_to_expiry=days_to_expiry(b.expiry_date),
        )
        for b in batches
    ]
