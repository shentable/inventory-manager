"""报损：登记、图片凭证、确认（FEFO/指定批次）、不足 400、状态守卫。"""

import base64


def test_report_waste(client, staff_token, auth, make_item):
    item = make_item(name="面包")
    r = client.post(
        "/api/waste", json={"item_id": item.id, "qty": 2, "reason": "过期"}, headers=auth(staff_token)
    )
    assert r.status_code == 201
    body = r.json()
    assert body["status"] == "pending"
    assert body["item_name"] == "面包"
    assert body["reason"] == "过期"
    assert body["reported_by_name"] == "店员"
    assert body["description"] is None
    assert body["has_photo"] is False


def test_report_waste_with_description_and_photo(client, staff_token, manager_token, auth, make_item):
    item = make_item(name="带图面包")
    png = b"\x89PNG\r\n\x1a\nsmall-test-image"
    photo_data = "data:image/png;base64," + base64.b64encode(png).decode()
    response = client.post(
        "/api/waste",
        json={
            "item_id": item.id,
            "qty": 1,
            "reason": "破损",
            "description": "  外包装破裂，已隔离  ",
            "photo_data": photo_data,
        },
        headers=auth(staff_token),
    )
    assert response.status_code == 201
    body = response.json()
    assert body["description"] == "外包装破裂，已隔离"
    assert body["has_photo"] is True

    photo = client.get(f"/api/waste/{body['id']}/photo", headers=auth(manager_token))
    assert photo.status_code == 200
    assert photo.headers["content-type"] == "image/png"
    assert photo.content == png


def test_report_waste_rejects_invalid_photo(client, staff_token, auth, make_item):
    item = make_item(name="坏图面包")
    response = client.post(
        "/api/waste",
        json={
            "item_id": item.id,
            "qty": 1,
            "reason": "破损",
            "photo_data": "data:text/plain;base64,SGVsbG8=",
        },
        headers=auth(staff_token),
    )
    assert response.status_code == 400


def test_confirm_waste_fefo(client, staff_token, manager_token, auth, make_item, make_batch):
    item = make_item(name="芝士")
    make_batch(item_id=item.id, qty=2, expiry_date="2026-04-01")
    make_batch(item_id=item.id, qty=5, expiry_date="2026-06-01")
    wr = client.post(
        "/api/waste", json={"item_id": item.id, "qty": 4, "reason": "变质"}, headers=auth(staff_token)
    ).json()
    r = client.post(f"/api/waste/{wr['id']}/confirm", headers=auth(manager_token))
    assert r.status_code == 200
    assert r.json()["status"] == "confirmed"

    batches = {
        b["expiry_date"]: b["qty"]
        for b in client.get(f"/api/items/{item.id}/batches", headers=auth(manager_token)).json()
    }
    assert batches["2026-04-01"] == 0
    assert batches["2026-06-01"] == 3


def test_confirm_waste_specific_batch(client, staff_token, manager_token, auth, make_item, make_batch):
    item = make_item(name="火腿")
    b1 = make_batch(item_id=item.id, qty=5, expiry_date="2026-04-01")
    make_batch(item_id=item.id, qty=5, expiry_date="2026-06-01")
    wr = client.post(
        "/api/waste",
        json={"item_id": item.id, "qty": 3, "reason": "破损", "batch_id": b1.id},
        headers=auth(staff_token),
    ).json()
    assert client.post(f"/api/waste/{wr['id']}/confirm", headers=auth(manager_token)).status_code == 200
    batches = {
        b["expiry_date"]: b["qty"]
        for b in client.get(f"/api/items/{item.id}/batches", headers=auth(manager_token)).json()
    }
    assert batches["2026-04-01"] == 2
    assert batches["2026-06-01"] == 5


def test_confirm_waste_insufficient_400(client, staff_token, manager_token, auth, make_item, make_batch):
    item = make_item(name="番茄")
    make_batch(item_id=item.id, qty=2, expiry_date="2099-01-01")
    wr = client.post(
        "/api/waste", json={"item_id": item.id, "qty": 5, "reason": "过期"}, headers=auth(staff_token)
    ).json()
    r = client.post(f"/api/waste/{wr['id']}/confirm", headers=auth(manager_token))
    assert r.status_code == 400
    # 状态与库存均未变
    lst = client.get("/api/waste", headers=auth(manager_token)).json()
    assert lst[0]["status"] == "pending"
    stock = client.get("/api/stock", headers=auth(manager_token)).json()
    assert next(e for e in stock if e["item"]["id"] == item.id)["stock"] == 2


def test_waste_status_guards(client, staff_token, manager_token, auth, make_item, make_batch):
    item = make_item(name="蛋")
    make_batch(item_id=item.id, qty=5, expiry_date="2099-01-01")
    wr = client.post(
        "/api/waste", json={"item_id": item.id, "qty": 1, "reason": "过期"}, headers=auth(staff_token)
    ).json()
    assert client.post(f"/api/waste/{wr['id']}/confirm", headers=auth(manager_token)).status_code == 200
    assert client.post(f"/api/waste/{wr['id']}/confirm", headers=auth(manager_token)).status_code == 409
    assert client.post(f"/api/waste/{wr['id']}/reject", headers=auth(manager_token)).status_code == 409

    wr2 = client.post(
        "/api/waste", json={"item_id": item.id, "qty": 1, "reason": "污染"}, headers=auth(staff_token)
    ).json()
    assert client.post(f"/api/waste/{wr2['id']}/reject", headers=auth(manager_token)).status_code == 200
    assert client.post(f"/api/waste/{wr2['id']}/confirm", headers=auth(manager_token)).status_code == 409


def test_waste_batch_mismatch_400(client, staff_token, auth, make_item, make_batch):
    i1 = make_item(name="甲")
    i2 = make_item(name="乙")
    b = make_batch(item_id=i2.id, qty=5, expiry_date="2099-01-01")
    r = client.post(
        "/api/waste",
        json={"item_id": i1.id, "qty": 1, "reason": "过期", "batch_id": b.id},
        headers=auth(staff_token),
    )
    assert r.status_code == 400


def test_waste_list_with_batch_expiry(client, staff_token, manager_token, auth, make_item, make_batch):
    item = make_item(name="牛奶")
    b = make_batch(item_id=item.id, qty=5, expiry_date="2026-07-01")
    client.post(
        "/api/waste",
        json={"item_id": item.id, "qty": 2, "reason": "变质", "batch_id": b.id},
        headers=auth(staff_token),
    )
    data = client.get("/api/waste", headers=auth(manager_token)).json()
    assert len(data) == 1
    assert data[0]["batch_expiry_date"] == "2026-07-01"
    assert data[0]["item_name"] == "牛奶"
