"""采购：下单、入库生成批次、取消、状态守卫。"""


def _purchase(client, manager_token, auth, item_ids, note=None):
    payload = {"items": [{"item_id": i, "qty": 10} for i in item_ids]}
    if note:
        payload["note"] = note
    r = client.post("/api/purchases", json=payload, headers=auth(manager_token))
    assert r.status_code == 201, r.text
    return r.json()


def test_create_and_list_purchase(client, manager_token, auth, make_item):
    item = make_item(name="面包")
    p = _purchase(client, manager_token, auth, [item.id], note="补货")
    assert p["status"] == "ordered"
    assert len(p["items"]) == 1
    assert p["items"][0]["item_name"] == "面包"
    assert p["note"] == "补货"
    lst = client.get("/api/purchases?status=ordered", headers=auth(manager_token)).json()
    assert [x["id"] for x in lst] == [p["id"]]


def test_receive_generates_batches(client, manager_token, auth, make_item):
    item = make_item(name="鸡蛋", shelf_life_days=21)
    p = _purchase(client, manager_token, auth, [item.id])
    pid = p["items"][0]["id"]
    r = client.post(
        f"/api/purchases/{p['id']}/receive",
        json={"items": [{"purchase_item_id": pid, "expiry_date": "2026-06-01"}]},
        headers=auth(manager_token),
    )
    assert r.status_code == 200
    assert r.json()["status"] == "received"

    batches = client.get(f"/api/items/{item.id}/batches", headers=auth(manager_token)).json()
    assert len(batches) == 1
    b = batches[0]
    assert b["qty"] == 10
    assert b["initial_qty"] == 10
    assert b["source"] == "purchase"
    assert b["expiry_date"] == "2026-06-01"

    stock = client.get("/api/stock", headers=auth(manager_token)).json()
    assert next(e for e in stock if e["item"]["id"] == item.id)["stock"] == 10


def test_receive_twice_409(client, manager_token, auth, make_item):
    item = make_item(name="火腿")
    p = _purchase(client, manager_token, auth, [item.id])
    pid = p["items"][0]["id"]
    payload = {"items": [{"purchase_item_id": pid, "expiry_date": "2099-01-01"}]}
    assert (
        client.post(f"/api/purchases/{p['id']}/receive", json=payload, headers=auth(manager_token)).status_code
        == 200
    )
    assert (
        client.post(f"/api/purchases/{p['id']}/receive", json=payload, headers=auth(manager_token)).status_code
        == 409
    )


def test_receive_missing_lines_400(client, manager_token, auth, make_item):
    i1 = make_item(name="甲")
    i2 = make_item(name="乙")
    p = _purchase(client, manager_token, auth, [i1.id, i2.id])
    pids = [x["id"] for x in p["items"]]
    r = client.post(
        f"/api/purchases/{p['id']}/receive",
        json={"items": [{"purchase_item_id": pids[0], "expiry_date": "2099-01-01"}]},
        headers=auth(manager_token),
    )
    assert r.status_code == 400


def test_receive_invalid_expiry_422(client, manager_token, auth, make_item):
    item = make_item(name="丙")
    p = _purchase(client, manager_token, auth, [item.id])
    pid = p["items"][0]["id"]
    for bad in ["2026-13-99", "not-a-date", "2026/01/01"]:
        r = client.post(
            f"/api/purchases/{p['id']}/receive",
            json={"items": [{"purchase_item_id": pid, "expiry_date": bad}]},
            headers=auth(manager_token),
        )
        assert r.status_code == 422, bad


def test_cancel_purchase_and_guards(client, manager_token, auth, make_item):
    item = make_item(name="丁")
    p = _purchase(client, manager_token, auth, [item.id])
    r = client.post(f"/api/purchases/{p['id']}/cancel", headers=auth(manager_token))
    assert r.status_code == 200
    assert r.json()["status"] == "cancelled"
    assert (
        client.post(f"/api/purchases/{p['id']}/cancel", headers=auth(manager_token)).status_code
        == 409
    )
    pid = p["items"][0]["id"]
    assert (
        client.post(
            f"/api/purchases/{p['id']}/receive",
            json={"items": [{"purchase_item_id": pid, "expiry_date": "2099-01-01"}]},
            headers=auth(manager_token),
        ).status_code
        == 409
    )


def test_duplicate_purchase_lines_400(client, manager_token, auth, make_item):
    item = make_item(name="戊")
    r = client.post(
        "/api/purchases",
        json={"items": [{"item_id": item.id, "qty": 1}, {"item_id": item.id, "qty": 2}]},
        headers=auth(manager_token),
    )
    assert r.status_code == 400
