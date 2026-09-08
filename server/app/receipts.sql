-- Existing direct receipt batches are discovered from their immutable opening movement.
SELECT json_object(
  'id', b.id, 'item_id', b.item_id, 'item_name', i.name, 'unit', i.unit,
  'original_qty', m.delta / 10.0,
  'qty', (m.delta + coalesce((SELECT sum(new_qty-old_qty) FROM stock_receipt_corrections WHERE batch_id=b.id),0)) / 10.0,
  'remaining_qty', b.qty / 10.0, 'expiry_date', b.expiry_date, 'note', b.note,
  'received_at', replace(b.received_at,' ','T') || 'Z',
  'received_by', m.actor_id, 'received_by_name', u.display_name,
  'revision', coalesce((SELECT max(id) FROM stock_receipt_corrections WHERE batch_id=b.id),0),
  'quantity_locked', json(CASE WHEN EXISTS (
    SELECT 1 FROM count_entries ce JOIN count_sessions cs ON cs.id=ce.session_id
    WHERE ce.item_id=b.item_id AND cs.status='verified' AND cs.count_type='weekly'
      AND cs.created_at>=b.received_at AND (cs.comparison_id IS NULL OR ce.reviewed_qty IS NOT NULL)
  ) THEN 'true' ELSE 'false' END),
  'corrections', json((SELECT coalesce(json_group_array(json(row)), '[]') FROM (
    SELECT json_object('id', c.id, 'old_qty', c.old_qty/10.0, 'new_qty', c.new_qty/10.0,
      'old_expiry_date', c.old_expiry_date, 'new_expiry_date', c.new_expiry_date,
      'old_note', c.old_note, 'new_note', c.new_note, 'reason', c.reason,
      'actor_id', c.actor_id, 'actor_name', a.display_name,
      'created_at', replace(c.created_at,' ','T') || 'Z') AS row
    FROM stock_receipt_corrections c JOIN users a ON a.id=c.actor_id
    WHERE c.batch_id=b.id ORDER BY c.id DESC
  )))
) AS data
FROM batches b JOIN items i ON i.id=b.item_id
JOIN stock_movements m ON m.id=(SELECT min(id) FROM stock_movements WHERE batch_id=b.id AND operation='stock_receive')
JOIN users u ON u.id=m.actor_id
WHERE b.source='receive' AND (:owner IS NULL OR m.actor_id=:owner)
  AND (:batch_id IS NULL OR b.id=:batch_id)
  AND (i.name LIKE :search OR u.display_name LIKE :search OR coalesce(b.note,'') LIKE :search)
ORDER BY b.received_at DESC, b.id DESC LIMIT :limit OFFSET :offset;
