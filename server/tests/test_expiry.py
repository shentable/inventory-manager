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
