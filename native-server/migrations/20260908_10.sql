CREATE TABLE IF NOT EXISTS stock_receipt_corrections (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  old_qty INTEGER NOT NULL,
  new_qty INTEGER NOT NULL,
  old_expiry_date VARCHAR(10) NOT NULL,
  new_expiry_date VARCHAR(10) NOT NULL,
  old_note VARCHAR(255),
  new_note VARCHAR(255),
  reason VARCHAR(255) NOT NULL,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  created_at DATETIME NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_stock_receipt_corrections_batch_id ON stock_receipt_corrections(batch_id);
