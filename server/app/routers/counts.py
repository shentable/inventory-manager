"""每日盘点记录够/不够；每周实数盘点由两人独立提交后配对确认。"""
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from ..database import utcnow
from ..deps import get_db, require_role
from ..inventory import item_stock, today
from ..models import CountEntry, CountSession, Item, User
from ..schemas import CountCreate, CountDetailOut, CountEditIn, CountEntryOut, CountOut

router = APIRouter(prefix="/api/counts", tags=["counts"])


def _user_name(db: Session, user_id: int | None) -> str:
    if user_id is None:
        return ""
    u = db.get(User, user_id)
    return u.display_name if u else ""


def _detail(db: Session, count_id: int) -> CountDetailOut:
    session = db.get(CountSession, count_id)
    entries = db.scalars(
        select(CountEntry).where(CountEntry.session_id == count_id).order_by(CountEntry.id)
    ).all()
    out_entries = []
    for e in entries:
        item = db.get(Item, e.item_id)
        out_entries.append(
            CountEntryOut(
                id=e.id,
                item_id=e.item_id,
                item_name=item.name if item else "?",
                unit=item.unit if item else "",
                expected_qty=e.expected_qty,
                qty_counted=e.qty_counted,
                diff=e.qty_counted - e.expected_qty,
                is_enough=e.is_enough,
                reported_qty=e.reported_qty,
                reviewed_qty=e.reviewed_qty,
                review_diff=(e.reviewed_qty - e.qty_counted) if e.reviewed_qty is not None else None,
                current_qty=item_stock(db, e.item_id),
            )
        )
    return CountDetailOut(
        id=session.id,
        status=session.status,
        count_type=session.count_type,
        business_date=session.business_date,
        note=session.note,
        created_by=session.created_by,
        created_by_name=_user_name(db, session.created_by),
        created_at=session.created_at,
        verified_by=session.verified_by,
        verified_by_name=_user_name(db, session.verified_by),
        verified_at=session.verified_at,
        review_reason=session.review_reason,
        review_note=session.review_note,
        comparison_id=session.comparison_id,
        entries=out_entries,
    )


@router.post("", response_model=CountDetailOut, status_code=201)
def create_count(
    payload: CountCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("staff")),
):
    if payload.count_type == "weekly" and user.role == "admin":
        raise HTTPException(status_code=403, detail="管理员不提交每周盘点")
    seen = set()
    for e in payload.entries:
        if e.item_id in seen:
            raise HTTPException(status_code=400, detail="盘点条目重复")
        seen.add(e.item_id)
        item = db.get(Item, e.item_id)
        if item is None:
            raise HTTPException(status_code=400, detail=f"库存品不存在：{e.item_id}")
        if payload.count_type == "daily" and not item.daily_count_enabled:
            raise HTTPException(status_code=400, detail=f"库存品未启用每日盘点：{item.name}")
        if payload.count_type == "weekly" and not item.weekly_count_enabled:
            raise HTTPException(status_code=400, detail=f"库存品未启用每周盘点：{item.name}")
        if payload.count_type == "daily" and e.enough is None:
            raise HTTPException(status_code=400, detail="每日盘点必须确认够或不够")
        if payload.count_type == "daily" and e.enough is False and e.qty is None:
            raise HTTPException(status_code=400, detail="每日盘点选择不够时必须填写现场数量")
        if payload.count_type == "weekly" and e.qty is None:
            raise HTTPException(status_code=400, detail="每周盘点必须填写盘点数量")
        if payload.count_type == "weekly" and e.enough is not None:
            raise HTTPException(status_code=400, detail="每周盘点必须填写实际数量")
    session = None
    business_date = today().isoformat() if payload.count_type == "daily" else None
    if payload.count_type == "daily":
        session = db.scalar(
            select(CountSession).where(
                CountSession.count_type == "daily",
                CountSession.business_date == business_date,
                CountSession.status == "completed",
            )
        )
        if session is not None and not payload.overwrite_daily:
            previous = {
                entry.item_id: (entry.is_enough, entry.reported_qty)
                for entry in session.entries
            }
            incoming = {entry.item_id: (entry.enough, entry.qty) for entry in payload.entries}
            changes = []
            for item_id in sorted(set(previous) | set(incoming)):
                old = previous.get(item_id, (None, None))
                new = incoming.get(item_id, (None, None))
                if old != new:
                    item = db.get(Item, item_id)
                    changes.append(
                        {
                            "item_id": item_id,
                            "item_name": item.name if item else f"商品#{item_id}",
                            "previous_enough": old[0],
                            "new_enough": new[0],
                            "previous_qty": old[1],
                            "new_qty": new[1],
                        }
                    )
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "daily_count_exists",
                    "message": "今日已有每日盘点结果",
                    "count_id": session.id,
                    "changes": changes,
                    "unchanged_count": len(payload.entries) - len(changes),
                },
            )
    if session is None:
        session = CountSession(
            count_type=payload.count_type,
            business_date=business_date,
            status="completed" if payload.count_type == "daily" else "submitted",
            created_by=user.id,
            note=payload.note,
        )
        db.add(session)
        db.flush()
    else:
        db.execute(delete(CountEntry).where(CountEntry.session_id == session.id))
        session.created_by = user.id
        session.created_at = utcnow()
        session.note = payload.note
    for e in payload.entries:
        expected = item_stock(db, e.item_id)
        db.add(
            CountEntry(
                session_id=session.id,
                item_id=e.item_id,
                qty_counted=expected if payload.count_type == "daily" else e.qty,
                expected_qty=expected,  # 提交时快照
                is_enough=e.enough if payload.count_type == "daily" else None,
                reported_qty=e.qty if payload.count_type == "daily" else None,
            )
        )
    db.commit()
    return _detail(db, session.id)


