#!/usr/bin/env python3
"""Native expiry-policy regression against an isolated temporary database."""
import json
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import owner_preview as preview
import os
if os.environ.get("NATIVE_TEST_BINARY"):
    preview.BINARY = Path(os.environ["NATIVE_TEST_BINARY"])


def main():
    with tempfile.TemporaryDirectory(prefix='expiry-policy-') as directory:
        directory = Path(directory)
        db = directory / 'app.db'
        preview.migrate_and_seed(db)
        secret = directory / 'secret'
        secret.write_text('daily-required-local-test-secret')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        base = f'http://127.0.0.1:{port}'
        checks = 0
        def request(method, path, body=None, token=None, expected=200):
            nonlocal checks
            headers = {'Content-Type': 'application/json'}
            if token:
                headers['Authorization'] = 'Bearer ' + token
            req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method)
            try:
                response = urllib.request.urlopen(req, timeout=5)
            except urllib.error.HTTPError as exc:
                response = exc
            with response:
                raw = response.read()
                assert response.status == expected, (method, path, response.status, raw)
            checks += 1
            return json.loads(raw) if raw else None
        def session_snapshot():
            with sqlite3.connect(db) as conn:
                return [conn.execute('SELECT * FROM ' + table + ' ORDER BY id').fetchall() for table in ['count_sessions','count_entries','batches','stock_movements','users']]
        with (directory / 'server.log').open('wb') as log:
            proc = subprocess.Popen([str(preview.BINARY), 'serve', '--db', str(db), '--secret-file', str(secret), '--listen', f'127.0.0.1:{port}'], stdout=log, stderr=log, cwd=preview.ROOT)
            try:
                for _ in range(100):
                    try:
                        urllib.request.urlopen(base + '/api/health', timeout=1).close()
                        break
                    except OSError:
                        time.sleep(.1)
                admin = request('POST','/api/auth/login',{'username':'admin','pin':'111111'})['token']
                staff = request('POST','/api/auth/login',{'username':'staff','pin':'333333'})['token']
                owner = request('POST','/api/auth/login',{'username':'owner','pin':'654321'})['token']
                def snap():
                    with sqlite3.connect(db) as c:
                        return [c.execute('SELECT * FROM '+t+' ORDER BY id').fetchall() for t in ['users','batches','stock_movements']]
                enabled=request('POST','/api/items',{'name':'Expiry enabled test','unit':'kg'},admin,201)
                off=request('POST','/api/items',{'name':'Expiry disabled test','unit':'kg','expiry_enabled':False},admin,201)
                assert enabled['expiry_enabled'] is True and off['expiry_enabled'] is False
                eid,oid=enabled['id'],off['id']
                before=snap()
                request('POST','/api/stock/receive',{'items':[{'item_id':oid,'qty':1},{'item_id':eid,'qty':1}]},staff,400)
                assert snap()==before
                def receive(item,qty,date=None):
                    return request('POST','/api/stock/receive',{'items':[{'item_id':item,'qty':qty,'expiry_date':date}]},staff,201)[0]
                first=receive(oid,2.3,'1999-01-01');assert first['expiry_date'] is None and first['days_to_expiry'] is None
                early=receive(eid,3,'1999-01-01');assert early['expiry_date']=='1999-01-01'
                request('PATCH',f'/api/items/{eid}',{'expiry_enabled':False},admin)
                assert not any(r['item_id']==eid for r in request('GET','/api/expiry',token=admin))
                snapshot=request('GET','/api/owner/dashboard',token=owner)
                assert not any(r['item_id']==eid for r in snapshot['expiry']['expired'])
                data=request('GET','/api/consumption',token=admin)
                row=next(r for r in data['items'] if r['item_id']==eid)
                assert row['expired_qty']==0 and row['expiring_qty']==0 and row['expiry_enabled'] is False
                receipt=request('GET',f"/api/stock/receipts/{early['id']}",token=staff)
                corrected=request('PATCH',f"/api/stock/receipts/{early['id']}",{'qty':4,'reason':'quantity only','expected_revision':receipt['revision']},staff)
                assert corrected['expiry_date']=='1999-01-01'
                receipt=request('GET',f"/api/stock/receipts/{first['id']}",token=staff)
                corrected=request('PATCH',f"/api/stock/receipts/{first['id']}",{'qty':3.3,'reason':'no expiry quantity','expected_revision':receipt['revision']},staff)
                assert corrected['expiry_date'] is None
                purchase=request('POST','/api/purchases',{'items':[{'item_id':oid,'qty':2}]},admin,201)
                received=request('POST',f"/api/purchases/{purchase['id']}/receive",{'items':[{'purchase_item_id':purchase['items'][0]['id'],'expiry_date':None}]},admin)
                assert received['status']=='received'
                batches=request('GET',f'/api/items/{oid}/batches',token=staff)
                assert all(b['expiry_date'] is None for b in batches)
                before=snap()
                request('PATCH',f"/api/batches/{first['id']}/expiry",{'expiry_date':'2030-01-01'},admin,400)
                assert snap()==before
                request('PATCH',f'/api/items/{oid}',{'expiry_enabled':True},admin)
                stock=next(r for r in request('GET','/api/stock',token=staff) if r['item']['id']==oid)
                assert stock['missing_expiry_count']==2 and stock['latest_received_at']
                before=snap()
                for token in [staff,owner]:request('PATCH',f"/api/batches/{first['id']}/expiry",{'expiry_date':'2030-01-01'},token,403)
                request('PATCH',f"/api/batches/{first['id']}/expiry",{'expiry_date':'bad'},admin,400)
                assert snap()==before
                request('PATCH',f"/api/batches/{first['id']}/expiry",{'expiry_date':'2030-01-01'},admin)
                request('PATCH',f"/api/batches/{first['id']}/expiry",{'expiry_date':'2031-01-01'},admin,409)
                after=snap();assert before[0]==after[0] and before[2]==after[2]
                with sqlite3.connect(db) as c:
                    assert c.execute('SELECT count(*) FROM batch_expiry_updates').fetchone()[0]==1
                    assert not c.execute('PRAGMA foreign_key_check').fetchall()
                print(f'Native expiry policy: {checks} HTTP checks passed; nullable dates, toggle, forecasts, receipts, purchases, supplement permissions and audit verified')
            finally:
                proc.terminate()
                proc.wait(timeout=10)

if __name__ == '__main__':
    main()
