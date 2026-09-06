CREATE TABLE count_comparisons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_session_id INTEGER NOT NULL REFERENCES count_sessions(id),
  second_session_id INTEGER NOT NULL REFERENCES count_sessions(id),
  resolution TEXT NOT NULL,
  trusted_session_id INTEGER REFERENCES count_sessions(id),
  note TEXT,
  confirmed_by INTEGER NOT NULL REFERENCES users(id),
  confirmed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE count_comparison_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comparison_id INTEGER NOT NULL REFERENCES count_comparisons(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  first_qty INTEGER,
  second_qty INTEGER,
  final_qty INTEGER,
  result TEXT NOT NULL,
  UNIQUE(comparison_id, item_id)
);
CREATE INDEX idx_count_comparison_entries_comparison ON count_comparison_entries(comparison_id);
ALTER TABLE count_sessions ADD COLUMN comparison_id INTEGER REFERENCES count_comparisons(id);
CREATE INDEX idx_count_sessions_comparison ON count_sessions(comparison_id);
UPDATE store_meta SET schema_version = '20260904_08' WHERE id = 1;
