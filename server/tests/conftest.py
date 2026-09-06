"""测试环境与公共夹具。

- 使用临时文件库（DATABASE_URL，与 Docker 部署同一机制），关闭启动自动种子（AUTO_SEED=0），测试自建数据
- 每个测试前 drop_all + create_all，保证隔离
"""
import os
import tempfile

_tmpdir = tempfile.mkdtemp(prefix="sandwich_test_")
os.environ["DATABASE_URL"] = f"sqlite:///{os.path.join(_tmpdir, 'test.db')}"
os.environ["AUTO_SEED"] = "0"
os.environ["SECRET_KEY"] = "test-secret-key-long-enough"

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.auth import hash_pin
from app.database import Base, SessionLocal, engine
from app.main import app
from app.models import User


@pytest.fixture(autouse=True)
def _clean_db():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    yield


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def db():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def auth():
    def _auth(token: str) -> dict:
        return {"Authorization": f"Bearer {token}"}

    return _auth


@pytest.fixture
def make_user(db):
    def _make(
        username="user",
        display_name="用户",
        pin="0000",
        role="staff",
        active=True,
        must_change_pin=False,
    ):
        user = User(
            username=username,
            display_name=display_name,
            pin_hash=hash_pin(pin),
            role=role,
            active=active,
            must_change_pin=must_change_pin,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        return user

    return _make


@pytest.fixture
def staff_b_token(client, make_user):
    make_user(username="staff_b", display_name="店员乙", pin="4444", role="staff")
    return client.post(
        "/api/auth/login", json={"username": "staff_b", "pin": "4444"}
    ).json()["token"]


@pytest.fixture
def make_item(db):
    def _make(
        name="物品", category="杂货", unit="个", shelf_life_days=7, min_stock=0,
        active=True, daily_count_enabled=True, weekly_count_enabled=True,
    ):
        from app.models import Item

        item = Item(
            name=name,
            category=category,
            unit=unit,
            shelf_life_days=shelf_life_days,
            min_stock=min_stock,
            daily_count_enabled=daily_count_enabled,
            weekly_count_enabled=weekly_count_enabled,
            active=active,
        )
        db.add(item)
        db.commit()
        db.refresh(item)
        return item

    return _make


@pytest.fixture
def make_batch(db):
    def _make(item_id, qty, expiry_date, source="init", note=None):
        from app.models import Batch

        batch = Batch(
            item_id=item_id,
            qty=qty,
            initial_qty=qty,
            expiry_date=expiry_date,
            source=source,
            note=note,
        )
        db.add(batch)
        db.commit()
        db.refresh(batch)
        return batch

    return _make


def _ensure_user(db, username, display_name, role):
    user = db.scalar(select(User).where(User.username == username))
    if user is None:
        user = User(
            username=username,
            display_name=display_name,
            pin_hash=hash_pin("0000"),
            role=role,
            active=True,
            must_change_pin=False,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    return user


def _token(client, username):
    r = client.post("/api/auth/login", json={"username": username, "pin": "0000"})
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture
def staff_token(client, db):
    _ensure_user(db, "staff", "店员", "staff")
    return _token(client, "staff")


@pytest.fixture
def manager_token(client, db):
    _ensure_user(db, "manager", "店长", "manager")
    return _token(client, "manager")


@pytest.fixture
def admin_token(client, db):
    _ensure_user(db, "admin", "管理员", "admin")
    return _token(client, "admin")
