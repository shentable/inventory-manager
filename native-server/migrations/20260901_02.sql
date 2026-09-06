PRAGMA foreign_keys=ON;
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY, username VARCHAR(64) NOT NULL UNIQUE,
 display_name VARCHAR(128) NOT NULL, pin_hash VARCHAR(256) NOT NULL,
 role VARCHAR(16) NOT NULL DEFAULT 'staff', active BOOLEAN NOT NULL DEFAULT 1,
 must_change_pin BOOLEAN NOT NULL DEFAULT 1, token_version INTEGER NOT NULL DEFAULT 0,
 created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_users_username ON users(username);

CREATE TABLE IF NOT EXISTS login_attempts (
 id INTEGER PRIMARY KEY, username VARCHAR(64) NOT NULL, source_ip VARCHAR(64) NOT NULL,
 failed_count INTEGER NOT NULL DEFAULT 0, window_started_at DATETIME NOT NULL,
 locked_until DATETIME, UNIQUE(username, source_ip)
);
CREATE INDEX IF NOT EXISTS ix_login_attempts_username ON login_attempts(username);

CREATE TABLE IF NOT EXISTS items (
 id INTEGER PRIMARY KEY, name VARCHAR(128) NOT NULL UNIQUE, category VARCHAR(64) NOT NULL DEFAULT '',
 unit VARCHAR(16) NOT NULL DEFAULT '个', shelf_life_days INTEGER NOT NULL DEFAULT 7,
 min_stock INTEGER NOT NULL DEFAULT 0,
 daily_count_enabled BOOLEAN NOT NULL DEFAULT 1,
 weekly_count_enabled BOOLEAN NOT NULL DEFAULT 1,
 active BOOLEAN NOT NULL DEFAULT 1,
 sort_order INTEGER NOT NULL DEFAULT 0, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_items_name ON items(name);

CREATE TABLE IF NOT EXISTS batches (
 id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id), qty INTEGER NOT NULL DEFAULT 0,
 initial_qty INTEGER NOT NULL DEFAULT 0, expiry_date VARCHAR(10) NOT NULL,
 received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, source VARCHAR(16) NOT NULL DEFAULT 'init',
 note VARCHAR(255)
);
CREATE INDEX IF NOT EXISTS ix_batches_item_id ON batches(item_id);

CREATE TABLE IF NOT EXISTS purchases (
 id INTEGER PRIMARY KEY, status VARCHAR(16) NOT NULL DEFAULT 'ordered',
 created_by INTEGER NOT NULL REFERENCES users(id), created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 received_at DATETIME, handled_by INTEGER REFERENCES users(id), handled_at DATETIME, note VARCHAR(255)
);
CREATE TABLE IF NOT EXISTS purchase_items (
 id INTEGER PRIMARY KEY, purchase_id INTEGER NOT NULL REFERENCES purchases(id),
 item_id INTEGER NOT NULL REFERENCES items(id), qty INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_purchase_items_purchase_id ON purchase_items(purchase_id);

CREATE TABLE IF NOT EXISTS count_sessions (
 id INTEGER PRIMARY KEY, status VARCHAR(16) NOT NULL DEFAULT 'submitted',
 created_by INTEGER NOT NULL REFERENCES users(id), created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 verified_by INTEGER REFERENCES users(id), verified_at DATETIME, note VARCHAR(255),
 review_reason VARCHAR(32), review_note VARCHAR(255)
);
CREATE TABLE IF NOT EXISTS count_entries (
 id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES count_sessions(id),
 item_id INTEGER NOT NULL REFERENCES items(id), qty_counted INTEGER NOT NULL, expected_qty INTEGER NOT NULL,
 reviewed_qty INTEGER, reported_qty INTEGER
);
CREATE INDEX IF NOT EXISTS ix_count_entries_session_id ON count_entries(session_id);

CREATE TABLE IF NOT EXISTS waste_records (
 id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id),
 batch_id INTEGER REFERENCES batches(id), qty INTEGER NOT NULL, reason VARCHAR(64) NOT NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'pending', reported_by INTEGER NOT NULL REFERENCES users(id),
 reported_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, confirmed_by INTEGER REFERENCES users(id),
 confirmed_at DATETIME
);
CREATE INDEX IF NOT EXISTS ix_waste_records_item_id ON waste_records(item_id);

CREATE TABLE IF NOT EXISTS stock_movements (
 id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id),
 batch_id INTEGER NOT NULL REFERENCES batches(id), delta INTEGER NOT NULL,
 operation VARCHAR(32) NOT NULL, reference_type VARCHAR(32) NOT NULL,
 reference_id INTEGER, actor_id INTEGER NOT NULL REFERENCES users(id),
 created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_stock_movements_item_id ON stock_movements(item_id);
CREATE INDEX IF NOT EXISTS ix_stock_movements_batch_id ON stock_movements(batch_id);
CREATE INDEX IF NOT EXISTS ix_stock_movements_actor_id ON stock_movements(actor_id);

CREATE TABLE IF NOT EXISTS store_meta (
 id INTEGER PRIMARY KEY, store_id VARCHAR(36) NOT NULL UNIQUE,
 schema_version VARCHAR(32) NOT NULL, created_at DATETIME NOT NULL
);
CREATE TABLE IF NOT EXISTS alembic_version (
 version_num VARCHAR(32) NOT NULL PRIMARY KEY
);
