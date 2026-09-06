"""报损：登记（可附描述与图片）、确认/驳回。"""
import base64
import binascii

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ..database import utcnow
from ..deps import get_db, require_role
from ..inventory import deduct_fefo
from ..models import Batch, Item, User, WasteRecord
from ..schemas import WasteCreate, WasteOut

router = APIRouter(prefix="/api/waste", tags=["waste"])
PHOTO_MIMES = {"image/jpeg", "image/png", "image/webp"}
MAX_PHOTO_BYTES = 1_500_000


def _parse_photo(data_url: str | None) -> tuple[str | None, str | None]:
    if not data_url:
        return None, None
    try:
        header, encoded = data_url.split(",", 1)
        mime = header.removeprefix("data:").removesuffix(";base64")
        if header != f"data:{mime};base64" or mime not in PHOTO_MIMES:
            raise ValueError
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise HTTPException(status_code=400, detail="报损图片格式无效") from None
    if len(raw) > MAX_PHOTO_BYTES:
        raise HTTPException(status_code=400, detail="报损图片不能超过 1.5MB")
    return mime, encoded


def _serialize(db: Session, w: WasteRecord) -> WasteOut:
    item = db.get(Item, w.item_id)
    batch = db.get(Batch, w.batch_id) if w.batch_id else None
    reporter = db.get(User, w.reported_by)
    return WasteOut(
        id=w.id,
        item_id=w.item_id,
        item_name=item.name if item else "?",
        unit=item.unit if item else "",
        batch_id=w.batch_id,
        batch_expiry_date=batch.expiry_date if batch else None,
        qty=w.qty,
        reason=w.reason,
        description=w.description,
        has_photo=bool(w.photo_base64),
        status=w.status,
        reported_by=w.reported_by,
        reported_by_name=reporter.display_name if reporter else "",
        reported_at=w.reported_at,
        confirmed_by=w.confirmed_by,
        confirmed_at=w.confirmed_at,
    )


@router.post("", response_model=WasteOut, status_code=201)
def create_waste(
    payload: WasteCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("staff")),
):
    item = db.get(Item, payload.item_id)
    if item is None:
        raise HTTPException(status_code=400, detail="库存品不存在")
    if payload.batch_id is not None:
        batch = db.get(Batch, payload.batch_id)
        if batch is None or batch.item_id != payload.item_id:
            raise HTTPException(status_code=400, detail="指定批次不存在或不属于该库存品")
    photo_mime, photo_base64 = _parse_photo(payload.photo_data)
    description = (payload.description or "").strip() or None
    record = WasteRecord(
        item_id=payload.item_id,
        batch_id=payload.batch_id,
        qty=payload.qty,
        reason=payload.reason,
        description=description,
        photo_mime=photo_mime,
        photo_base64=photo_base64,
        status="pending",
        reported_by=user.id,
        reported_at=utcnow(),
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return _serialize(db, record)


@router.get("", response_model=list[WasteOut])
def list_waste(
    status: str | None = Query(None),
    db: Session = Depends(get_db),
    _: User = Depends(require_role("staff")),
):
    stmt = select(WasteRecord)
    if status:
        stmt = stmt.where(WasteRecord.status == status)
    records = db.scalars(stmt.order_by(WasteRecord.id.desc())).all()
    return [_serialize(db, w) for w in records]


@router.get("/{waste_id}/photo")
def waste_photo(
    waste_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("staff")),
):
    record = db.get(WasteRecord, waste_id)
    if record is None or not record.photo_base64 or not record.photo_mime:
        raise HTTPException(status_code=404, detail="报损图片不存在")
    try:
        content = base64.b64decode(record.photo_base64, validate=True)
    except binascii.Error:
        raise HTTPException(status_code=500, detail="报损图片损坏") from None
    return Response(content=content, media_type=record.photo_mime)


@router.post("/{waste_id}/confirm", response_model=WasteOut)
def confirm_waste(
    waste_id: int,
    db: Session = Depends(get_db),
    manager: User = Depends(require_role("manager")),
):
    """确认报损：FEFO（或指定批次）扣减，事务内完成，失败回滚。"""
    record = db.get(WasteRecord, waste_id)
    if record is None:
        raise HTTPException(status_code=404, detail="报损记录不存在")
    if record.status != "pending":
        raise HTTPException(status_code=409, detail="该报损记录已处理")
    try:
        claimed = db.execute(
            update(WasteRecord)
            .where(WasteRecord.id == waste_id, WasteRecord.status == "pending")
            .values(status="confirmed", confirmed_by=manager.id, confirmed_at=utcnow())
        )
        if claimed.rowcount != 1:
            db.rollback()
            raise HTTPException(status_code=409, detail="该报损记录已处理")
        deduct_fefo(
            db,
            record.item_id,
            record.qty,
            batch_id=record.batch_id,
            actor_id=manager.id,
            operation="waste",
            reference_type="waste",
            reference_id=waste_id,
        )
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    return _serialize(db, record)


@router.post("/{waste_id}/reject", response_model=WasteOut)
def reject_waste(
    waste_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("manager")),
):
    record = db.get(WasteRecord, waste_id)
    if record is None:
        raise HTTPException(status_code=404, detail="报损记录不存在")
    if record.status != "pending":
        raise HTTPException(status_code=409, detail="该报损记录已处理")
    result = db.execute(
        update(WasteRecord)
        .where(WasteRecord.id == waste_id, WasteRecord.status == "pending")
        .values(status="rejected", confirmed_by=_.id, confirmed_at=utcnow())
    )
    if result.rowcount != 1:
        db.rollback()
        raise HTTPException(status_code=409, detail="该报损记录已处理")
    db.commit()
    return _serialize(db, record)
