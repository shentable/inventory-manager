"""为浏览器端到端测试重建独立数据库。"""

from pathlib import Path
import os
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / "server"
sys.path.insert(0, str(SERVER))
os.environ["DATABASE_URL"] = f"sqlite:///{SERVER / 'data' / 'e2e.db'}"
os.environ["AUTO_SEED"] = "0"
os.environ["SECRET_KEY"] = "e2e-secret-key-long-enough"

from app.auth import hash_pin
from app.database import Base, SessionLocal, engine
from app.models import Batch, Item, StoreMeta, User

Base.metadata.drop_all(engine)
Base.metadata.create_all(engine)
with SessionLocal() as db:
    db.add(
        StoreMeta(
            id=1,
            store_id="00000000-0000-4000-8000-000000000001",
            schema_version="20260904_08",
        )
    )
    users = [
        ("admin", "管理员", "1111", "admin", False),
        ("manager", "店长", "2222", "manager", False),
        ("staff", "店员", "3333", "staff", False),
        ("staff_b", "店员乙", "4444", "staff", False),
        ("first", "首次用户", "1234", "staff", True),
    ]
    for username, display_name, pin, role, must_change in users:
        db.add(
            User(
                username=username,
                display_name=display_name,
                pin_hash=hash_pin(pin),
                role=role,
                active=True,
                must_change_pin=must_change,
            )
        )
    fixtures = [
        ("测试吐司", "烘焙", "袋", 3, 2, 10),
        ("测试生菜", "蔬菜", "颗", 2, 3, 2),
        ("测试番茄", "蔬菜", "个", 4, 5, 12),
        ("测试鸡胸", "肉类", "包", 5, 4, 8),
        ("测试火腿", "肉类", "包", 7, 3, 7),
        ("测试芝士", "乳制品", "片", 14, 8, 20),
        ("测试鸡蛋", "蛋类", "个", 21, 12, 24),
        ("测试蛋黄酱", "酱料", "瓶", 30, 2, 4),
    ]
    for order, (name, category, unit, life, minimum, qty) in enumerate(fixtures):
        item = Item(
            name=name,
            category=category,
            unit=unit,
            shelf_life_days=life,
            min_stock=minimum,
            sort_order=order,
        )
        db.add(item)
        db.flush()
        db.add(
            Batch(
                item_id=item.id,
                qty=qty,
                initial_qty=qty,
                expiry_date="2099-01-01",
                source="init",
                note="E2E 测试数据",
            )
        )
    db.add(
        Item(
            name="测试空库存",
            category="测试",
            unit="个",
            shelf_life_days=3,
            min_stock=2,
            sort_order=99,
        )
    )
    db.commit()

# 契约测试会复制数据库主文件；先把 WAL 完整落盘，避免复制到旧 schema/旧数据。
engine.dispose()
with sqlite3.connect(SERVER / "data" / "e2e.db") as checkpoint:
    checkpoint.execute("PRAGMA wal_checkpoint(TRUNCATE)")
