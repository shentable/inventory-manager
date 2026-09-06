PRAGMA foreign_keys = ON;

CREATE TABLE _transaction_guard (
  value INTEGER NOT NULL CHECK (value = 1)
);

CREATE TABLE store_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  store_id TEXT NOT NULL UNIQUE,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO store_meta (id, store_id, schema_version)
VALUES (
  1,
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-a' || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  'cf_20260902_01'
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('staff', 'manager', 'admin')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  must_change_pin INTEGER NOT NULL DEFAULT 1 CHECK (must_change_pin IN (0, 1)),
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_users_username ON users(username);

CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  source_ip TEXT NOT NULL,
  failed_count INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT NOT NULL,
  locked_until TEXT,
  UNIQUE(username, source_ip)
);

CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT '个',
  shelf_life_days INTEGER NOT NULL DEFAULT 7 CHECK (shelf_life_days >= 1),
  min_stock INTEGER NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  qty INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  initial_qty INTEGER NOT NULL DEFAULT 0 CHECK (initial_qty >= 0),
  expiry_date TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  source TEXT NOT NULL DEFAULT 'init',
  note TEXT
);
CREATE INDEX idx_batches_item_expiry ON batches(item_id, expiry_date, id);

CREATE TABLE stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  delta INTEGER NOT NULL CHECK (delta <> 0),
  operation TEXT NOT NULL,
  reference_type TEXT NOT NULL,
  reference_id INTEGER,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_movements_item_id ON stock_movements(item_id, id DESC);

CREATE TABLE purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered', 'received', 'cancelled')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  received_at TEXT,
  handled_by INTEGER REFERENCES users(id),
  handled_at TEXT,
  note TEXT
);

CREATE TABLE purchase_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  qty INTEGER NOT NULL CHECK (qty >= 1)
);
CREATE INDEX idx_purchase_items_purchase ON purchase_items(purchase_id);

CREATE TABLE count_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  count_type TEXT NOT NULL DEFAULT 'weekly' CHECK (count_type IN ('daily', 'weekly')),
  business_date TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'verified', 'rejected', 'completed')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  verified_by INTEGER REFERENCES users(id),
  verified_at TEXT,
  note TEXT
);
CREATE UNIQUE INDEX uq_daily_count_date ON count_sessions(business_date) WHERE count_type = 'daily' AND status = 'completed';

CREATE TABLE count_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES count_sessions(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  qty_counted INTEGER NOT NULL CHECK (qty_counted >= 0),
  expected_qty INTEGER NOT NULL CHECK (expected_qty >= 0),
  is_enough INTEGER CHECK (is_enough IN (0, 1)),
  UNIQUE(session_id, item_id)
);
CREATE INDEX idx_count_entries_session ON count_entries(session_id);

CREATE TABLE waste_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  batch_id INTEGER REFERENCES batches(id),
  qty INTEGER NOT NULL CHECK (qty >= 1),
  reason TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
  reported_by INTEGER NOT NULL REFERENCES users(id),
  reported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  confirmed_by INTEGER REFERENCES users(id),
  confirmed_at TEXT
);
CREATE INDEX idx_waste_status ON waste_records(status, id DESC);
