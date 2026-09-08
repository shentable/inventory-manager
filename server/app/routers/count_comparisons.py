"""两份独立每周盘点的预览、比对处置和库存落库。"""
from __future__ import annotations

import hashlib
import json
from datetime import timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ..database import utcnow
from ..quantity import QuantityInput
from ..deps import get_db, require_role
from ..inventory import deduct_fefo, item_stock, record_batch_creation, today
from ..models import (
    Batch,
    CountComparison,
    CountComparisonEntry,
    CountEntry,
    CountSession,
    Item,
    StockMovement,
    User,
)

router = APIRouter(prefix="/api/count-comparisons", tags=["count-comparisons"])


class PairIn(BaseModel):
    first_count_id: int = Field(ge=1)
    second_count_id: int = Field(ge=1)


class CorrectionIn(BaseModel):
    item_id: int = Field(ge=1)
    qty: QuantityInput = Field(ge=0)


class ConfirmIn(PairIn):
    comparison_token: str = Field(min_length=64, max_length=64)
    resolution: Literal[
        "no_difference",
        "normal_consumption",
        "trusted_first",
        "trusted_second",
        "manager_corrected",
        "recount_required",
    ]
    note: str | None = Field(default=None, max_length=255)
    corrections: list[CorrectionIn] = Field(default_factory=list)


def _name(db: Session, user_id: int | None) -> str:
    user = db.get(User, user_id) if user_id else None
    return user.display_name if user else ""


