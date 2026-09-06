#!/usr/bin/env python3
"""Exercise five concurrent clients against a disposable VPS staging database."""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import time
import urllib.error
import urllib.request


def call(base: str, method: str, path: str, token: str | None = None, payload: object | None = None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        f"{base.rstrip('/')}/api{path}",
        data=None if payload is None else json.dumps(payload).encode(),
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--manager-user", default="manager")
    parser.add_argument("--manager-pin", default="2222")
    args = parser.parse_args()
    status, login = call(args.base_url, "POST", "/auth/login", payload={"username": args.manager_user, "pin": args.manager_pin})
    assert status == 200, login
    token = login["token"]
    name = f"并发门禁-{time.time_ns()}"
    status, item = call(args.base_url, "POST", "/items", token, {"name": name, "unit": "份", "shelf_life_days": 7, "min_stock": 1})
    assert status == 201, item
    status, purchase = call(args.base_url, "POST", "/purchases", token, {"items": [{"item_id": item["id"], "qty": 3}]})
    assert status == 201, purchase
    status, received = call(args.base_url, "POST", f"/purchases/{purchase['id']}/receive", token, {"items": [{"purchase_item_id": purchase["items"][0]["id"], "expiry_date": "2099-12-31"}]})
    assert status == 200, received
    wastes = []
    for client in range(5):
        status, waste = call(args.base_url, "POST", "/waste", token, {"item_id": item["id"], "qty": 1, "reason": "并发门禁", "description": f"客户端 {client + 1}"})
        assert status == 201, waste
        wastes.append(waste["id"])
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
        futures = [executor.submit(call, args.base_url, "POST", f"/waste/{waste_id}/confirm", token) for waste_id in wastes]
        results = [future.result() for future in futures]
    statuses = sorted(status for status, _ in results)
    assert statuses == [200, 200, 200, 400, 400], results
    status, stock = call(args.base_url, "GET", "/stock", token)
    assert status == 200
    row = next(entry for entry in stock if entry["item"]["id"] == item["id"])
    assert row["stock"] == 0, row
    status, movements = call(args.base_url, "GET", f"/items/{item['id']}/movements", token)
    assert status == 200
    assert sum(movement["delta"] for movement in movements) == 0, movements
    print(json.dumps({"status": "ok", "clients": 5, "successes": 3, "conflicts": 2, "stock": 0, "movement_count": len(movements)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
