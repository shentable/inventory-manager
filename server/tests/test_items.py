"""库存品 CRUD。"""


def test_create_and_list_items(client, manager_token, auth, make_item, make_batch):
    r = client.post(
        "/api/items",
        json={"name": "吐司", "category": "烘焙", "unit": "袋", "shelf_life_days": 3, "min_stock": 5},
        headers=auth(manager_token),
    )
    assert r.status_code == 201
    item = r.json()
    assert item["stock"] == 0
    assert item["shelf_life_days"] == 3
    assert item["unit"] == "袋"
    assert item["daily_count_enabled"] is True
    assert item["weekly_count_enabled"] is True

    make_batch(item_id=item["id"], qty=10, expiry_date="2099-01-01")
    listing = client.get("/api/items", headers=auth(manager_token)).json()
    entry = next(i for i in listing if i["id"] == item["id"])
    assert entry["stock"] == 10


def test_items_include_latest_completed_count(client, manager_token, staff_token, auth, make_item):
    item = make_item(name="最近盘点商品", unit="袋")
    before = client.get("/api/items", headers=auth(staff_token)).json()
    empty = next(row for row in before if row["id"] == item.id)
    assert empty["last_count_at"] is None
    assert empty["last_count_qty"] is None

    created = client.post(
        "/api/counts",
        json={"count_type": "daily", "entries": [{"item_id": item.id, "enough": True, "qty": 6}]},
        headers=auth(staff_token),
    )
    assert created.status_code == 201
    after = client.get("/api/items", headers=auth(staff_token)).json()
    latest = next(row for row in after if row["id"] == item.id)
    assert latest["last_count_at"].endswith("Z")
    assert latest["last_count_qty"] == 6
    assert latest["last_count_type"] == "daily"
    assert latest["last_count_enough"] is True


def test_duplicate_item_name_409(client, manager_token, auth, make_item):
    make_item(name="唯一")
    r = client.post("/api/items", json={"name": "唯一", "unit": "个"}, headers=auth(manager_token))
    assert r.status_code == 409


def test_patch_item(client, manager_token, auth, make_item):
    item = make_item(name="旧名", shelf_life_days=7, min_stock=1)
    r = client.patch(
        f"/api/items/{item.id}",
        json={"shelf_life_days": 14, "min_stock": 3, "daily_count_enabled": False, "weekly_count_enabled": True, "active": False},
        headers=auth(manager_token),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["shelf_life_days"] == 14
    assert body["min_stock"] == 3
    assert body["daily_count_enabled"] is False
    assert body["weekly_count_enabled"] is True
    assert body["active"] is False


def test_include_inactive(client, manager_token, auth, make_item):
    on = make_item(name="上架", active=True)
    off = make_item(name="下架", active=False)
    default = client.get("/api/items", headers=auth(manager_token)).json()
    all_items = client.get("/api/items?include_inactive=true", headers=auth(manager_token)).json()
    assert {i["id"] for i in default} == {on.id}
    assert {i["id"] for i in all_items} == {on.id, off.id}


def test_item_not_found(client, manager_token, auth):
    assert (
        client.patch("/api/items/9999", json={"active": True}, headers=auth(manager_token)).status_code
        == 404
    )
    assert client.get("/api/items/9999/batches", headers=auth(manager_token)).status_code == 404


def test_item_batches_with_days_to_expiry(client, manager_token, auth, make_item, make_batch):
    from datetime import date, timedelta

    item = make_item(name="牛奶")
    b = make_batch(item_id=item.id, qty=4, expiry_date=(date.today() + timedelta(days=2)).isoformat())
    data = client.get(f"/api/items/{item.id}/batches", headers=auth(manager_token)).json()
    assert len(data) == 1
    assert data[0]["id"] == b.id
    assert data[0]["qty"] == 4
    assert data[0]["source"] == "init"
    assert data[0]["days_to_expiry"] == 2