def _pair_state(db: Session, first_id: int, second_id: int, actor: User) -> dict:
    if first_id == second_id:
        raise HTTPException(status_code=400, detail="请选择两份不同的盘点记录")
    sessions = [db.get(CountSession, first_id), db.get(CountSession, second_id)]
    if any(session is None for session in sessions):
        raise HTTPException(status_code=404, detail="盘点记录不存在")
    first, second = sessions
    assert first is not None and second is not None
    for session in sessions:
        if session.count_type != "weekly":
            raise HTTPException(status_code=400, detail="只能比对每周盘点记录")
        if session.status != "submitted" or session.comparison_id is not None:
            raise HTTPException(
                status_code=409,
                detail={"code": "count_already_processed", "message": "盘点记录已处理"},
            )
        if session.created_at < utcnow() - timedelta(hours=72):
            raise HTTPException(status_code=400, detail="只能选择近72小时的盘点记录")
        creator = db.get(User, session.created_by)
        if creator is None or creator.role not in {"staff", "manager"}:
            raise HTTPException(status_code=400, detail="盘点提交人身份不符合要求")
    if first.created_by == second.created_by:
        raise HTTPException(status_code=400, detail="两份记录必须由不同人员独立提交")
    if actor.id in {first.created_by, second.created_by}:
        raise HTTPException(
            status_code=409,
            detail={"code": "self_review_not_allowed", "message": "确认人不能是任一盘点提交人"},
        )

    def entries(session_id: int) -> dict[int, CountEntry]:
        return {
            entry.item_id: entry
            for entry in db.scalars(
                select(CountEntry).where(CountEntry.session_id == session_id)
            ).all()
        }

    left, right = entries(first.id), entries(second.id)
    item_ids = sorted(set(left) | set(right))
    shared_ids = sorted(set(left) & set(right))
    if not shared_ids:
        raise HTTPException(
            status_code=400,
            detail={"code": "no_comparable_items", "message": "两份记录没有共同库存品，无法比对"},
        )
    rows = []
    token_rows = []
    for item_id in item_ids:
        item = db.get(Item, item_id)
        first_qty = left[item_id].qty_counted if item_id in left else None
        second_qty = right[item_id].qty_counted if item_id in right else None
        if first_qty is None:
            result = "missing_first"
        elif second_qty is None:
            result = "missing_second"
        elif first_qty == second_qty:
            result = "same"
        else:
            result = "different"
        current = item_stock(db, item_id)
        rows.append(
            {
                "item_id": item_id,
                "item_name": item.name if item else "?",
                "unit": item.unit if item else "",
                "first_qty": first_qty,
                "second_qty": second_qty,
                "current_qty": current,
                "result": result,
            }
        )
        token_rows.append([item_id, first_qty, second_qty, current])
    later = second if (second.created_at, second.id) > (first.created_at, first.id) else first
    token_data = {
        "sessions": [
            [first.id, first.status, first.created_at.isoformat(), first.comparison_id],
            [second.id, second.status, second.created_at.isoformat(), second.comparison_id],
        ],
        "rows": token_rows,
    }
    token = hashlib.sha256(
        json.dumps(token_data, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()
    return {
        "first": {
            "id": first.id,
            "created_by": first.created_by,
            "created_by_name": _name(db, first.created_by),
            "created_at": first.created_at,
            "note": first.note,
        },
        "second": {
            "id": second.id,
            "created_by": second.created_by,
            "created_by_name": _name(db, second.created_by),
            "created_at": second.created_at,
            "note": second.note,
        },
        "later_count_id": later.id,
        "shared_count": len(shared_ids),
        "different_count": sum(row["result"] == "different" for row in rows),
        "missing_count": sum(row["result"].startswith("missing_") for row in rows),
        "entries": rows,
        "comparison_token": token,
    }


def _comparison_detail(db: Session, comparison_id: int) -> dict:
    comparison = db.get(CountComparison, comparison_id)
    if comparison is None:
        raise HTTPException(status_code=404, detail="盘点比对不存在")
    rows = db.scalars(
        select(CountComparisonEntry)
        .where(CountComparisonEntry.comparison_id == comparison_id)
        .order_by(CountComparisonEntry.id)
    ).all()
    entries = []
    for row in rows:
        item = db.get(Item, row.item_id)
        entries.append(
            {
                "item_id": row.item_id,
                "item_name": item.name if item else "?",
                "unit": item.unit if item else "",
                "first_qty": row.first_qty,
                "second_qty": row.second_qty,
                "final_qty": row.final_qty,
                "result": row.result,
            }
        )
    return {
        "id": comparison.id,
        "first_count_id": comparison.first_session_id,
        "second_count_id": comparison.second_session_id,
        "resolution": comparison.resolution,
        "trusted_count_id": comparison.trusted_session_id,
        "note": comparison.note,
        "confirmed_by": comparison.confirmed_by,
        "confirmed_by_name": _name(db, comparison.confirmed_by),
        "confirmed_at": comparison.confirmed_at,
        "entries": entries,
    }


@router.post("/preview")
def preview_pair(
    payload: PairIn,
    db: Session = Depends(get_db),
    manager: User = Depends(require_role("manager")),
):
    return _pair_state(db, payload.first_count_id, payload.second_count_id, manager)


@router.post("", status_code=201)
def confirm_pair(
    payload: ConfirmIn,
    db: Session = Depends(get_db),
    manager: User = Depends(require_role("manager")),
):
    state = _pair_state(db, payload.first_count_id, payload.second_count_id, manager)
    if state["comparison_token"] != payload.comparison_token:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "count_comparison_changed",
                "message": "盘点记录或库存已变化，请重新比对",
            },
        )
    rows = state["entries"]
    shared = [row for row in rows if row["result"] in {"same", "different"}]
    different = [row for row in shared if row["result"] == "different"]
    note = (payload.note or "").strip() or None
    if payload.resolution == "no_difference" and different:
        raise HTTPException(status_code=400, detail="两份盘点存在差异，不能按无差异确认")
    if payload.resolution in {"normal_consumption", "trusted_first", "trusted_second", "manager_corrected"} and not different:
        raise HTTPException(status_code=400, detail="两份盘点没有差异，请直接确认")
    if payload.resolution in {"trusted_first", "trusted_second", "manager_corrected", "recount_required"} and not note:
        raise HTTPException(status_code=400, detail="该处理方式必须填写差异原因")

    corrections = {entry.item_id: entry.qty for entry in payload.corrections}
    if len(corrections) != len(payload.corrections):
        raise HTTPException(status_code=400, detail="更正条目重复")
    different_ids = {row["item_id"] for row in different}
    if payload.resolution == "manager_corrected" and set(corrections) != different_ids:
        raise HTTPException(status_code=400, detail="管理员更正必须填写全部差异项目")
    if payload.resolution != "manager_corrected" and corrections:
        raise HTTPException(status_code=400, detail="当前处理方式不接受更正数量")

    final: dict[int, float] = {}
    if payload.resolution != "recount_required":
        for row in shared:
            if row["result"] == "same" or payload.resolution == "no_difference":
                final[row["item_id"]] = row["first_qty"]
            elif payload.resolution == "normal_consumption":
                key = "first_qty" if state["later_count_id"] == state["first"]["id"] else "second_qty"
                final[row["item_id"]] = row[key]
            elif payload.resolution == "trusted_first":
                final[row["item_id"]] = row["first_qty"]
            elif payload.resolution == "trusted_second":
                final[row["item_id"]] = row["second_qty"]
            else:
                final[row["item_id"]] = corrections[row["item_id"]]

    comparison = CountComparison(
        first_session_id=state["first"]["id"],
        second_session_id=state["second"]["id"],
        resolution=payload.resolution,
        trusted_session_id=(
            state["first"]["id"] if payload.resolution == "trusted_first"
            else state["second"]["id"] if payload.resolution == "trusted_second"
            else None
        ),
        note=note,
        confirmed_by=manager.id,
        confirmed_at=utcnow(),
    )
    db.add(comparison)
    db.flush()
    # Refreshing a preview cannot make an observation predating stock changes current.
    for item_id in final:
        source_id = (
            state["first"]["id"] if payload.resolution == "trusted_first"
            else state["second"]["id"] if payload.resolution == "trusted_second"
            else state["later_count_id"]
        )
        source = state["first"] if source_id == state["first"]["id"] else state["second"]
        changed = db.scalar(select(StockMovement.id).where(
            StockMovement.item_id == item_id,
            StockMovement.created_at > source["created_at"],
        ).limit(1))
        if changed is not None:
            raise HTTPException(status_code=409, detail={
                "code": "count_observation_stale",
                "message": "采用的盘点记录之后已有库存变动，请重新盘点并提交后再比对",
            })

    next_status = "rejected" if payload.resolution == "recount_required" else "verified"
    reason = "paired_" + payload.resolution
    for count_id in (state["first"]["id"], state["second"]["id"]):
        claimed = db.execute(
            update(CountSession)
            .where(
                CountSession.id == count_id,
                CountSession.status == "submitted",
                CountSession.comparison_id.is_(None),
            )
            .values(
                status=next_status,
                comparison_id=comparison.id,
                verified_by=manager.id,
                verified_at=comparison.confirmed_at,
                review_reason=reason,
                review_note=note,
            )
        )
        if claimed.rowcount != 1:
            db.rollback()
            raise HTTPException(
                status_code=409,
                detail={"code": "count_comparison_changed", "message": "盘点记录已被处理"},
            )

    first_entries = {row.item_id: row for row in db.scalars(select(CountEntry).where(CountEntry.session_id == state["first"]["id"])).all()}
    second_entries = {row.item_id: row for row in db.scalars(select(CountEntry).where(CountEntry.session_id == state["second"]["id"])).all()}
    for row in rows:
        final_qty = final.get(row["item_id"])
        db.add(
            CountComparisonEntry(
                comparison_id=comparison.id,
                item_id=row["item_id"],
                first_qty=row["first_qty"],
                second_qty=row["second_qty"],
                final_qty=final_qty,
                result=row["result"],
            )
        )
        if final_qty is not None:
            if row["item_id"] in first_entries:
                first_entries[row["item_id"]].reviewed_qty = final_qty
            if row["item_id"] in second_entries:
                second_entries[row["item_id"]].reviewed_qty = final_qty
            current_qty = item_stock(db, row["item_id"])
            delta = round(final_qty - current_qty, 1)
            if delta < 0:
                deduct_fefo(
                    db, row["item_id"], -delta, actor_id=manager.id,
                    operation="count_shortage", reference_type="count_comparison",
                    reference_id=comparison.id,
                )
            elif delta > 0:
                item = db.get(Item, row["item_id"])
                batch = Batch(
                    item_id=row["item_id"], qty=delta, initial_qty=delta,
                    expiry_date=(today() + timedelta(days=item.shelf_life_days)).isoformat(),
                    source="adjust", note="双人盘点盘盈",
                )
                db.add(batch)
                db.flush()
                record_batch_creation(
                    db, batch, manager.id, "count_surplus", "count_comparison", comparison.id
                )
    db.commit()
    return _comparison_detail(db, comparison.id)


@router.get("/{comparison_id}")
def comparison_detail(
    comparison_id: int,
    db: Session = Depends(get_db),
    _manager: User = Depends(require_role("manager")),
):
    return _comparison_detail(db, comparison_id)
