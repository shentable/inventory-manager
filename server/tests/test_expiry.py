"""效期预警接口。"""
from datetime import date, timedelta


def test_expiry_filter(client, staff_token, auth, make_item, make_batch):
    today = date.today()
    item = make_item(name="奶")
    b1 = make_batch(item_id=item.id, qty=5, expiry_date=(today + timedelta(days=1)).isoformat())
    b2 = make_batch(item_id=item.id, qty=3, expiry_date=(today + timedelta(days=5)).isoformat())
    b3 = make_batch(item_id=item.id, qty=9, expiry_date=(today + timedelta(days=1)).isoformat())
    make_batch(item_id=item.id, qty=0, expiry_date=(today + timedelta(days=1)).isoformat())

    r = client.get("/api/expiry?days=3", headers=auth(staff_token))
    assert r.status_code == 200
    data = r.json()
    assert {e["batch_id"] for e in data} == {b1.id, b3.id}
    assert all(e["days_to_expiry"] <= 3 for e in data)
    assert data[0]["days_to_expiry"] == 1

    r7 = client.get("/api/expiry?days=7", headers=auth(staff_token)).json()
    assert {e["batch_id"] for e in r7} == {b1.id, b2.id, b3.id}


def test_expired_batch_included(client, staff_token, auth, make_item, make_batch):
    item = make_item(name="旧货")
    b = make_batch(
        item_id=item.id, qty=4, expiry_date=(date.today() - timedelta(days=2)).isoformat()
    )
    data = client.get("/api/expiry", headers=auth(staff_token)).json()
    assert any(e["batch_id"] == b.id and e["days_to_expiry"] == -2 for e in data)


def test_expiry_item_meta_and_order(client, staff_token, auth, make_item, make_batch):
    today = date.today()
    item = make_item(name="牛奶", unit="瓶")
    b_far = make_batch(item_id=item.id, qty=2, expiry_date=(today + timedelta(days=3)).isoformat())
    b_near = make_batch(item_id=item.id, qty=7, expiry_date=(today + timedelta(days=1)).isoformat())
    data = client.get("/api/expiry?days=5", headers=auth(staff_token)).json()
    assert [e["batch_id"] for e in data] == [b_near.id, b_far.id]  # 按到期排序
    e = next(x for x in data if x["batch_id"] == b_near.id)
    assert e["item_name"] == "牛奶"
    assert e["unit"] == "瓶"
    assert e["qty"] == 7
    assert e["item_id"] == item.id


def test_optional_expiry_lifecycle(client, manager_token, staff_token, auth, db):
    from sqlalchemy import select
    from app.models import Batch, BatchExpiryUpdate
    h = auth(manager_token)
    item = client.post('/api/items', headers=h, json={'name': '无效期', 'expiry_enabled': False}).json()
    assert item['expiry_enabled'] is False
    received = client.post('/api/stock/receive', headers=h, json={'items': [{'item_id': item['id'], 'qty': 4, 'expiry_date': '2000-01-01'}]})
    assert received.status_code == 201, received.text
    batch = received.json()[0]
    assert batch['expiry_date'] is None and batch['days_to_expiry'] is None
    assert batch['expiry_enabled'] is False
    stock = client.get('/api/stock', headers=h).json()[0]
    assert stock['nearest_expiry'] is None and stock['missing_expiry_count'] == 0
    assert client.get('/api/expiry', headers=h).json() == []
    receipt = client.get(f"/api/stock/receipts/{batch['id']}", headers=h).json()
    assert receipt['expiry_enabled'] is False
    corrected = client.patch(f"/api/stock/receipts/{batch['id']}", headers=h, json={'qty': 5, 'reason': '更正', 'expected_revision': receipt['revision']})
    assert corrected.status_code == 200, corrected.text
    assert corrected.json()['expiry_date'] is None
    client.patch(f"/api/items/{item['id']}", headers=h, json={'expiry_enabled': True})
    stock = client.get('/api/stock', headers=h).json()[0]
    assert stock['missing_expiry_count'] == 1
    assert client.patch(f"/api/batches/{batch['id']}/expiry", headers=auth(staff_token), json={'expiry_date': '2099-01-01'}).status_code == 403
    filled = client.patch(f"/api/batches/{batch['id']}/expiry", headers=h, json={'expiry_date': '2099-01-01'})
    assert filled.status_code == 200, filled.text
    assert client.patch(f"/api/batches/{batch['id']}/expiry", headers=h, json={'expiry_date': '2099-01-02'}).status_code == 409
    db.expire_all()
    saved = db.get(Batch, batch['id'])
    assert saved.qty == 5 and saved.initial_qty == 4
    audit = db.scalar(select(BatchExpiryUpdate))
    assert audit.old_expiry_date is None and audit.new_expiry_date == '2099-01-01'
    missing = client.post('/api/stock/receive', headers=h, json={'items': [{'item_id': item['id'], 'qty': 1}]})
    assert missing.status_code == 400


def test_expiry_sort_policy_and_historical_dates(client, manager_token, auth, db, make_item, make_batch):
    from datetime import datetime
    from app.inventory import positive_batches
    item = make_item()
    b1 = make_batch(item.id, 2, '2099-01-01')
    b2 = make_batch(item.id, 2, '2000-01-01')
    b3 = make_batch(item.id, 2, None)
    b1.received_at = datetime(2020, 1, 1)
    b2.received_at = datetime(2021, 1, 1)
    b3.received_at = datetime(2022, 1, 1)
    db.commit()
    assert [b.id for b in positive_batches(db, item.id)] == [b3.id, b2.id, b1.id]
    client.patch(f'/api/items/{item.id}', headers=auth(manager_token), json={'expiry_enabled': False})
    db.expire_all()
    assert [b.id for b in positive_batches(db, item.id)] == [b1.id, b2.id, b3.id]
    assert db.get(type(b2), b2.id).expiry_date == '2000-01-01'
    assert client.get('/api/expiry', headers=auth(manager_token)).json() == []
    assert client.get('/api/dashboard', headers=auth(manager_token)).json()['expiring_soon'] == 0
