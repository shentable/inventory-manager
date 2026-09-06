ALTER TABLE count_entries ADD COLUMN reported_qty INTEGER;
UPDATE store_meta SET schema_version = '20260904_06' WHERE id = 1;
