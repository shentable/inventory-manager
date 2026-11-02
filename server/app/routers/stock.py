"""库存总览与效期预警。"""
from datetime import timedelta
import json
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, text, update
from sqlalchemy.orm import Session

from ..deps import get_db, require_role
from ..inventory import days_to_expiry, positive_batches, record_batch_creation, today
from ..models import Batch, Item, User, StockMovement, StockReceiptCorrection, BatchExpiryUpdate
from ..schemas import BatchOut, ExpiryEntry, StockEntry, StockItem, StockReceiveIn, StockReceiptCorrectionIn, BatchExpiryUpdateIn
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
        expiry = payload.expiry_date if "expiry_date" in payload.model_fields_set else row["expiry_date"]
        if not row["expiry_enabled"]:
            expiry = row["expiry_date"]
        elif expiry is None:
            raise HTTPException(status_code=400, detail="启用效期的库存品必须填写效期")
        delta = ticks(payload.qty) - ticks(row["qty"])
        if delta and row["quantity_locked"]:
            raise HTTPException(status_code=409, detail="入库后已有确认盘点，数量请通过重新盘点核实；仍可更正效期和备注")
        remaining = ticks(row["remaining_qty"]) + delta
        if remaining < 0:
            raise HTTPException(status_code=409, detail="更正数量小于该批次已扣减数量，请先核实库存")
        note = payload.note.strip() or None if payload.note is not None else None
        if not delta and expiry == row["expiry_date"] and note == row["note"]:
            raise HTTPException(status_code=400, detail="没有需要保存的更正")
        correction = StockReceiptCorrection(batch_id=batch_id, old_qty=row["qty"], new_qty=payload.qty,
            old_expiry_date=row["expiry_date"], new_expiry_date=expiry,
            old_note=row["note"], new_note=note, reason=reason, actor_id=actor.id)
        db.add(correction)
        db.flush()
        db.execute(update(Batch).where(Batch.id == batch_id).values(
            qty=remaining/10, expiry_date=expiry, note=note))
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
        nearest = min((b.expiry_date for b in batches if b.expiry_date is not None), default=None) if it.expiry_enabled else None
        result.append(
            StockEntry(
                item=StockItem(
                    id=it.id,
                    name=it.name,
                    category=it.category,
                    unit=it.unit,
                    expiry_enabled=it.expiry_enabled,
                    shelf_life_days=it.shelf_life_days,
                    min_stock=it.min_stock,
                    daily_count_enabled=it.daily_count_enabled,
                    daily_quantity_required=it.daily_quantity_required,
                    weekly_count_enabled=it.weekly_count_enabled,
                    active=it.active,
                ),
                stock=stock,
                nearest_expiry=nearest,
                batch_count=len(batches),
                latest_received_at=max((b.received_at for b in batches), default=None),
                missing_expiry_count=sum(b.expiry_date is None for b in batches) if it.expiry_enabled else 0,
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
        item = db.get(Item, line.item_id)
        if item is None:
            raise HTTPException(status_code=400, detail=f"库存品不存在：{line.item_id}")

        if item.expiry_enabled and line.expiry_date is None:
            raise HTTPException(status_code=400, detail="启用效期的库存品必须填写效期")

    batches: list[Batch] = []
    try:
        for line in payload.items:
            batch = Batch(
                item_id=line.item_id,
                qty=line.qty,
                initial_qty=line.qty,
                expiry_date=line.expiry_date if db.get(Item, line.item_id).expiry_enabled else None,
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
            expiry_enabled=batch.item.expiry_enabled,
            days_to_expiry=days_to_expiry(batch.expiry_date) if batch.item.expiry_enabled else None,
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
        .where(Batch.qty > 0, Item.expiry_enabled.is_(True), Batch.expiry_date <= cutoff)
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
            expiry_enabled=b.item.expiry_enabled,
            days_to_expiry=days_to_expiry(b.expiry_date),
        )
        for b in batches
    ]


@router.patch("/batches/{batch_id}/expiry")
def fill_batch_expiry(batch_id: int, payload: BatchExpiryUpdateIn,
                      db: Session = Depends(get_db), actor: User = Depends(require_role("manager"))):
    batch = db.get(Batch, batch_id)
    if batch is None:
        raise HTTPException(status_code=404, detail="批次不存在")
    if not batch.item.expiry_enabled or batch.qty <= 0 or batch.expiry_date is not None:
        raise HTTPException(status_code=409, detail="仅可补填已启用效期且有库存的未知效期批次")
    result = db.execute(update(Batch).where(Batch.id == batch_id, Batch.expiry_date.is_(None), Batch.qty > 0).values(expiry_date=payload.expiry_date))
    if result.rowcount != 1:
        db.rollback()
        raise HTTPException(status_code=409, detail="批次已变化，请刷新后重试")
    db.add(BatchExpiryUpdate(batch_id=batch_id, old_expiry_date=None, new_expiry_date=payload.expiry_date, actor_id=actor.id))
    db.commit()
    return dict(id=batch.id, item_id=batch.item_id, expiry_date=batch.expiry_date)
