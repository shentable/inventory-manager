"""无需认证的轻量健康检查，供容器与 Android 组网探测。"""

import os

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..deps import get_db
from ..models import StoreMeta

router = APIRouter(prefix="/api", tags=["health"])


API_VERSION = "1"
DB_SCHEMA = "20260904_08"


@router.get("/health")
def health(db: Session = Depends(get_db)) -> dict[str, str]:
    db.execute(text("SELECT 1"))
    meta = db.get(StoreMeta, 1)
    return {
        "status": "ok",
        "api_version": API_VERSION,
        "db_schema": meta.schema_version if meta else DB_SCHEMA,
        "store_id": meta.store_id if meta else "uninitialized",
        "backend_kind": "python",
        "app_version": os.environ.get("APP_VERSION", "dev"),
    }
