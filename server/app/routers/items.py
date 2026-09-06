"""库存品管理（manager+ 写操作）与批次查看。"""
from datetime import timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..deps import get_db, require_role
from ..inventory import days_to_expiry, item_stock
from ..models import Batch, CountEntry, CountSession, Item, StockMovement, User
from ..schemas import BatchOut, ItemCreate, ItemOut, ItemUpdate, StockMovementOut

router = APIRouter(prefix="/api/items", tags=["items"])


def _serialize(db: Session, item: Item) -> ItemOut:
    last = db.execute(
        select(CountEntry, CountSession)
        .join(CountSession, CountSession.id == CountEntry.session_id)
        .where(
            CountEntry.item_id == item.id,
            or_(
                (CountSession.count_type == "daily") & (CountSession.status == "completed"),
                (CountSession.count_type == "weekly") & (CountSession.status == "verified"),
            ),
        )
        .order_by(CountSession.created_at.desc(), CountSession.id.desc(), CountEntry.id.desc())
        .limit(1)
    ).first()
    last_entry = last[0] if last else None
    last_session = last[1] if last else None
    last_qty = None
    if last_entry is not None and last_session is not None:
        if last_session.count_type == "daily":
            last_qty = last_entry.reported_qty
        else:
            last_qty = last_entry.reviewed_qty if last_entry.reviewed_qty is not None else last_entry.qty_counted
    last_at = last_session.created_at if last_session is not None else None
    if last_at is not None and last_at.tzinfo is None:
        last_at = last_at.replace(tzinfo=timezone.utc)
    return ItemOut(
        id=item.id,
        name=item.name,
        category=item.category,
        unit=item.unit,
        shelf_life_days=item.shelf_life_days,
        min_stock=item.min_stock,
        daily_count_enabled=item.daily_count_enabled,
        weekly_count_enabled=item.weekly_count_enabled,
        active=item.active,
        sort_order=item.sort_order,
        stock=item_stock(db, item.id),
        last_count_at=last_at,
        last_count_qty=last_qty,
        last_count_type=last_session.count_type if last_session is not None else None,
        last_count_enough=last_entry.is_enough if last_entry is not None else None,
    )


@router.get("", response_model=list[ItemOut])
def list_items(
    include_inactive: bool = Query(False),
    db: Session = Depends(get_db),
    _: User = Depends(require_role("staff")),
):
    stmt = select(Item)
    if not include_inactive:
        stmt = stmt.where(Item.active.is_(True))
    items = db.scalars(stmt.order_by(Item.sort_order, Item.id)).all()
    return [_serialize(db, it) for it in items]


@router.post("", response_model=ItemOut, status_code=201)
def create_item(
    payload: ItemCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("manager")),
):
    dup = db.scalar(select(Item).where(Item.name == payload.name))
    if dup:
        raise HTTPException(status_code=409, detail="库存品名称已存在")
    item = Item(**payload.model_dump())
    db.add(item)
    db.commit()
    db.refresh(item)
    return _serialize(db, item)


@router.patch("/{item_id}", response_model=ItemOut)
def update_item(
    item_id: int,
    payload: ItemUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("manager")),
):
    item = db.get(Item, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="库存品不存在")
    data = payload.model_dump(exclude_unset=True)
    if data.get("name") and data["name"] != item.name:
        dup = db.scalar(select(Item).where(Item.name == data["name"]))
        if dup:
            raise HTTPException(status_code=409, detail="库存品名称已存在")
    for key, value in data.items():
        setattr(item, key, value)
    db.commit()
    db.refresh(item)
    return _serialize(db, item)


@router.get("/{item_id}/batches", response_model=list[BatchOut])
def item_batches(
    item_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("staff")),
):
    item = db.get(Item, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="库存品不存在")
    batches = db.scalars(
        select(Batch)
        .where(Batch.item_id == item_id)
        .order_by(Batch.expiry_date, Batch.id)
    ).all()
    return [
        BatchOut(
            id=b.id,
            item_id=b.item_id,
            qty=b.qty,
            initial_qty=b.initial_qty,
            expiry_date=b.expiry_date,
            received_at=b.received_at,
            source=b.source,
            note=b.note,
            days_to_expiry=days_to_expiry(b.expiry_date),
        )
        for b in batches
    ]


@router.get("/{item_id}/movements", response_model=list[StockMovementOut])
def item_movements(
    item_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("manager")),
):
    if db.get(Item, item_id) is None:
        raise HTTPException(status_code=404, detail="库存品不存在")
    rows = db.scalars(
        select(StockMovement)
        .where(StockMovement.item_id == item_id)
        .order_by(StockMovement.id.desc())
    ).all()
    result = []
    for movement in rows:
        actor = db.get(User, movement.actor_id)
        result.append(
            StockMovementOut(
                id=movement.id,
                item_id=movement.item_id,
                batch_id=movement.batch_id,
                delta=movement.delta,
                operation=movement.operation,
                reference_type=movement.reference_type,
                reference_id=movement.reference_id,
                actor_id=movement.actor_id,
                actor_name=actor.display_name if actor else "?",
                created_at=movement.created_at,
            )
        )
    return result
