"""认证：登录 / 登录限流 / 首次改 PIN / 当前用户。"""
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..auth import create_token, hash_pin, verify_pin
from ..database import utcnow
from ..deps import get_current_user, get_db
from ..models import LoginAttempt, User
from ..schemas import ChangePinRequest, LoginOptionsResponse, LoginRequest, LoginResponse, UserOut

router = APIRouter(prefix="/api/auth", tags=["auth"])

LOGIN_WINDOW = timedelta(minutes=10)
LOGIN_LOCK = timedelta(minutes=15)
LOGIN_MAX_FAILURES = 5


def _scope(request: Request, username: str) -> tuple[str, str]:
    source_ip = request.client.host if request.client else "unknown"
    return username.strip().lower(), source_ip


def _attempt(db: Session, username: str, source_ip: str) -> LoginAttempt | None:
    return db.scalar(
        select(LoginAttempt).where(
            LoginAttempt.username == username, LoginAttempt.source_ip == source_ip
        )
    )


def _raise_rate_limited(seconds: int) -> None:
    retry = max(1, seconds)
    raise HTTPException(
        status_code=429,
        detail="登录尝试过多，请稍后再试",
        headers={"Retry-After": str(retry)},
    )


def _record_failure(db: Session, username: str, source_ip: str) -> None:
    now = utcnow()
    attempt = _attempt(db, username, source_ip)
    if attempt is None:
        attempt = LoginAttempt(
            username=username,
            source_ip=source_ip,
            failed_count=1,
            window_started_at=now,
        )
        db.add(attempt)
    elif now - attempt.window_started_at > LOGIN_WINDOW:
        attempt.failed_count = 1
        attempt.window_started_at = now
        attempt.locked_until = None
    else:
        attempt.failed_count += 1
    if attempt.failed_count >= LOGIN_MAX_FAILURES:
        attempt.locked_until = now + LOGIN_LOCK
    try:
        db.commit()
    except IntegrityError:
        # 同一账号/IP 首次并发失败时，唯一约束会让一个插入失败；回读后正常累计。
        db.rollback()
        _record_failure(db, username, source_ip)
        return
    if attempt.locked_until:
        _raise_rate_limited(int((attempt.locked_until - now).total_seconds()))


@router.post("/login", response_model=LoginResponse)
def login(payload: LoginRequest, request: Request, db: Session = Depends(get_db)):
    username, source_ip = _scope(request, payload.username)
    attempt = _attempt(db, username, source_ip)
    now = utcnow()
    if attempt and attempt.locked_until and attempt.locked_until > now:
        _raise_rate_limited(int((attempt.locked_until - now).total_seconds()))

    user = db.scalar(select(User).where(User.username == username))
    if user is None or not user.active or not verify_pin(payload.pin, user.pin_hash):
        _record_failure(db, username, source_ip)
        raise HTTPException(status_code=401, detail="用户名或 PIN 错误")
    db.execute(
        delete(LoginAttempt).where(
            LoginAttempt.username == username, LoginAttempt.source_ip == source_ip
        )
    )
    db.commit()
    return LoginResponse(
        token=create_token(user.id, user.token_version), user=UserOut.model_validate(user)
    )


@router.get("/login-options", response_model=LoginOptionsResponse)
def login_options(db: Session = Depends(get_db)):
    """无需登录：供登录页点选用户。只返回启用中的用户。"""
    users = db.scalars(select(User).where(User.active.is_(True)).order_by(User.id)).all()
    return LoginOptionsResponse(users=[UserOut.model_validate(u) for u in users])


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return UserOut.model_validate(user)


@router.post("/change-pin", response_model=LoginResponse)
def change_pin(
    payload: ChangePinRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    current = db.get(User, user.id)
    if current is None or not verify_pin(payload.current_pin, current.pin_hash):
        raise HTTPException(status_code=400, detail="当前 PIN 错误")
    if payload.current_pin == payload.new_pin:
        raise HTTPException(status_code=400, detail="新 PIN 不能与当前 PIN 相同")
    current.pin_hash = hash_pin(payload.new_pin)
    current.must_change_pin = False
    current.token_version += 1
    db.commit()
    db.refresh(current)
    return LoginResponse(
        token=create_token(current.id, current.token_version),
        user=UserOut.model_validate(current),
    )
