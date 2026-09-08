from datetime import timedelta

from sqlalchemy import select, func

from app.auth import create_token
from app.database import utcnow
from app.models import Batch, CountSession, CountEntry, StockMovement, StockReceiptCorrection


def receive(client, auth, token, item, qty=1.2):
    response = client.post('/api/stock/receive', headers=auth(token), json={
        'items': [{'item_id': item.id, 'qty': qty, 'expiry_date': '2099-01-01'}], 'note': '原备注'})
    assert response.status_code == 201, response.text
    return response.json()[0]['id']


def correction(qty=1.5, revision=0, **kw):
    return dict(qty=qty, expiry_date='2099-02-01', note='新备注', reason='核对送货单', expected_revision=revision, **kw)


def test_owner_and_managers_can_query_correct_other_staff_cannot(client, auth, staff_token, manager_token, admin_token, make_user, make_item, db):
    item = make_item()
    batch = receive(client, auth, staff_token, item)
    other = make_user(username='other')
    other_token = create_token(other.id, other.token_version)
    route = f'/api/stock/receipts/{batch}'
    assert client.get('/api/stock/receipts').status_code == 401
    assert client.get('/api/stock/receipts', headers=auth(other_token)).json()['items'] == []
    assert client.get(route, headers=auth(other_token)).status_code == 404
    assert client.patch(route, headers=auth(other_token), json=correction()).status_code == 404
    revision = 0
    for index, token in enumerate((staff_token, manager_token, admin_token)):
        assert len(client.get('/api/stock/receipts', headers=auth(token)).json()['items']) == 1
        response = client.patch(route, headers=auth(token), json=correction(1.5 + index/10, revision))
        assert response.status_code == 200, response.text
        row = response.json()
        assert row['original_qty'] == 1.2 and row['qty'] == row['remaining_qty'] == 1.5 + index/10
        assert len(row['corrections']) == index+1
        revision = row['revision']
    db.expire_all()
    assert db.get(Batch, batch).initial_qty == 1.2
    original = db.scalar(select(StockMovement).where(StockMovement.operation == 'stock_receive'))
    assert original.delta == 1.2
    assert round(db.scalar(select(func.sum(StockMovement.delta))),1) == 1.7


def test_partial_deduction_and_stale_revision_never_overdraw_or_double_apply(client, auth, staff_token, manager_token, make_item, db):
    item = make_item()
    batch = receive(client, auth, staff_token, item)
    waste = client.post('/api/waste', headers=auth(staff_token), json={'item_id':item.id,'qty':0.5,'reason':'损坏'}).json()
    assert client.post(f"/api/waste/{waste['id']}/confirm", headers=auth(manager_token), json={'action':'confirm'}).status_code == 200
    route=f'/api/stock/receipts/{batch}'
    assert client.patch(route, headers=auth(staff_token), json=correction(0.4)).status_code == 409
    response=client.patch(route, headers=auth(staff_token), json=correction(0.8))
    assert response.status_code == 200, response.text
    assert response.json()['remaining_qty'] == 0.3
    assert client.patch(route, headers=auth(manager_token), json=correction(0.8)).status_code == 409
    db.expire_all()
    assert db.get(Batch,batch).qty == 0.3
    assert db.scalar(select(func.count(StockReceiptCorrection.id))) == 1


def test_counted_receipt_quantity_locked_metadata_still_audited(client, auth, staff_token, manager_token, make_item, make_user, db):
    item=make_item()
    batch=receive(client,auth,staff_token,item)
    actor=make_user(username='counter')
    session=CountSession(created_by=actor.id,status='verified',created_at=utcnow()+timedelta(seconds=1))
    db.add(session); db.flush()
    db.add(CountEntry(session_id=session.id,item_id=item.id,qty_counted=1.2,expected_qty=1.2))
    db.commit()
    route=f'/api/stock/receipts/{batch}'
    assert client.get(route,headers=auth(manager_token)).json()['quantity_locked'] is True
    assert client.patch(route,headers=auth(manager_token),json=correction(1.5)).status_code == 409
    result=client.patch(route,headers=auth(manager_token),json=correction(1.2))
    assert result.status_code == 200, result.text
    assert result.json()['remaining_qty']==1.2
    assert result.json()['corrections'][0]['old_expiry_date']=='2099-01-01'


def test_cancellation_validation_and_pagination(client, auth, staff_token, make_item):
    ids=[receive(client,auth,staff_token,make_item(name=f'记录{i}')) for i in range(3)]
    page=client.get('/api/stock/receipts?limit=2',headers=auth(staff_token)).json()
    assert len(page['items'])==2 and page['has_more'] is True
    last=client.get('/api/stock/receipts?limit=2&offset=2',headers=auth(staff_token)).json()
    assert len(last['items'])==1 and last['has_more'] is False
    assert len(client.get('/api/stock/receipts?q=记录1',headers=auth(staff_token)).json()['items'])==1
    route=f'/api/stock/receipts/{ids[0]}'
    for change in ({'qty':0.15},{'qty':-0.1},{'reason':' '},{'expiry_date':'bad'},{'expected_revision':-1}):
        body=correction();body.update(change)
        assert client.patch(route,headers=auth(staff_token),json=body).status_code in (400,422)
    result=client.patch(route,headers=auth(staff_token),json=correction(0))
    assert result.status_code==200 and result.json()['remaining_qty']==0
    assert result.json()['original_qty']==1.2


def test_simultaneous_editors_only_one_revision_commits(client, auth, staff_token, manager_token, make_item, db):
    from concurrent.futures import ThreadPoolExecutor
    batch=receive(client,auth,staff_token,make_item())
    def save(token):
        return client.patch(f'/api/stock/receipts/{batch}', headers=auth(token), json=correction(0.8)).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses=list(pool.map(save,[staff_token,manager_token]))
    assert sorted(statuses)==[200,409]
    db.expire_all()
    assert db.get(Batch,batch).qty==0.8
    assert db.scalar(select(func.count(StockReceiptCorrection.id)))==1
