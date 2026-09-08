"""Manager-only consumption estimates, using the SQL also embedded by Rust."""
import json
from pathlib import Path

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..database import utcnow
from ..deps import get_db, require_role
from ..models import User

router = APIRouter(prefix="/api/consumption", tags=["consumption"])
SQL = (Path(__file__).resolve().parents[1] / "consumption.sql").read_text()


@router.get("")
def consumption(
    days: int = Query(56, ge=7, le=180),
    lead_days: int = Query(2, ge=0, le=30),
    coverage_days: int = Query(7, ge=1, le=30),
    db: Session = Depends(get_db),
    _: User = Depends(require_role("manager")),
):
    as_of = utcnow()
    params = dict(as_of=as_of.strftime("%Y-%m-%d %H:%M:%S.%f"), days=days,
                  lead_days=lead_days, coverage_days=coverage_days)
    rows = [json.loads(row[0]) for row in db.execute(text(SQL), params)]
    return {
        "as_of": as_of.isoformat() + "Z", "days": days, "lead_days": lead_days,
        "coverage_days": coverage_days, "items": rows,
    }
