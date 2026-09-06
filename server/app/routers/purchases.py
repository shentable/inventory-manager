"""采购（manager+）：下单 / 列表 / 入库生成批次 / 取消。"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ..database import utcnow
from ..deps import get_db, require_role
from ..inventory import record_batch_creation
from ..models import Batch, Item, Purchase, PurchaseItem, User
from ..schemas import PurchaseCreate, PurchaseLineOut, PurchaseOut, PurchaseReceiveIn

router = APIRouter(prefix="/api/purchases", tags=["purchases"])


def _serialize(db: Session, p: Purchase) -> PurchaseOut:
    creator = db.get(User, p.created_by)
    lines = []
    for pi in p.items:
        item = db.get(Item, pi.item_id)
        lines.append(
            PurchaseLineOut(
                id=pi.id,
                item_id=pi.item_id,
                item_name=item.name if item else "?",
                unit=item.unit if item else "",
                qty=pi.qty,
            )
        )
    return PurchaseOut(
        id=p.id,
        status=p.status,
        note=p.note,
        created_by=p.created_by,
        created_by_name=creator.display_name if creator else "",
        created_at=p.created_at,
        received_at=p.received_at,
        items=lines,
    )


@router.post("", response_model=PurchaseOut, status_code=201)
def create_purchase(
    payload: PurchaseCreate,
    db: Session = Depends(get_db),
    manager: User = Depends(require_role("manager")),
):
    seen = set()
    for line in payload.items:
        if line.item_id in seen:
            raise HTTPException(status_code=400, detail="采购条目重复")
        seen.add(line.item_id)
        if db.get(Item, line.item_id) is None:
            raise HTTPException(status_code=400, detail=f"库存品不存在：{line.item_id}")
    purchase = Purchase(status="ordered", created_by=manager.id, note=payload.note)
    db.add(purchase)
    db.flush()
    for line in payload.items:
        db.add(PurchaseItem(purchase_id=purchase.id, item_id=line.item_id, qty=line.qty))
    db.commit()
    return _serialize(db, purchase)


@router.get("", response_model=list[PurchaseOut])
def list_purchases(
    status: str | None = Query(None),
    db: Session = Depends(get_db),
    _: User = Depends(require_role("manager")),
):
    stmt = select(Purchase)
    if status:
        stmt = stmt.where(Purchase.status == status)
    purchases = db.scalars(stmt.order_by(Purchase.id.desc())).all()
    return [_serialize(db, p) for p in purchases]


@router.post("/{purchase_id}/receive", response_model=PurchaseOut)
def receive_purchase(
    purchase_id: int,
    payload: PurchaseReceiveIn,
    db: Session = Depends(get_db),
    manager: User = Depends(require_role("manager")),
):
    """入库：逐行登记效期，生成 source=purchase 批次。必须覆盖采购单全部行。"""
    purchase = db.get(Purchase, purchase_id)
    if purchase is None:
        raise HTTPException(status_code=404, detail="采购单不存在")
    if purchase.status != "ordered":
        raise HTTPException(status_code=409, detail="该采购单已处理")
    provided = {line.purchase_item_id: line.expiry_date for line in payload.items}
    own_ids = {pi.id for pi in purchase.items}
    if set(provided.keys()) != own_ids:
        raise HTTPException(status_code=400, detail="入库行必须覆盖采购单全部条目")
    try:
        claimed = db.execute(
            update(Purchase)
            .where(Purchase.id == purchase_id, Purchase.status == "ordered")
            .values(
                status="received",
                received_at=utcnow(),
                handled_by=manager.id,
                handled_at=utcnow(),
            )
        )
        if claimed.rowcount != 1:
            db.rollback()
            raise HTTPException(status_code=409, detail="该采购单已处理")
        for pi in purchase.items:
            batch = Batch(
                item_id=pi.item_id,
                qty=pi.qty,
                initial_qty=pi.qty,
                expiry_date=provided[pi.id],
                source="purchase",
                note=f"采购单 #{purchase.id}",
            )
            db.add(batch)
            db.flush()
            record_batch_creation(
                db, batch, manager.id, "purchase_receive", "purchase", purchase_id
            )
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    return _serialize(db, purchase)


@router.post("/{purchase_id}/cancel", response_model=PurchaseOut)
def cancel_purchase(
    purchase_id: int,
    db: Session = Depends(get_db),
    manager: User = Depends(require_role("manager")),
):
    purchase = db.get(Purchase, purchase_id)
    if purchase is None:
        raise HTTPException(status_code=404, detail="采购单不存在")
    if purchase.status != "ordered":
        raise HTTPException(status_code=409, detail="该采购单已处理")
    result = db.execute(
        update(Purchase)
        .where(Purchase.id == purchase_id, Purchase.status == "ordered")
        .values(
            status="cancelled",
            handled_by=manager.id,
            handled_at=utcnow(),
        )
    )
    if result.rowcount != 1:
        db.rollback()
        raise HTTPException(status_code=409, detail="该采购单已处理")
    db.commit()
    return _serialize(db, purchase)
