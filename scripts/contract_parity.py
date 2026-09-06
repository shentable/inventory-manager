#!/usr/bin/env python3
"""对同一数据库副本运行 Python/Rust 黑盒契约并比较业务结果。"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PYTHON = ROOT / "server/.venv/bin/python"
NATIVE = ROOT / "native-server/target/debug/sandwich-server"
SECRET_FILE = ROOT / "native-server/test-secret.txt"


def request(base: str, method: str, path: str, body=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        response = urllib.request.urlopen(req, timeout=5)
    except urllib.error.HTTPError as exc:
        response = exc
    raw = response.read()
    parsed = json.loads(raw) if raw else None
    return response.status, parsed, response.headers


def request_raw(base: str, method: str, path: str, body=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        response = urllib.request.urlopen(req, timeout=5)
    except urllib.error.HTTPError as exc:
        response = exc
    return response.status, response.read(), response.headers


def wait_health(base: str) -> None:
    for _ in range(100):
        try:
            if request(base, "GET", "/api/health")[0] == 200:
                return
        except OSError:
            pass
        time.sleep(0.1)
    raise RuntimeError(f"后端未就绪：{base}")


def normalize(value):
    if isinstance(value, list):
        return [normalize(item) for item in value]
    if isinstance(value, dict):
        ignored = {"token", "backend_kind", "app_version", "comparison_token"}
        return {
            key: normalize(item)
            for key, item in value.items()
            if key not in ignored and not key.endswith("_at")
        }
    return value


def scenario(base: str):
    results = []

    def call(method, path, body=None, token=None):
        status, payload, headers = request(base, method, path, body, token)
        results.append((method, path, status, normalize(payload)))
        return payload, headers

    call("GET", "/api/health")
    call("GET", "/api/auth/login-options")
    admin, _ = call("POST", "/api/auth/login", {"username": "admin", "pin": "1111"})
    staff, _ = call("POST", "/api/auth/login", {"username": "staff", "pin": "3333"})
    staff_b, _ = call("POST", "/api/auth/login", {"username": "staff_b", "pin": "4444"})
    call("GET", "/api/purchases", token=staff["token"])  # 权限必须同为 403
    item, _ = call(
        "POST",
        "/api/items",
        {"name": "契约奶酪", "category": "原料", "unit": "包", "shelf_life_days": 9,
         "min_stock": 1, "sort_order": 50},
        admin["token"],
    )
    purchase, _ = call(
        "POST", "/api/purchases",
        {"items": [{"item_id": item["id"], "qty": 7}], "note": "contract"},
        admin["token"],
    )
    call(
        "POST", f"/api/purchases/{purchase['id']}/receive",
        {"items": [{"purchase_item_id": purchase["items"][0]["id"],
                    "expiry_date": "2099-12-31"}]},
        admin["token"],
    )
    empty_item, _ = call(
        "POST", "/api/items",
        {"name": "契约空库存", "category": "原料", "unit": "个", "shelf_life_days": 3,
         "min_stock": 2, "sort_order": 51},
        admin["token"],
    )
    call("GET", "/api/stock", token=admin["token"])
    call("GET", f"/api/items/{item['id']}/movements", token=admin["token"])
    daily, _ = call(
        "POST", "/api/counts",
        {"count_type": "daily", "entries": [{"item_id": item["id"], "enough": False, "qty": 8}]},
        staff["token"],
    )
    call("GET", "/api/items", token=staff["token"])
    call(
        "POST", "/api/counts",
        {"count_type": "daily", "entries": [{"item_id": item["id"], "enough": True}]},
        staff["token"],
    )
    call(
        "POST", "/api/counts",
        {"count_type": "daily", "overwrite_daily": True,
         "entries": [{"item_id": item["id"], "enough": True}]},
        staff["token"],
    )
    call("GET", "/api/counts?count_type=daily", token=admin["token"])
    call(
        "POST", f"/api/counts/{daily['id']}/verify",
        {"entries": [{"item_id": item["id"], "qty": 7}]},
        admin["token"],
    )
    waste, _ = call(
        "POST", "/api/waste",
        {"item_id": item["id"], "qty": 1, "reason": "破损",
         "description": "契约图片凭证",
         "photo_data": "data:image/png;base64,iVBORw0KGgpjb250cmFjdA=="},
        staff["token"],
    )
    status, raw, headers = request_raw(
        base, "GET", f"/api/waste/{waste['id']}/photo", token=admin["token"]
    )
    results.append(("GET", "/api/waste/{id}/photo", status,
                    {"content_type": headers.get_content_type(), "bytes": raw.hex()}))
    weekly, _ = call(
        "POST", "/api/counts",
        {"count_type": "weekly", "entries": [{"item_id": item["id"], "qty": 7}]},
        staff["token"],
    )
    call(
        "PATCH", f"/api/counts/{weekly['id']}",
        {"entries": [{"item_id": item["id"], "qty": 7},
                     {"item_id": empty_item["id"], "qty": 0}], "note": "contract edit"},
        staff["token"],
    )
    call(
        "POST", f"/api/counts/{weekly['id']}/verify",
        {"entries": [{"item_id": item["id"], "qty": 7}]}, admin["token"],
    )
    second_weekly, _ = call(
        "POST", "/api/counts",
        {"count_type": "weekly", "entries": [
            {"item_id": item["id"], "qty": 6},
            {"item_id": empty_item["id"], "qty": 0},
        ]},
        staff_b["token"],
    )
    preview, _ = call(
        "POST", "/api/count-comparisons/preview",
        {"first_count_id": weekly["id"], "second_count_id": second_weekly["id"]},
        admin["token"],
    )
    if "comparison_token" not in preview:
        raise RuntimeError(f"盘点比对预览失败：{preview}")
    comparison, _ = call(
        "POST", "/api/count-comparisons",
        {"first_count_id": weekly["id"], "second_count_id": second_weekly["id"],
         "comparison_token": preview["comparison_token"], "resolution": "normal_consumption"},
        admin["token"],
    )
    call("GET", f"/api/count-comparisons/{comparison['id']}", token=admin["token"])
    call("GET", "/api/counts?count_type=weekly&days=3", token=staff["token"])
    rate_statuses = []
    retry_seen = False
    for _ in range(5):
        status, _, headers = request(
            base, "POST", "/api/auth/login", {"username": "missing-contract", "pin": "0000"}
        )
        rate_statuses.append(status)
        retry_seen = retry_seen or (status == 429 and int(headers.get("Retry-After", "0")) > 0)
    results.append(("RATE", "/api/auth/login", rate_statuses, retry_seen))
    return results


def main() -> None:
    subprocess.run([str(PYTHON), str(ROOT / "web/e2e/seed.py")], check=True)
    with tempfile.TemporaryDirectory(prefix="swinv_contract_") as temp:
        temp_path = Path(temp)
        py_db, rust_db = temp_path / "python.db", temp_path / "rust.db"
        shutil.copy2(ROOT / "server/data/e2e.db", py_db)
        shutil.copy2(py_db, rust_db)
        py_env = os.environ | {
            "DATABASE_URL": f"sqlite:///{py_db}", "AUTO_SEED": "0",
            "SECRET_KEY": "e2e-secret-key-long-enough", "APP_VERSION": "contract",
        }
        python = subprocess.Popen(
            [str(PYTHON), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "18880"],
            cwd=ROOT / "server", env=py_env,
        )
        rust = subprocess.Popen(
            [str(NATIVE), "serve", "--db", str(rust_db), "--secret-file", str(SECRET_FILE),
             "--listen", "127.0.0.1:18881", "--app-version", "contract"],
            cwd=ROOT,
        )
        try:
            wait_health("http://127.0.0.1:18880")
            wait_health("http://127.0.0.1:18881")
            left = scenario("http://127.0.0.1:18880")
            right = scenario("http://127.0.0.1:18881")
            if left != right:
                for a, b in zip(left, right):
                    if a != b:
                        print("Python:", json.dumps(a, ensure_ascii=False, indent=2))
                        print("Rust:  ", json.dumps(b, ensure_ascii=False, indent=2))
                raise SystemExit("双后端 API 契约不一致")
            print(f"双后端黑盒契约一致：{len(left)} 个检查点")
        finally:
            python.terminate(); rust.terminate()
            python.wait(timeout=5); rust.wait(timeout=5)


if __name__ == "__main__":
    main()