@router.get("", response_model=list[CountOut])
def list_counts(
    status: str | None = Query(None),
    count_type: str | None = Query(None, pattern=r"^(daily|weekly)$"),
    days: int | None = Query(None, ge=1, le=30),
    db: Session = Depends(get_db),
    user: User = Depends(require_role("staff")),
):
    stmt = select(CountSession)
    if status:
        stmt = stmt.where(CountSession.status == status)
    if count_type:
        stmt = stmt.where(CountSession.count_type == count_type)
    if user.role == "staff":
        stmt = stmt.where(
            (CountSession.count_type != "weekly") | (CountSession.created_by == user.id)
        )
    if days:
        stmt = stmt.where(CountSession.created_at >= utcnow() - timedelta(days=days))
    sessions = db.scalars(stmt.order_by(CountSession.id.desc())).all()
    result = []
    for s in sessions:
        n = db.scalar(
            select(func.count(CountEntry.id)).where(CountEntry.session_id == s.id)
        ) or 0
        enough = db.scalar(
            select(func.count(CountEntry.id)).where(
                CountEntry.session_id == s.id, CountEntry.is_enough.is_(True)
            )
        ) or 0
        not_enough = db.scalar(
            select(func.count(CountEntry.id)).where(
                CountEntry.session_id == s.id, CountEntry.is_enough.is_(False)
            )
        ) or 0
        quantity_count = db.scalar(
            select(func.count(CountEntry.id)).where(
                CountEntry.session_id == s.id, CountEntry.reported_qty.is_not(None)
            )
        ) or 0
        difference_count = db.scalar(
            select(func.count(CountEntry.id)).where(
                CountEntry.session_id == s.id,
                CountEntry.reviewed_qty.is_not(None),
                CountEntry.reviewed_qty != CountEntry.qty_counted,
            )
        ) or 0
        result.append(
            CountOut(
                id=s.id,
                status=s.status,
                count_type=s.count_type,
                business_date=s.business_date,
                note=s.note,
                created_by=s.created_by,
                created_by_name=_user_name(db, s.created_by),
                created_at=s.created_at,
                verified_by=s.verified_by,
                verified_by_name=_user_name(db, s.verified_by),
                verified_at=s.verified_at,
                review_reason=s.review_reason,
                review_note=s.review_note,
                comparison_id=s.comparison_id,
                entries_count=int(n),
                difference_count=int(difference_count),
                enough_count=int(enough),
                not_enough_count=int(not_enough),
                quantity_count=int(quantity_count),
            )
        )
    return result


