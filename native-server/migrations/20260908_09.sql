UPDATE items SET min_stock = CAST(round(min_stock * 10) AS INTEGER);
UPDATE batches SET qty = CAST(round(qty * 10) AS INTEGER), initial_qty = CAST(round(initial_qty * 10) AS INTEGER);
UPDATE stock_movements SET delta = CAST(round(delta * 10) AS INTEGER);
UPDATE purchase_items SET qty = CAST(round(qty * 10) AS INTEGER);
UPDATE count_entries SET qty_counted = CAST(round(qty_counted * 10) AS INTEGER), expected_qty = CAST(round(expected_qty * 10) AS INTEGER), reported_qty = CAST(round(reported_qty * 10) AS INTEGER), reviewed_qty = CAST(round(reviewed_qty * 10) AS INTEGER);
UPDATE count_comparison_entries SET first_qty = CAST(round(first_qty * 10) AS INTEGER), second_qty = CAST(round(second_qty * 10) AS INTEGER), final_qty = CAST(round(final_qty * 10) AS INTEGER);
UPDATE waste_records SET qty = CAST(round(qty * 10) AS INTEGER);
