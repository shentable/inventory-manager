"""Daily quantity policy is persisted and enforced from the database."""
import pytest
from sqlalchemy import func, select
from app.models import CountSession, StockMovement


def test_item_quantity_policy_round_trip(client, manager_token, staff_token, auth):
    created = client.post("/api/items", headers=auth(manager_token), json={"name": "必填品项", "daily_quantity_required": True})
    assert created.status_code == 201
    item = created.json()
    assert item["daily_quantity_required"] is True
    iid = item["id"]
    listing = client.get("/api/items", headers=auth(staff_token)).json()
    assert next(row for row in listing if row["id"] == iid)["daily_quantity_required"] is True
    stock = client.get("/api/stock", headers=auth(staff_token)).json()
    assert next(row for row in stock if row["item"]["id"] == iid)["item"]["daily_quantity_required"] is True
    changed = client.patch(f"/api/items/{iid}", headers=auth(manager_token), json={"daily_quantity_required": False})
    assert changed.json()["daily_quantity_required"] is False
    assert client.post("/api/counts", headers=auth(staff_token), json={"count_type": "daily", "entries": [{"item_id": iid, "enough": True}]}).status_code == 201


@pytest.mark.parametrize("enough", [True, False])
@pytest.mark.parametrize("qty", [0, 2.5])
def test_daily_requires_quantity_from_db_without_adjusting_inventory(client, manager_token, staff_token, auth, make_item, make_batch, db, enough, qty):
    item = make_item(name="强制现场数量")
    make_batch(item_id=item.id, qty=8, expiry_date="2099-01-01")
    assert client.patch(f"/api/items/{item.id}", headers=auth(manager_token), json={"daily_quantity_required": True}).status_code == 200
    before_movements = db.scalar(select(func.count()).select_from(StockMovement))
    for extra in [{}, {"qty": None}, {"daily_quantity_required": False}]:
        denied = client.post("/api/counts", headers=auth(staff_token), json={"count_type": "daily", "entries": [{"item_id": item.id, "enough": enough, **extra}]})
        assert denied.status_code == 400
        assert "必须填写现场数量" in denied.json()["detail"]
    assert db.scalar(select(func.count()).select_from(CountSession)) == 0
    result = client.post("/api/counts", headers=auth(staff_token), json={"count_type": "daily", "entries": [{"item_id": item.id, "enough": enough, "qty": qty}]})
    assert result.status_code == 201
    entry = result.json()["entries"][0]
    assert entry["reported_qty"] == qty
    assert entry["qty_counted"] == 8
    stock = client.get("/api/stock", headers=auth(staff_token)).json()
    assert next(row for row in stock if row["item"]["id"] == item.id)["stock"] == 8
    assert db.scalar(select(func.count()).select_from(StockMovement)) == before_movements
