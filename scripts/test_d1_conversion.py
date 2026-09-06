#!/usr/bin/env python3
"""Black-box conversion fixture for the D1 to native SQLite bridge."""

from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    migrator = ROOT / "native-server" / "target" / "debug" / "sandwich-server"
    migration = (ROOT / "cloudflare" / "migrations" / "0001_initial.sql").read_text(encoding="utf-8")
    fixture = migration + """
INSERT INTO users(id,username,display_name,pin_hash,role,active,must_change_pin,token_version)
VALUES(1,'admin','管理员','pbkdf2$fixture','admin',1,0,7);
INSERT INTO login_attempts(username,source_ip,failed_count,window_started_at)
VALUES('admin','198.51.100.10',2,'2026-09-03T00:00:00Z');
INSERT INTO items(id,name,unit,shelf_life_days,min_stock) VALUES(1,'测试原料','个',7,2);
INSERT INTO batches(id,item_id,qty,initial_qty,expiry_date) VALUES(1,1,5,5,'2026-12-31');
INSERT INTO stock_movements(item_id,batch_id,delta,operation,reference_type,reference_id,actor_id)
VALUES(1,1,5,'fixture','fixture',1,1);
"""
    with tempfile.TemporaryDirectory(prefix="sandwich-d1-convert-") as directory:
        temporary = Path(directory)
        sql = temporary / "d1.sql"
        output = temporary / "app.db"
        sql.write_text(fixture, encoding="utf-8")
        completed = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts" / "d1_to_native.py"),
                "--input",
                str(sql),
                "--output",
                str(output),
                "--migrator",
                str(migrator),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        manifest = json.loads(completed.stdout)
        assert manifest["integrity_check"] == ["ok"]
        assert manifest["foreign_key_check"] == []
        assert manifest["row_counts"]["users"] == 1
        assert manifest["inventory"] == [{"item_id": 1, "name": "测试原料", "stock": 5}]
        connection = sqlite3.connect(output)
        try:
            assert connection.execute("SELECT token_version FROM users WHERE id=1").fetchone()[0] == 8
            assert connection.execute("SELECT count(*) FROM login_attempts").fetchone()[0] == 0
            assert connection.execute("SELECT store_id FROM store_meta WHERE id=1").fetchone()[0]
        finally:
            connection.close()
    print("D1 conversion fixture passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
