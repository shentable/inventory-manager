#!/usr/bin/env python3
"""通过公开 API 幂等建立门店试运行测试数据；仅在显式运行时生效。"""

import argparse
import json
import urllib.error
import urllib.request


ITEMS = [
    ("测试吐司", "烘焙", "袋", 3, 4, 20),
    ("测试生菜", "蔬菜", "颗", 2, 5, 12),
    ("测试番茄", "蔬菜", "个", 4, 8, 24),
    ("测试鸡胸", "肉类", "包", 5, 5, 15),
    ("测试火腿", "肉类", "包", 7, 4, 12),
    ("测试芝士", "乳制品", "片", 14, 10, 30),
    ("测试鸡蛋", "蛋类", "个", 21, 12, 36),
    ("测试蛋黄酱", "酱料", "瓶", 30, 2, 6),
]


class Api:
    def __init__(self, base: str):
        self.base = base.rstrip("/") + "/api"
        self.token = None

    def call(self, method: str, path: str, body=None):
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        req = urllib.request.Request(
            self.base + path,
            data=None if body is None else json.dumps(body).encode(),
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")
            raise RuntimeError(f"{method} {path}: HTTP {exc.code} {detail}") from exc


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--admin-pin", required=True)
    args = parser.parse_args()
    api = Api(args.base_url)
    api.token = api.call("POST", "/auth/login", {"username": "admin", "pin": args.admin_pin})["token"]

    users = {user["username"] for user in api.call("GET", "/users")}
    for username, name, pin, role in [
        ("pilot_manager", "测试店长", "2468", "manager"),
        ("pilot_staff", "测试店员", "3579", "staff"),
    ]:
        if username not in users:
            api.call("POST", "/users", {"username": username, "display_name": name, "pin": pin, "role": role})

    existing = {item["name"]: item for item in api.call("GET", "/items")}
    created = []
    for order, (name, category, unit, life, minimum, qty) in enumerate(ITEMS):
        item = existing.get(name)
        if item is None:
            item = api.call("POST", "/items", {
                "name": name, "category": category, "unit": unit,
                "shelf_life_days": life, "min_stock": minimum, "sort_order": order,
            })
        if item.get("stock", 0) == 0:
            created.append((item["id"], qty))
    if created:
        purchase = api.call("POST", "/purchases", {
            "note": "试运行测试数据入库",
            "items": [{"item_id": item_id, "qty": qty} for item_id, qty in created],
        })
        api.call("POST", f"/purchases/{purchase['id']}/receive", {
            "items": [
                {"purchase_item_id": row["id"], "expiry_date": "2099-12-31"}
                for row in purchase["items"]
            ]
        })
    print(json.dumps({
        "status": "ok", "items": len(ITEMS),
        "users": {"pilot_manager": "临时 PIN 2468", "pilot_staff": "临时 PIN 3579"},
        "warning": "两个测试账号首次登录必须修改 PIN",
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
