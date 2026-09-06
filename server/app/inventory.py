"""库存核心逻辑：FEFO 扣减、库存汇总、效期计算。"""
from datetime import date, datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from . import models


STORE_TIMEZONE = timezone(timedelta(hours=8))


def today() -> date:
    """门店业务日期固定为 UTC+8，不受 Docker/宿主机时区影响。"""
    return datetime.now(STORE_TIMEZONE).date()


def days_to_expiry(expiry_date: str, ref: date | None = None) -> int:
    """剩余天数 = expiry_date - 今天（可为负数=已过期）。"""
    return (date.fromisoformat(expiry_date) - (ref or today())).days


def item_stock(db: Session, item_id: int) -> int:
    total = db.scalar(
        select(func.coalesce(func.sum(models.Batch.qty), 0)).where(
            models.Batch.item_id == item_id
        )
    )
    return int(total or 0)


def positive_batches(db: Session, item_id: int) -> list[models.Batch]:
    """qty>0 的批次，按效期升序（FEFO 顺序）。"""
    return list(
        db.scalars(
            select(models.Batch)
            .where(models.Batch.item_id == item_id, models.Batch.qty > 0)
            .order_by(models.Batch.expiry_date, models.Batch.id)
        )
    )


def deduct_fefo(
    db: Session,
    item_id: int,
    qty: int,
    batch_id: int | None = None,
    actor_id: int | None = None,
    operation: str = "deduct",
    reference_type: str = "manual",
    reference_id: int | None = None,
) -> None:
    """按 FEFO（或指定批次）扣减库存。

    - 数量不足/批次不匹配 → HTTP 400（在任何变更发生前抛出，调用方事务回滚）。
    - 每次实际扣减写入不可变 StockMovement，不覆盖批次来源备注。
    """
    if qty <= 0:
        raise HTTPException(status_code=400, detail="扣减数量必须大于 0")

    if batch_id is not None:
        batch = db.get(models.Batch, batch_id)
        if batch is None or batch.item_id != item_id:
            raise HTTPException(status_code=400, detail="指定批次不存在或不属于该库存品")
        if batch.qty < qty:
            raise HTTPException(status_code=400, detail="批次库存不足")
        result = db.execute(
            update(models.Batch)
            .where(models.Batch.id == batch.id, models.Batch.qty >= qty)
            .values(qty=models.Batch.qty - qty)
        )
        if result.rowcount != 1:
            raise HTTPException(status_code=409, detail="库存已变化，请重试")
        _record_movement(db, batch, -qty, actor_id, operation, reference_type, reference_id)
        return

    batches = positive_batches(db, item_id)
    if sum(b.qty for b in batches) < qty:
        raise HTTPException(status_code=400, detail="库存不足，无法扣减")

    remaining = qty
    for b in batches:
        if remaining <= 0:
            break
        take = min(b.qty, remaining)
        result = db.execute(
            update(models.Batch)
            .where(models.Batch.id == b.id, models.Batch.qty >= take)
            .values(qty=models.Batch.qty - take)
        )
        if result.rowcount != 1:
            raise HTTPException(status_code=409, detail="库存已变化，请重试")
        _record_movement(db, b, -take, actor_id, operation, reference_type, reference_id)
        remaining -= take


def _record_movement(
    db: Session,
    batch: models.Batch,
    delta: int,
    actor_id: int | None,
    operation: str,
    reference_type: str,
    reference_id: int | None,
) -> None:
    if actor_id is None:
        raise RuntimeError("库存变动必须记录操作人")
    db.add(
        models.StockMovement(
            item_id=batch.item_id,
            batch_id=batch.id,
            delta=delta,
            operation=operation,
            reference_type=reference_type,
            reference_id=reference_id,
            actor_id=actor_id,
        )
    )


def record_batch_creation(
    db: Session,
    batch: models.Batch,
    actor_id: int,
    operation: str,
    reference_type: str,
    reference_id: int | None,
) -> None:
    """批次 flush 后记录正向入库流水。"""
    if batch.id is None:
        db.flush()
    _record_movement(
        db, batch, batch.initial_qty, actor_id, operation, reference_type, reference_id
    )
