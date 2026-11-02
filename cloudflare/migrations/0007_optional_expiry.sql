-- D1 runs migrations transactionally; defer references until the replacement
-- table again occupies the original name. No referencing rows are removed.
PRAGMA defer_foreign_keys = ON;
ALTER TABLE items ADD COLUMN expiry_enabled INTEGER NOT NULL DEFAULT 1 CHECK (expiry_enabled IN (0, 1));
CREATE TABLE batches_expiry_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  qty INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  initial_qty INTEGER NOT NULL DEFAULT 0 CHECK (initial_qty >= 0),
  expiry_date TEXT,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  source TEXT NOT NULL DEFAULT 'init',
  note TEXT
);
INSERT INTO batches_expiry_new SELECT * FROM batches;
DROP TABLE batches;
ALTER TABLE batches_expiry_new RENAME TO batches;
CREATE INDEX idx_batches_item_expiry ON batches(item_id, expiry_date, id);
CREATE TABLE batch_expiry_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  old_expiry_date TEXT,
  new_expiry_date TEXT NOT NULL,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_batch_expiry_updates_batch_id ON batch_expiry_updates(batch_id, id);
UPDATE store_meta SET schema_version = '20261102_d1_07' WHERE id = 1;

-- Verify final references before clearing deferred DROP-table bookkeeping.
CREATE TABLE _expiry_fk_guard (violations INTEGER CHECK (violations=0));
INSERT INTO _expiry_fk_guard SELECT count(*) FROM pragma_foreign_key_check;
DROP TABLE _expiry_fk_guard;
PRAGMA defer_foreign_keys = OFF;
