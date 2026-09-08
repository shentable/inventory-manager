"""Fractional quantities keep exact balances, regardless of inventory unit."""
import pytest
from sqlalchemy import text


@pytest.mark.parametrize("unit", ["个", "袋", "kg", "公斤", "L", "升", "米", "自定义单位"])
def test_tenths_fefo_and_repeated_waste(client, auth, manager_token, staff_token, make_item, db, unit):
    item = make_item(name="小数" + unit, unit=unit)
    manager, staff = auth(manager_token), auth(staff_token)
    for qty, expiry in [(0.1, "2099-01-01"), (0.2, "2099-02-01")]:
        response = client.post("/api/stock/receive", headers=manager, json={
            "items": [{"item_id": item.id, "qty": qty, "expiry_date": expiry}]
        })
        assert response.status_code == 201, response.text
        assert response.json()[0]["qty"] == qty
    assert client.get("/api/stock", headers=staff).json()[0]["stock"] == 0.3
    waste = client.post("/api/waste", headers=staff, json={"item_id": item.id, "qty": 0.3, "reason": "破损"})
    assert waste.status_code == 201, waste.text
    assert client.post(f"/api/waste/{waste.json()['id']}/confirm", headers=manager).status_code == 200
    batches = client.get(f"/api/items/{item.id}/batches", headers=staff).json()
    assert [b["qty"] for b in batches] == [0, 0]
    movements = client.get(f"/api/items/{item.id}/movements", headers=manager).json()
    assert [m["delta"] for m in movements] == [-0.2, -0.1, 0.2, 0.1]

    client.post("/api/stock/receive", headers=manager, json={
        "items": [{"item_id": item.id, "qty": 1, "expiry_date": "2099-03-01"}]
    })
    for _ in range(10):
        waste = client.post("/api/waste", headers=staff, json={"item_id": item.id, "qty": 0.1, "reason": "破损"}).json()
        assert client.post(f"/api/waste/{waste['id']}/confirm", headers=manager).status_code == 200
    assert client.get("/api/stock", headers=staff).json()[0]["stock"] == 0
    assert db.scalar(text("SELECT sum(qty) FROM batches")) == 0
    assert db.scalar(text("SELECT sum(delta) FROM stock_movements")) == 0


@pytest.mark.parametrize("value", [0.01, 0.15, -0.1, True, "0.1", 1_000_000_000.1])
def test_invalid_quantities_rejected_consistently(client, auth, manager_token, staff_token, make_item, value):
    item = make_item()
    for path, payload, token in [
        ("/api/stock/receive", {"items": [{"item_id": item.id, "qty": value, "expiry_date": "2099-01-01"}]}, manager_token),
        ("/api/purchases", {"items": [{"item_id": item.id, "qty": value}]}, manager_token),
        ("/api/waste", {"item_id": item.id, "qty": value, "reason": "破损"}, staff_token),
        ("/api/counts", {"entries": [{"item_id": item.id, "qty": value}]}, staff_token),
    ]:
        response = client.post(path, headers=auth(token), json=payload)
        assert response.status_code == 422, (path, response.text)


def test_fractional_minimum_purchase_and_count(client, auth, manager_token, staff_token, staff_b_token, db):
    manager = auth(manager_token)
    item = client.post("/api/items", headers=manager, json={"name": "称重品", "unit": "公斤", "min_stock": 0.5}).json()
    assert item["min_stock"] == 0.5
    assert db.scalar(text("SELECT min_stock FROM items")) == 5
    purchase = client.post("/api/purchases", headers=manager, json={"items": [{"item_id": item["id"], "qty": 1.2}]}).json()
    received = client.post(f"/api/purchases/{purchase['id']}/receive", headers=manager,
        json={"items": [{"purchase_item_id": purchase["items"][0]["id"], "expiry_date": "2099-01-01"}]})
    assert received.status_code == 200
    ids = [client.post("/api/counts", headers=auth(token), json={"entries": [{"item_id": item["id"], "qty": 0.9}]}).json()["id"]
           for token in (staff_token, staff_b_token)]
    preview = client.post("/api/count-comparisons/preview", headers=manager,
                         json={"first_count_id": ids[0], "second_count_id": ids[1]}).json()
    assert preview["entries"][0]["current_qty"] == 1.2
    confirmed = client.post("/api/count-comparisons", headers=manager, json={
        "first_count_id": ids[0], "second_count_id": ids[1], "comparison_token": preview["comparison_token"], "resolution": "no_difference"
    })
    assert confirmed.status_code == 201, confirmed.text
    assert confirmed.json()["entries"][0]["final_qty"] == 0.9
    detail = client.get(f"/api/counts/{ids[0]}", headers=manager).json()
    assert detail["entries"][0]["diff"] == -0.3
    assert client.get("/api/stock", headers=manager).json()[0]["stock"] == 0.9
