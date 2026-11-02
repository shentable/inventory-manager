CREATE TABLE IF NOT EXISTS batch_expiry_updates (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 batch_id INTEGER NOT NULL REFERENCES batches(id),
 old_expiry_date VARCHAR(10), new_expiry_date VARCHAR(10) NOT NULL,
 actor_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_batch_expiry_updates_batch_id ON batch_expiry_updates(batch_id);
