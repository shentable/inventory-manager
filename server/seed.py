"""幂等种子数据。

- 空库仅通过 BOOTSTRAP_ADMIN_PIN 创建临时管理员，并强制首次改 PIN
- 示例库存品 8 种

可直接运行：python seed.py（或 python -m seed）；应用启动时也会自动执行（AUTO_SEED=1）。
"""
import os
import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import hash_pin
from app.database import SessionLocal
from app.models import Item, User

# (name, category, unit, shelf_life_days, min_stock)
SEED_ITEMS = [
    ("吐司面包", "烘焙", "袋", 3, 5),
    ("生菜", "蔬菜", "棵", 3, 10),
    ("番茄", "蔬菜", "个", 5, 15),
    ("鸡胸肉", "肉类", "kg", 5, 8),
    ("火腿片", "肉类", "袋", 7, 6),
    ("芝士片", "乳制品", "片", 14, 20),
    ("鸡蛋", "蛋类", "个", 21, 24),
    ("蛋黄酱", "酱料", "瓶", 30, 4),
]


def run_seed(db: Session) -> None:
    if db.scalar(select(User.id).limit(1)) is None:
        pin = os.environ.get("BOOTSTRAP_ADMIN_PIN", "")
        if not re.fullmatch(r"\d{4,6}", pin):
            raise RuntimeError("空库启动必须设置 4-6 位数字 BOOTSTRAP_ADMIN_PIN")
        db.add(
            User(
                username="admin",
                display_name="管理员",
                pin_hash=hash_pin(pin),
                role="admin",
                active=True,
                must_change_pin=True,
            )
        )
    for name, category, unit, shelf_life_days, min_stock in SEED_ITEMS:
        exists = db.scalar(select(Item).where(Item.name == name))
        if exists is None:
            db.add(
                Item(
                    name=name,
                    category=category,
                    unit=unit,
                    shelf_life_days=shelf_life_days,
                    min_stock=min_stock,
                    active=True,
                )
            )
    db.commit()


def main() -> None:
    with SessionLocal() as db:
        run_seed(db)
    print(f"seed ok (bootstrap admin + {len(SEED_ITEMS)} items, 幂等)")


if __name__ == "__main__":
    main()
