CREATE TABLE IF NOT EXISTS count_comparisons (
 id INTEGER PRIMARY KEY,
 first_session_id INTEGER NOT NULL REFERENCES count_sessions(id),
 second_session_id INTEGER NOT NULL REFERENCES count_sessions(id),
 resolution VARCHAR(32) NOT NULL,
 trusted_session_id INTEGER REFERENCES count_sessions(id),
 note VARCHAR(255),
 confirmed_by INTEGER NOT NULL REFERENCES users(id),
 confirmed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS count_comparison_entries (
 id INTEGER PRIMARY KEY,
 comparison_id INTEGER NOT NULL REFERENCES count_comparisons(id) ON DELETE CASCADE,
 item_id INTEGER NOT NULL REFERENCES items(id),
 first_qty INTEGER,
 second_qty INTEGER,
 final_qty INTEGER,
 result VARCHAR(24) NOT NULL,
 UNIQUE(comparison_id,item_id)
);
CREATE INDEX IF NOT EXISTS ix_count_comparison_entries_comparison_id
ON count_comparison_entries(comparison_id);
