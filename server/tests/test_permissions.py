"""权限：未登录 401、staff 越权 403、manager/admin 边界。"""


def test_no_token_401(client):
    for path in [
        "/api/items",
        "/api/stock",
        "/api/expiry",
        "/api/counts",
        "/api/waste",
        "/api/purchases",
        "/api/users",
        "/api/dashboard",
    ]:
        assert client.get(path).status_code == 401, path


def test_staff_forbidden_manager_actions(client, staff_token, manager_token, auth, make_item):
    item = make_item(name="吐司")
    # 库存品管理
    assert (
        client.post(
            "/api/items", json={"name": "新货", "unit": "个"}, headers=auth(staff_token)
        ).status_code
        == 403
    )
    assert (
        client.patch(f"/api/items/{item.id}", json={"active": False}, headers=auth(staff_token)).status_code
        == 403
    )
    # 店员可提交实数盘点，但不能核对
    r = client.post(
        "/api/counts", json={"entries": [{"item_id": item.id, "qty": 0}]}, headers=auth(staff_token)
    )
    assert r.status_code == 201
    cid = r.json()["id"]
    assert client.post(f"/api/counts/{cid}/verify", json={"entries": [{"item_id": item.id, "qty": 0}]}, headers=auth(staff_token)).status_code == 403
    assert client.post(f"/api/counts/{cid}/reject", headers=auth(staff_token)).status_code == 403
    # 报损确认
    r = client.post(
        "/api/waste", json={"item_id": item.id, "qty": 1, "reason": "过期"}, headers=auth(staff_token)
    )
    assert r.status_code == 201
    wid = r.json()["id"]
    assert client.post(f"/api/waste/{wid}/confirm", headers=auth(staff_token)).status_code == 403
    assert client.post(f"/api/waste/{wid}/reject", headers=auth(staff_token)).status_code == 403
    # 采购
    assert (
        client.post(
            "/api/purchases", json={"items": [{"item_id": item.id, "qty": 5}]}, headers=auth(staff_token)
        ).status_code
        == 403
    )
    # 用户管理
    assert client.get("/api/users", headers=auth(staff_token)).status_code == 403


def test_staff_allowed_actions(client, staff_token, auth, make_item):
    item = make_item(name="生菜")
    assert (
        client.post(
            "/api/counts", json={"count_type": "daily", "entries": [{"item_id": item.id, "enough": True}]}, headers=auth(staff_token)
        ).status_code
        == 201
    )
    assert (
        client.post(
            "/api/waste", json={"item_id": item.id, "qty": 1, "reason": "过期"}, headers=auth(staff_token)
        ).status_code
        == 201
    )
    for path in ["/api/items", "/api/expiry", "/api/dashboard", "/api/stock", "/api/counts", "/api/waste"]:
        assert client.get(path, headers=auth(staff_token)).status_code == 200, path


def test_manager_cannot_manage_users(client, manager_token, auth):
    assert client.get("/api/users", headers=auth(manager_token)).status_code == 403
    assert (
        client.post(
            "/api/users",
            json={"username": "x", "display_name": "X", "pin": "0000", "role": "staff"},
            headers=auth(manager_token),
        ).status_code
        == 403
    )


def test_admin_can_manage_users(client, admin_token, auth):
    assert client.get("/api/users", headers=auth(admin_token)).status_code == 200
    r = client.post(
        "/api/users",
        json={"username": "newbie", "display_name": "新人", "pin": "1234", "role": "staff"},
        headers=auth(admin_token),
    )
    assert r.status_code == 201
    assert r.json()["role"] == "staff"


def test_manager_can_do_manager_actions(client, staff_token, staff_b_token, manager_token, auth, make_item):
    item = make_item(name="芝士")
    assert (
        client.post(
            "/api/items",
            json={"name": "新商品", "unit": "袋", "category": "其他", "shelf_life_days": 10, "min_stock": 2},
            headers=auth(manager_token),
        ).status_code
        == 201
    )
    r = client.post(
        "/api/counts", json={"entries": [{"item_id": item.id, "qty": 1}]}, headers=auth(staff_token)
    )
    assert r.status_code == 201
    second = client.post("/api/counts", json={"entries": [{"item_id": item.id, "qty": 1}]}, headers=auth(staff_b_token)).json()
    preview = client.post("/api/count-comparisons/preview", json={"first_count_id": r.json()["id"], "second_count_id": second["id"]}, headers=auth(manager_token)).json()
    assert client.post("/api/count-comparisons", json={"first_count_id": r.json()["id"], "second_count_id": second["id"], "comparison_token": preview["comparison_token"], "resolution": "no_difference", "corrections": []}, headers=auth(manager_token)).status_code == 201
    assert (
        client.post(
            "/api/purchases", json={"items": [{"item_id": item.id, "qty": 5}]}, headers=auth(manager_token)
        ).status_code
        == 201
    )
