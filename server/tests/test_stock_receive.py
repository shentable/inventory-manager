"""管理员/店长直接入库。"""


def test_manager_can_receive_stock_directly(
    client, manager_token, auth, make_item
):
    first = make_item(name="直接入库甲", unit="袋")
    second = make_item(name="直接入库乙", unit="盒")

    response = client.post(
        "/api/stock/receive",
        json={
            "items": [
                {"item_id": first.id, "qty": 5, "expiry_date": "2099-01-01"},
                {"item_id": second.id, "qty": 3, "expiry_date": "2099-02-01"},
            ],
            "note": "供应商临时补货",
        },
        headers=auth(manager_token),
    )

    assert response.status_code == 201, response.text
    assert [(row["item_id"], row["qty"], row["source"]) for row in response.json()] == [
        (first.id, 5, "receive"),
        (second.id, 3, "receive"),
    ]
    assert all(row["note"] == "供应商临时补货" for row in response.json())

    stock = client.get("/api/stock", headers=auth(manager_token)).json()
    by_id = {row["item"]["id"]: row["stock"] for row in stock}
    assert by_id[first.id] == 5
    assert by_id[second.id] == 3

    movements = client.get(
        f"/api/items/{first.id}/movements", headers=auth(manager_token)
    ).json()
    assert movements[0]["delta"] == 5
    assert movements[0]["operation"] == "stock_receive"
    assert movements[0]["reference_type"] == "manual"
    assert movements[0]["reference_id"] is None


def test_admin_can_receive_stock_directly(client, admin_token, auth, make_item):
    item = make_item(name="管理员入库")
    response = client.post(
        "/api/stock/receive",
        json={"items": [{"item_id": item.id, "qty": 2, "expiry_date": "2099-01-01"}]},
        headers=auth(admin_token),
    )
    assert response.status_code == 201


def test_staff_cannot_receive_stock_directly(client, staff_token, auth, make_item):
    item = make_item(name="店员不可入库")
    response = client.post(
        "/api/stock/receive",
        json={"items": [{"item_id": item.id, "qty": 2, "expiry_date": "2099-01-01"}]},
        headers=auth(staff_token),
    )
    assert response.status_code == 403


def test_direct_receive_validates_lines(client, manager_token, auth, make_item):
    item = make_item(name="校验入库")
    duplicate = client.post(
        "/api/stock/receive",
        json={"items": [
            {"item_id": item.id, "qty": 1, "expiry_date": "2099-01-01"},
            {"item_id": item.id, "qty": 2, "expiry_date": "2099-02-01"},
        ]},
        headers=auth(manager_token),
    )
    assert duplicate.status_code == 400

    invalid_date = client.post(
        "/api/stock/receive",
        json={"items": [{"item_id": item.id, "qty": 1, "expiry_date": "2099-99-01"}]},
        headers=auth(manager_token),
    )
    assert invalid_date.status_code == 422

    missing_item = client.post(
        "/api/stock/receive",
        json={"items": [{"item_id": 99999, "qty": 1, "expiry_date": "2099-01-01"}]},
        headers=auth(manager_token),
    )
    assert missing_item.status_code == 400
