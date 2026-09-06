"""正式空库引导不产生默认凭据。"""

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from app.auth import hash_pin
from app.database import Base
from app.models import Item, User
from seed import SEED_ITEMS, run_seed


def _session(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'seed.db'}")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, expire_on_commit=False)()


def test_empty_database_requires_bootstrap_pin(monkeypatch, tmp_path):
    monkeypatch.delenv("BOOTSTRAP_ADMIN_PIN", raising=False)
    with _session(tmp_path) as db, pytest.raises(RuntimeError, match="BOOTSTRAP_ADMIN_PIN"):
        run_seed(db)


def test_bootstrap_creates_only_forced_change_admin(monkeypatch, tmp_path):
    monkeypatch.setenv("BOOTSTRAP_ADMIN_PIN", "2468")
    with _session(tmp_path) as db:
        run_seed(db)
        users = db.scalars(select(User)).all()
        assert [(u.username, u.role, u.must_change_pin) for u in users] == [
            ("admin", "admin", True)
        ]
        assert db.scalar(select(func.count(Item.id))) == len(SEED_ITEMS)


def test_existing_database_does_not_need_bootstrap_pin(monkeypatch, tmp_path):
    monkeypatch.delenv("BOOTSTRAP_ADMIN_PIN", raising=False)
    with _session(tmp_path) as db:
        db.add(
            User(
                username="admin",
                display_name="管理员",
                pin_hash=hash_pin("2468"),
                role="admin",
                active=True,
                must_change_pin=False,
            )
        )
        db.commit()
        run_seed(db)
        assert db.scalar(select(func.count(User.id))) == 1
