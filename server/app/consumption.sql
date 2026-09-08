-- Shared by Python and Rust. All timestamps are UTC; business dates are UTC+8.
-- Read-only estimates: never replay count adjustments as receipts/consumption.
WITH sources AS (
  SELECT e.item_id, e.final_qty AS qty, c.id AS comparison_id, c.confirmed_at,
         CASE WHEN c.resolution = 'trusted_first' THEN a.id
              WHEN c.resolution = 'trusted_second' THEN b.id
              WHEN (a.created_at, a.id) > (b.created_at, b.id) THEN a.id ELSE b.id END AS session_id,
         CASE WHEN c.resolution = 'trusted_first' THEN a.created_at
              WHEN c.resolution = 'trusted_second' THEN b.created_at
              ELSE max(a.created_at, b.created_at) END AS observed_at,
         CASE WHEN c.resolution = 'manager_corrected' AND e.result = 'different' THEN 1 ELSE 0 END AS corrected
  FROM count_comparison_entries e
  JOIN count_comparisons c ON c.id = e.comparison_id
  JOIN count_sessions a ON a.id = c.first_session_id
  JOIN count_sessions b ON b.id = c.second_session_id
  WHERE e.final_qty IS NOT NULL AND c.resolution <> 'recount_required'
    AND a.status = 'verified' AND b.status = 'verified'
    AND c.confirmed_at <= :as_of
),
anchors AS (
  SELECT s.*,
    CASE WHEN corrected = 1 THEN 'corrected_time_unknown'
         WHEN observed_at > confirmed_at THEN 'invalid_time'
         WHEN julianday(confirmed_at) - julianday(observed_at) > 0.25 THEN 'late_confirmation'
         WHEN EXISTS (
           SELECT 1 FROM stock_movements m WHERE m.item_id = s.item_id
             AND m.created_at > s.observed_at AND m.created_at <= s.confirmed_at
             AND NOT (m.reference_type = 'count_comparison' AND m.reference_id = s.comparison_id)
         ) THEN 'movement_during_confirmation'
         WHEN EXISTS (
           SELECT 1 FROM waste_records w WHERE w.item_id = s.item_id AND w.status = 'confirmed'
             AND w.reported_at <= s.observed_at AND w.confirmed_at > s.observed_at
         ) THEN 'waste_crosses_count'
         ELSE NULL END AS issue
  FROM sources s
),
ordered AS (
  SELECT *, lag(qty) OVER w AS opening_qty, lag(observed_at) OVER w AS start_at,
    lag(comparison_id) OVER w AS opening_comparison_id, lag(issue) OVER w AS opening_issue,
    row_number() OVER (PARTITION BY item_id ORDER BY observed_at DESC, comparison_id DESC) AS recency
  FROM anchors WINDOW w AS (PARTITION BY item_id ORDER BY observed_at, comparison_id)
),
period_inputs AS (
  SELECT o.*, julianday(observed_at) - julianday(start_at) AS elapsed_days,
    coalesce((SELECT sum(m.delta) FROM stock_movements m
      WHERE m.item_id = o.item_id AND m.operation IN ('stock_receive', 'purchase_receive')
        AND m.created_at > o.start_at AND m.created_at <= o.observed_at), 0) AS received,
    coalesce((SELECT sum(w.qty) FROM waste_records w
      WHERE w.item_id = o.item_id AND w.status = 'confirmed'
        AND w.reported_at > o.start_at AND w.reported_at <= o.observed_at), 0) AS waste,
    EXISTS (SELECT 1 FROM waste_records w WHERE w.item_id = o.item_id AND w.status = 'pending'
      AND w.reported_at <= o.observed_at) AS pending_waste
  FROM ordered o WHERE start_at IS NOT NULL
    AND observed_at >= datetime(:as_of, '-' || :days || ' days')
),
period_values AS (
  SELECT *, opening_qty + received - qty AS gross_depletion,
    opening_qty + received - qty - waste AS consumption
  FROM period_inputs
),
periods AS (
  SELECT *, CASE
    WHEN issue IS NOT NULL THEN issue WHEN opening_issue IS NOT NULL THEN opening_issue
    WHEN elapsed_days < 1 THEN 'short_period'
    WHEN start_at < datetime(:as_of, '-' || :days || ' days') THEN 'outside_window'
    WHEN pending_waste THEN 'pending_waste'
    WHEN consumption < 0 THEN 'negative_consumption'
    ELSE NULL END AS exclusion
  FROM period_values
),
rates AS (
  SELECT item_id, count(*) AS period_count,
    sum(CASE WHEN exclusion IS NULL THEN 1 ELSE 0 END) AS valid_periods,
    sum(CASE WHEN exclusion IS NULL THEN consumption ELSE 0 END) AS consumption,
    sum(CASE WHEN exclusion IS NULL THEN waste ELSE 0 END) AS waste,
    sum(CASE WHEN exclusion IS NULL THEN elapsed_days ELSE 0 END) AS elapsed_days,
    sum(CASE WHEN exclusion IS NULL THEN consumption ELSE 0 END) * 1.0 /
      nullif(sum(CASE WHEN exclusion IS NULL THEN elapsed_days ELSE 0 END), 0) AS daily_rate
  FROM periods GROUP BY item_id
),
item_inputs AS (
  SELECT i.id AS item_id, i.name, i.category, i.unit, i.min_stock, i.shelf_life_days,
    i.sort_order, a.qty AS last_count_qty, a.observed_at AS last_count_at,
    a.comparison_id AS last_comparison_id, a.issue AS anchor_issue,
    julianday(:as_of) - julianday(a.observed_at) AS count_age_days,
    coalesce(r.period_count, 0) AS period_count, coalesce(r.valid_periods, 0) AS valid_periods,
    r.consumption, r.waste, r.elapsed_days, r.daily_rate,
    (SELECT exclusion FROM periods p WHERE p.item_id = i.id ORDER BY observed_at DESC, comparison_id DESC LIMIT 1) AS latest_exclusion,
    coalesce((SELECT sum(qty) FROM batches WHERE item_id = i.id), 0) AS book_stock,
    coalesce((SELECT sum(qty) FROM batches WHERE item_id = i.id AND expiry_date < date(:as_of, '+8 hours')), 0) AS expired_qty,
    coalesce((SELECT sum(qty) FROM batches WHERE item_id = i.id AND expiry_date <= date(:as_of, '+8 hours', '+3 days')), 0) AS expiring_qty,
    coalesce((SELECT sum(m.delta) FROM stock_movements m WHERE m.item_id = i.id
      AND m.operation IN ('stock_receive', 'purchase_receive')
      AND m.created_at > a.observed_at AND m.created_at <= :as_of), 0) AS received_since_count,
    coalesce((SELECT sum(w.qty) FROM waste_records w WHERE w.item_id = i.id AND w.status = 'confirmed'
      AND w.reported_at > a.observed_at AND w.reported_at <= :as_of), 0) AS waste_since_count,
    coalesce((SELECT sum(w.qty) FROM waste_records w WHERE w.item_id = i.id AND w.status = 'pending'), 0) AS pending_waste_qty,
    coalesce((SELECT sum(pi.qty) FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id
      WHERE pi.item_id = i.id AND p.status = 'ordered'), 0) AS ordered_qty,
    EXISTS (SELECT 1 FROM count_entries e JOIN count_sessions c ON c.id = e.session_id
      WHERE e.item_id = i.id AND c.count_type = 'daily' AND c.status = 'completed'
        AND c.business_date = date(:as_of, '+8 hours') AND e.is_enough = 0) AS daily_shortage
  FROM items i LEFT JOIN ordered a ON a.item_id = i.id AND a.recency = 1
  LEFT JOIN rates r ON r.item_id = i.id WHERE i.active = 1
),
quality AS (
  SELECT *, CASE
    WHEN last_count_at IS NULL THEN 'no_count'
    WHEN anchor_issue IS NOT NULL THEN anchor_issue
    WHEN count_age_days > 14 THEN 'stale_count'
    WHEN pending_waste_qty > 0 THEN 'pending_waste'
    WHEN expired_qty > 0 THEN 'expired_stock'
    WHEN latest_exclusion IS NOT NULL THEN latest_exclusion
    WHEN valid_periods = 0 THEN 'insufficient_history'
    WHEN daily_rate = 0 THEN 'zero_rate'
    ELSE NULL END AS forecast_issue
  FROM item_inputs
),
estimates AS (
  SELECT *, CASE WHEN forecast_issue IS NULL THEN
    max(0, last_count_qty + received_since_count - waste_since_count - daily_rate * count_age_days)
    ELSE NULL END AS estimated_qty
  FROM quality
),
forecasts AS (
  SELECT *, estimated_qty / nullif(daily_rate, 0) AS days_remaining,
    CASE WHEN estimated_qty IS NOT NULL THEN max(0,
      min(daily_rate * (:lead_days + :coverage_days) + min_stock,
          daily_rate * (:lead_days + shelf_life_days)) - estimated_qty)
      ELSE NULL END AS replenishment_gap
  FROM estimates
)
SELECT json_object(
  'item_id', f.item_id, 'name', name, 'category', category, 'unit', unit,
  'min_stock', min_stock / 10.0, 'book_stock', book_stock / 10.0,
  'last_count_qty', last_count_qty / 10.0, 'last_count_at', replace(last_count_at, ' ', 'T') || 'Z',
  'last_comparison_id', last_comparison_id, 'count_age_days', round(count_age_days, 1),
  'period_count', period_count, 'valid_periods', valid_periods,
  'consumption', consumption / 10.0, 'waste', waste / 10.0, 'sample_days', round(elapsed_days, 1),
  'daily_rate', round(daily_rate / 10.0, 1), 'forecast_issue', forecast_issue,
  'estimated_qty', round(estimated_qty / 10.0, 1), 'days_remaining', round(days_remaining, 1),
  'replenishment_gap', CASE WHEN replenishment_gap IS NULL THEN NULL
    ELSE (cast(replenishment_gap AS INTEGER) + (replenishment_gap > cast(replenishment_gap AS INTEGER))) / 10.0 END,
  'received_since_count', received_since_count / 10.0, 'waste_since_count', waste_since_count / 10.0,
  'ordered_qty', ordered_qty / 10.0, 'pending_waste_qty', pending_waste_qty / 10.0,
  'expired_qty', expired_qty / 10.0, 'expiring_qty', expiring_qty / 10.0, 'daily_shortage', json(CASE WHEN daily_shortage THEN 'true' ELSE 'false' END),
  'status', CASE WHEN daily_shortage THEN 'shortage'
    WHEN forecast_issue IS NOT NULL THEN 'review'
    WHEN days_remaining <= :lead_days OR estimated_qty < min_stock THEN 'reorder'
    ELSE 'ok' END,
  'periods', json((SELECT coalesce(json_group_array(json(p)), '[]') FROM (
    SELECT json_object('opening_comparison_id', opening_comparison_id, 'closing_comparison_id', comparison_id,
      'start_at', replace(start_at, ' ', 'T') || 'Z', 'end_at', replace(observed_at, ' ', 'T') || 'Z',
      'opening_qty', opening_qty / 10.0, 'closing_qty', qty / 10.0, 'received', received / 10.0, 'waste', waste / 10.0,
      'gross_depletion', gross_depletion / 10.0, 'consumption', consumption / 10.0,
      'days', round(elapsed_days, 1), 'daily_rate', round(consumption / nullif(elapsed_days, 0) / 10.0, 1),
      'exclusion', exclusion) AS p
    FROM periods WHERE item_id = f.item_id ORDER BY observed_at DESC, comparison_id DESC
  )))
) AS data
FROM forecasts f
ORDER BY CASE WHEN daily_shortage THEN 0 WHEN forecast_issue IS NULL AND
  (days_remaining <= :lead_days OR estimated_qty < min_stock) THEN 1
  WHEN forecast_issue IS NOT NULL THEN 2 ELSE 3 END,
  coalesce(days_remaining, 999999), sort_order, item_id;
