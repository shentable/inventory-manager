"""库存总览与效期预警。"""
from datetime import timedelta
import json
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, text, update
from sqlalchemy.orm import Session

from ..deps import get_db, require_role
from ..inventory import days_to_expiry, positive_batches, record_batch_creation, today
from ..models import Batch, Item, User, StockMovement, StockReceiptCorrection
from ..schemas import BatchOut, ExpiryEntry, StockEntry, StockItem, StockReceiveIn, StockReceiptCorrectionIn
from ..quantity import ticks

router = APIRouter(prefix="/api", tags=["stock"])
RECEIPTS_SQL = (Path(__file__).resolve().parents[1] / "receipts.sql").read_text()


def receipt_rows(db, user, *, batch_id=None, q="", limit=51, offset=0):
    params = dict(owner=user.id if user.role == "staff" else None, batch_id=batch_id,
                  search="%" + q + "%", limit=limit, offset=offset)
    return [json.loads(row[0]) for row in db.execute(text(RECEIPTS_SQL), params)]


def receipt_detail(db, user, batch_id):
    rows = receipt_rows(db, user, batch_id=batch_id, limit=1)
    if not rows:
        raise HTTPException(status_code=404, detail="入库记录不存在或无权查看")
    return rows[0]


@router.get("/stock/receipts")
def receipts(q: str = Query("", max_length=100), limit: int = Query(50, ge=1, le=100),
             offset: int = Query(0, ge=0), db: Session = Depends(get_db),
             actor: User = Depends(require_role("staff"))):
    rows = receipt_rows(db, actor, q=q, limit=limit+1, offset=offset)
    return dict(items=rows[:limit], has_more=len(rows)>limit, limit=limit, offset=offset)


@router.get("/stock/receipts/{batch_id}")
def receipt(batch_id: int, db: Session = Depends(get_db),
            actor: User = Depends(require_role("staff"))):
    return receipt_detail(db, actor, batch_id)


@router.patch("/stock/receipts/{batch_id}")
def correct_receipt(batch_id: int, payload: StockReceiptCorrectionIn,
                    db: Session = Depends(get_db), actor: User = Depends(require_role("staff"))):
    reason = payload.reason.strip()
    if not reason:
        raise HTTPException(status_code=400, detail="请填写更正原因")
    try:
        # Obtain SQLite's writer lock before reading the revision and remaining stock.
        db.execute(update(Batch).where(Batch.id == batch_id).values(qty=Batch.qty))
        row = receipt_detail(db, actor, batch_id)
        if row["revision"] != payload.expected_revision:
            raise HTTPException(status_code=409, detail="入库记录已被更正，请刷新后重试")
        delta = ticks(payload.qty) - ticks(row["qty"])
        if delta and row["quantity_locked"]:
            raise HTTPException(status_code=409, detail="入库后已有确认盘点，数量请通过重新盘点核实；仍可更正效期和备注")
        remaining = ticks(row["remaining_qty"]) + delta
        if remaining < 0:
            raise HTTPException(status_code=409, detail="更正数量小于该批次已扣减数量，请先核实库存")
        note = payload.note.strip() or None if payload.note is not None else None
        if not delta and payload.expiry_date == row["expiry_date"] and note == row["note"]:
            raise HTTPException(status_code=400, detail="没有需要保存的更正")
        correction = StockReceiptCorrection(batch_id=batch_id, old_qty=row["qty"], new_qty=payload.qty,
            old_expiry_date=row["expiry_date"], new_expiry_date=payload.expiry_date,
            old_note=row["note"], new_note=note, reason=reason, actor_id=actor.id)
        db.add(correction)
        db.flush()
        db.execute(update(Batch).where(Batch.id == batch_id).values(
            qty=remaining/10, expiry_date=payload.expiry_date, note=note))
        db.add(StockMovement(item_id=row["item_id"], batch_id=batch_id, delta=delta/10,
            operation="stock_receive_correction", reference_type="receipt_correction",
            reference_id=correction.id, actor_id=actor.id))
        db.commit()
        return receipt_detail(db, actor, batch_id)
    except Exception:
        db.rollback()
        raise


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
        stock = round(sum(b.qty for b in batches), 1)
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
    actor: User = Depends(require_role("staff")),
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
                db, batch, actor.id, "stock_receive", "manual", None
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
