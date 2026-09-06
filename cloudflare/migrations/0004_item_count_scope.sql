ALTER TABLE items ADD COLUMN daily_count_enabled INTEGER NOT NULL DEFAULT 1 CHECK (daily_count_enabled IN (0, 1));
ALTER TABLE items ADD COLUMN weekly_count_enabled INTEGER NOT NULL DEFAULT 1 CHECK (weekly_count_enabled IN (0, 1));
UPDATE store_meta SET schema_version = '20260904_07' WHERE id = 1;
