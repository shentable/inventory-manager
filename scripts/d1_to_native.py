#!/usr/bin/env python3
"""Convert an official Wrangler D1 SQL export into the native SQLite format."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import uuid
from pathlib import Path


BUSINESS_TABLES = (
    "users",
    "login_attempts",
    "items",
    "batches",
    "stock_movements",
    "purchases",
    "purchase_items",
    "count_sessions",
    "count_entries",
    "count_comparisons",
    "count_comparison_entries",
    "waste_records",
)


def scalar(connection: sqlite3.Connection, query: str, parameters: tuple[object, ...] = ()) -> object:
    row = connection.execute(query, parameters).fetchone()
    if row is None:
        raise RuntimeError(f"query returned no row: {query}")
    return row[0]


def build_manifest(database: Path) -> dict[str, object]:
    connection = sqlite3.connect(database)
    connection.row_factory = sqlite3.Row
    try:
        integrity_rows = [row[0] for row in connection.execute("PRAGMA integrity_check")]
        foreign_key_rows = [dict(row) for row in connection.execute("PRAGMA foreign_key_check")]
        if integrity_rows != ["ok"]:
            raise RuntimeError(f"integrity_check failed: {integrity_rows}")
        if foreign_key_rows:
            raise RuntimeError(f"foreign_key_check failed: {foreign_key_rows}")

        table_names = {
            row[0]
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        missing = [table for table in BUSINESS_TABLES if table not in table_names]
        if missing:
            raise RuntimeError(f"missing business tables: {', '.join(missing)}")

        row_counts = {
            table: int(scalar(connection, f'SELECT count(*) FROM "{table}"'))
            for table in BUSINESS_TABLES
        }
        inventory = [
            dict(row)
            for row in connection.execute(
                """
                SELECT i.id item_id, i.name,
                       COALESCE(SUM(CASE WHEN b.qty > 0 THEN b.qty ELSE 0 END), 0) / 10.0 stock
                FROM items i LEFT JOIN batches b ON b.item_id = i.id
                GROUP BY i.id, i.name ORDER BY i.id
                """
            )
        ]
        movement_summary = [
            dict(row)
            for row in connection.execute(
                """
                SELECT operation, count(*) movement_count, COALESCE(sum(delta), 0) / 10.0 net_delta
                FROM stock_movements GROUP BY operation ORDER BY operation
                """
            )
        ]
        meta = connection.execute(
            "SELECT store_id, schema_version, created_at FROM store_meta WHERE id = 1"
        ).fetchone()
        if meta is None:
            raise RuntimeError("store_meta row is missing")
    finally:
        connection.close()

    digest = hashlib.sha256(database.read_bytes()).hexdigest()
    return {
        "database": str(database.resolve()),
        "sha256": digest,
        "size_bytes": database.stat().st_size,
        "store_id": meta["store_id"],
        "db_schema": meta["schema_version"],
        "created_at": meta["created_at"],
        "row_counts": row_counts,
        "inventory": inventory,
        "movement_summary": movement_summary,
        "integrity_check": integrity_rows,
        "foreign_key_check": foreign_key_rows,
    }


def convert(source: Path, output: Path, migrator: Path) -> dict[str, object]:
    if not source.is_file():
        raise RuntimeError(f"D1 export does not exist: {source}")
    if not migrator.is_file() or not os.access(migrator, os.X_OK):
        raise RuntimeError(f"native migrator is not executable: {migrator}")
    if output.exists() or output.is_symlink():
        raise RuntimeError(f"refusing to overwrite output: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.{uuid.uuid4().hex}.tmp")
    try:
        connection = sqlite3.connect(temporary)
        try:
            connection.executescript(source.read_text(encoding="utf-8"))
        finally:
            connection.close()

        subprocess.run(
            [str(migrator), "migrate", "--db", str(temporary)],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        connection = sqlite3.connect(temporary)
        try:
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("DELETE FROM login_attempts")
            connection.execute("UPDATE users SET token_version = token_version + 1")
            connection.commit()
            connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            connection.execute("PRAGMA journal_mode=DELETE")
        finally:
            connection.close()

        os.replace(temporary, output)
        return build_manifest(output)
    except Exception:
        temporary.unlink(missing_ok=True)
        Path(f"{temporary}-wal").unlink(missing_ok=True)
        Path(f"{temporary}-shm").unlink(missing_ok=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="official wrangler d1 export SQL")
    parser.add_argument("--output", required=True, type=Path, help="new native SQLite database")
    parser.add_argument("--migrator", required=True, type=Path, help="local sandwich-server binary")
    parser.add_argument("--manifest", type=Path, help="also write the JSON verification manifest")
    args = parser.parse_args()
    try:
        manifest = convert(args.input.resolve(), args.output.resolve(), args.migrator.resolve())
        serialized = json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        if args.manifest:
            manifest_path = args.manifest.resolve()
            if manifest_path.exists() or manifest_path.is_symlink():
                raise RuntimeError(f"refusing to overwrite manifest: {manifest_path}")
            manifest_path.parent.mkdir(parents=True, exist_ok=True)
            manifest_path.write_text(serialized, encoding="utf-8")
        sys.stdout.write(serialized)
        return 0
    except Exception as error:
        print(f"D1 conversion failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
