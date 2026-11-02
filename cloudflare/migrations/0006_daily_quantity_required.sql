ALTER TABLE items ADD COLUMN daily_quantity_required INTEGER NOT NULL DEFAULT 0;
UPDATE store_meta SET schema_version = '20261102_d1_06' WHERE id = 1;
