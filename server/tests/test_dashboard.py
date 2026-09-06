"""仪表盘统计。"""
from datetime import date, timedelta


def test_dashboard_counts_and_reset(
    client, staff_token, staff_b_token, manager_token, admin_token, auth, make_item, make_batch
):
    today = date.today()
    # 低库存：stock(3) < min_stock(10)
    low = make_item(name="低库存", min_stock=10)
    make_batch(item_id=low.id, qty=3, expiry_date="2099-01-01")
    # 充足：stock(20) >= min_stock(5)
    ok = make_item(name="充足", min_stock=5)
    make_batch(item_id=ok.id, qty=20, expiry_date="2099-01-01")
    # 临期批次
    exp = make_item(name="临期")
    make_batch(item_id=exp.id, qty=4, expiry_date=(today + timedelta(days=2)).isoformat())

    wr = client.post(
        "/api/waste", json={"item_id": low.id, "qty": 1, "reason": "过期"}, headers=auth(staff_token)
    ).json()
    cr = client.post(
        "/api/counts", json={"entries": [{"item_id": low.id, "qty": 3}]}, headers=auth(manager_token)
    ).json()
    pr = client.post(
        "/api/purchases", json={"items": [{"item_id": low.id, "qty": 5}]}, headers=auth(manager_token)
    ).json()

    d = client.get("/api/dashboard", headers=auth(staff_token)).json()
    assert d == {
        "low_stock": 1,
        "expiring_soon": 1,
        "pending_waste": 1,
        "pending_counts": 1,
        "active_purchases": 1,
        "daily_shortages": 0,
        "recent_counts_3d": 0,
    }
    assert client.get("/api/dashboard", headers=auth(manager_token)).json()["recent_counts_3d"] == 1

    # 处理完 pending 项后归零
    assert (
        client.post(f"/api/waste/{wr['id']}/confirm", headers=auth(manager_token)).status_code == 200
    )
    # 双人流程只能成对退回；确认人不能是盘点提交人。
    other = client.post(
        "/api/counts", json={"entries": [{"item_id": low.id, "qty": 2}]},
        headers=auth(staff_b_token),
    ).json()
    preview = client.post(
        "/api/count-comparisons/preview",
        json={"first_count_id": cr["id"], "second_count_id": other["id"]},
        headers=auth(admin_token),
    ).json()
    assert client.post(
        "/api/count-comparisons",
        json={
            "first_count_id": cr["id"], "second_count_id": other["id"],
            "comparison_token": preview["comparison_token"],
            "resolution": "recount_required", "note": "库存期间发生报损",
        },
        headers=auth(admin_token),
    ).status_code == 201
    assert (
        client.post(
            f"/api/purchases/{pr['id']}/receive",
            json={"items": [{"purchase_item_id": pr["items"][0]["id"], "expiry_date": "2099-01-01"}]},
            headers=auth(manager_token),
        ).status_code
        == 200
    )

    d2 = client.get("/api/dashboard", headers=auth(staff_token)).json()
    assert d2 == {
        "low_stock": 1,  # 低库存品仍在（3-1=2 < 10）
        "expiring_soon": 1,  # 临期批次未动
        "pending_waste": 0,
        "pending_counts": 0,
        "active_purchases": 0,
        "daily_shortages": 0,
        "recent_counts_3d": 0,
    }


def test_dashboard_empty(client, staff_token, auth):
    d = client.get("/api/dashboard", headers=auth(staff_token)).json()
    assert d == {
        "low_stock": 0,
        "expiring_soon": 0,
        "pending_waste": 0,
        "pending_counts": 0,
        "active_purchases": 0,
        "daily_shortages": 0,
        "recent_counts_3d": 0,
    }


def test_dashboard_daily_shortages(client, staff_token, auth, make_item):
    enough = make_item(name="够用商品")
    lacking = make_item(name="缺货商品")
    response = client.post(
        "/api/counts",
        json={
            "count_type": "daily",
            "entries": [
                {"item_id": enough.id, "enough": True},
                {"item_id": lacking.id, "enough": False, "qty": 0},
            ],
        },
        headers=auth(staff_token),
    )
    assert response.status_code == 201
    assert client.get("/api/dashboard", headers=auth(staff_token)).json()["daily_shortages"] == 1
