ALTER TABLE count_sessions ADD COLUMN review_reason TEXT;
ALTER TABLE count_sessions ADD COLUMN review_note TEXT;
ALTER TABLE count_entries ADD COLUMN reviewed_qty INTEGER CHECK (reviewed_qty >= 0);
UPDATE store_meta SET schema_version = '20260904_05' WHERE id = 1;
