#!/usr/bin/env python3
"""Native daily-required regression against an isolated, temporary database."""
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


def main():
    with tempfile.TemporaryDirectory(prefix='daily-required-') as directory:
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
                legacy = request('GET','/api/items',token=admin)
                assert all(row['daily_quantity_required'] is False for row in legacy)
                item = request('POST','/api/items',{'name':'Daily required kg','unit':'kg'},admin,201)
                assert item['daily_quantity_required'] is False
                item_id = item['id']
                enabled = request('PATCH',f'/api/items/{item_id}',{'daily_quantity_required':True},admin)
                assert enabled['daily_quantity_required'] is True
                assert next(row['item'] for row in request('GET','/api/stock',token=staff) if row['item']['id']==item_id)['daily_quantity_required'] is True
                before = session_snapshot()
                def submit(entries, expected=400):
                    return request('POST','/api/counts',{'count_type':'daily','overwrite_daily':True,'entries':entries},staff,expected)
                # Missing quantities fail for enough and shortage; prior valid entries never partially persist.
                for enough in [True, False]:
                    for missing in [{}, {'qty':None}]:
                        submit([{'item_id':1,'enough':True}, {'item_id':item_id,'enough':enough,**missing}])
                        assert session_snapshot() == before
                # An old page can send false, but only DB configuration is authoritative.
                submit([{'item_id':item_id,'enough':True,'daily_quantity_required':False}])
                assert session_snapshot() == before
                def consumption_metrics():
                    rows = request('GET','/api/owner/dashboard',token=admin)['consumption']['items']
                    keys = ['last_count_qty','last_count_at','consumption','daily_rate','book_stock','valid_periods']
                    return {row['item_id']: {key:row.get(key) for key in keys} for row in rows}
                baseline = consumption_metrics()
                for enough, qty in [(True,0),(False,0),(True,1.2),(False,2.3)]:
                    result = submit([{'item_id':item_id,'enough':enough,'qty':qty}],201)
                    count = request('GET',f"/api/counts/{result['id']}",token=staff)
                    assert count['entries'][0]['reported_qty'] == qty
                    assert consumption_metrics() == baseline
                    after = session_snapshot()
                    assert after[2:] == before[2:], 'Daily reference must not mutate batches, movements, or users'
                # Omitted update retains required=true; disabling count participation preserves the policy.
                assert request('PATCH',f'/api/items/{item_id}',{'name':'Renamed daily kg'},admin)['daily_quantity_required'] is True
                assert request('PATCH',f'/api/items/{item_id}',{'daily_count_enabled':False},admin)['daily_quantity_required'] is True
                submit([{'item_id':item_id,'enough':True,'qty':0}])
                request('PATCH',f'/api/items/{item_id}',{'daily_count_enabled':True,'daily_quantity_required':False},admin)
                submit([{'item_id':item_id,'enough':True}],201)
                submit([{'item_id':item_id,'enough':False}])
                request('PATCH',f'/api/items/{item_id}',{'daily_quantity_required':True},staff,403)
                request('POST','/api/items',{'name':'Created enabled','daily_quantity_required':True},admin,201)
                print(f'Native daily quantity: {checks} HTTP checks passed; zero/decimal/reference-only/atomic rejection verified')
            finally:
                proc.terminate()
                proc.wait(timeout=10)

if __name__ == '__main__':
    main()
