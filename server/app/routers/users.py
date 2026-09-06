"""用户管理（仅 admin）。"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..auth import hash_pin
from ..deps import get_db, require_role
from ..models import LoginAttempt, User
from ..schemas import UserCreate, UserOut, UserUpdate

router = APIRouter(prefix="/api/users", tags=["users"])


@router.get("", response_model=list[UserOut])
def list_users(db: Session = Depends(get_db), _: User = Depends(require_role("admin"))):
    users = db.scalars(select(User).order_by(User.id)).all()
    return [UserOut.model_validate(u) for u in users]


@router.post("", response_model=UserOut, status_code=201)
def create_user(
    payload: UserCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin")),
):
    exists = db.scalar(select(User).where(User.username == payload.username))
    if exists:
        raise HTTPException(status_code=409, detail="用户名已存在")
    user = User(
        username=payload.username,
        display_name=payload.display_name,
        pin_hash=hash_pin(payload.pin),
        role=payload.role,
        active=True,
        must_change_pin=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return UserOut.model_validate(user)


@router.patch("/{user_id}", response_model=UserOut)
def update_user(
    user_id: int,
    payload: UserUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_role("admin")),
):
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="用户不存在")
    if user.id == admin.id and (payload.active is False or payload.role is not None):
        raise HTTPException(status_code=400, detail="不能停用自己或修改自己的角色")
    data = payload.model_dump(exclude_unset=True)
    revoke = False
    old_username = user.username
    username_changed = False
    if data.get("username") is not None and data["username"] != user.username:
        exists = db.scalar(
            select(User).where(User.username == data["username"], User.id != user.id)
        )
        if exists:
            raise HTTPException(status_code=409, detail="用户名已存在")
        username_changed = True
        revoke = True
    if data.get("pin") is not None:
        user.pin_hash = hash_pin(data["pin"])
        user.must_change_pin = True
        revoke = True
    data.pop("pin", None)
    for key, value in data.items():
        if key in {"role", "active"} and value != getattr(user, key):
            revoke = True
        setattr(user, key, value)
    if revoke:
        user.token_version += 1
    if username_changed:
        db.execute(
            delete(LoginAttempt).where(
                LoginAttempt.username.in_([old_username, data["username"]])
            )
        )
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="用户名已存在") from exc
    db.refresh(user)
    return UserOut.model_validate(user)
