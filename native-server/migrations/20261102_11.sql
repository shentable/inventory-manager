ALTER TABLE items ADD COLUMN daily_quantity_required BOOLEAN NOT NULL DEFAULT 0 CHECK (daily_quantity_required IN (0, 1));