@router.get("/{count_id}", response_model=CountDetailOut)
def count_detail(
    count_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("staff")),
):
    session = db.get(CountSession, count_id)
    if session is None:
        raise HTTPException(status_code=404, detail="盘点单不存在")
    if session.count_type == "weekly" and user.role == "staff" and session.created_by != user.id:
        raise HTTPException(status_code=403, detail="只能查看自己提交的盘点单")
    return _detail(db, count_id)


@router.patch("/{count_id}", response_model=CountDetailOut)
def edit_count(
    count_id: int,
    payload: CountEditIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("staff")),
):
    """原提交人可在核对前修正每周盘点，条件更新与核对互斥。"""
    session = db.get(CountSession, count_id)
    if session is None:
        raise HTTPException(status_code=404, detail="盘点单不存在")
    if session.count_type != "weekly":
        raise HTTPException(status_code=409, detail="每日盘点不支持此方式修改")
    if session.created_by != user.id:
        raise HTTPException(status_code=403, detail="只能修改自己提交的盘点单")
    if session.status != "submitted":
        raise HTTPException(status_code=409, detail="盘点单已核对或驳回，不能修改")

    existing = {entry.item_id: entry for entry in session.entries}
    incoming = {}
    for entry in payload.entries:
        if entry.qty is None:
            raise HTTPException(status_code=400, detail="每周盘点必须填写盘点数量")
        if entry.enough is not None:
            raise HTTPException(status_code=400, detail="每周盘点必须填写实际数量")
        if entry.item_id in incoming:
            raise HTTPException(status_code=400, detail="盘点条目重复")
        incoming[entry.item_id] = entry.qty
    if not set(existing).issubset(incoming):
        raise HTTPException(status_code=400, detail="修改不能删除原盘点条目")
    added_ids = set(incoming) - set(existing)
    for item_id in added_ids:
        item = db.get(Item, item_id)
        if item is None or not item.active:
            raise HTTPException(status_code=400, detail=f"库存品不存在或已停用：{item_id}")
        if not item.weekly_count_enabled:
            raise HTTPException(status_code=400, detail=f"库存品未启用每周盘点：{item.name}")

    result = db.execute(
        update(CountSession)
        .where(
            CountSession.id == count_id,
            CountSession.status == "submitted",
            CountSession.created_by == user.id,
        )
        .values(created_at=utcnow(), note=(payload.note or "").strip() or None)
    )
    if result.rowcount != 1:
        db.rollback()
        raise HTTPException(status_code=409, detail="盘点单状态已变化，请刷新")
    for item_id, qty in incoming.items():
        expected = item_stock(db, item_id)
        if item_id in existing:
            existing[item_id].qty_counted = qty
            existing[item_id].expected_qty = expected
            existing[item_id].reviewed_qty = None
        else:
            db.add(
                CountEntry(
                    session_id=count_id,
                    item_id=item_id,
                    qty_counted=qty,
                    expected_qty=expected,
                    is_enough=None,
                    reported_qty=None,
                    reviewed_qty=None,
                )
            )
    db.commit()
    return _detail(db, count_id)


@router.post("/{count_id}/verify", response_model=CountDetailOut)
def verify_count(
    count_id: int,
    _payload: dict | None = None,
    _manager: User = Depends(require_role("manager")),
):
    """旧版单据核对入口已停用，防止缓存客户端绕过双记录流程。"""
    raise HTTPException(
        status_code=409,
        detail={
            "code": "pair_verification_required",
            "message": "每周盘点必须选择两份独立记录进行比对确认",
        },
    )


@router.post("/{count_id}/reject", response_model=CountDetailOut)
def reject_count(
    count_id: int,
    _: User = Depends(require_role("manager")),
):
    raise HTTPException(
        status_code=409,
        detail={
            "code": "pair_verification_required",
            "message": "请在双人比对中同时退回两份记录重盘",
        },
    )
