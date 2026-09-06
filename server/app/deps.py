"""依赖注入：DB 会话、当前用户、角色校验。"""
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from .auth import decode_token
from .database import SessionLocal
from .models import User

bearer_scheme = HTTPBearer(auto_error=False)

ROLE_LEVELS = {"staff": 0, "manager": 1, "admin": 2}


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    if credentials is None:
        raise HTTPException(status_code=401, detail="未登录")
    claims = decode_token(credentials.credentials)
    if claims is None:
        raise HTTPException(status_code=401, detail="token 无效或已过期")
    user_id, token_version = claims
    user = db.get(User, user_id)
    if user is None or not user.active or user.token_version != token_version:
        raise HTTPException(status_code=401, detail="用户不存在、已停用或会话已撤销")
    return user


def require_role(min_role: str):
    """返回一个依赖：要求当前用户角色 >= min_role（staff < manager < admin）。"""

    def checker(user: User = Depends(get_current_user)) -> User:
        if user.must_change_pin:
            raise HTTPException(
                status_code=403,
                detail={"code": "pin_change_required", "message": "首次使用前请修改 PIN"},
            )
        if ROLE_LEVELS.get(user.role, -1) < ROLE_LEVELS[min_role]:
            raise HTTPException(status_code=403, detail="权限不足")
        return user

    return checker
