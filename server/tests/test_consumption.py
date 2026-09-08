"""Balance reconstruction, exclusion rules and manager-only access."""
from datetime import datetime, timedelta

import pytest
from sqlalchemy import func, select

from app.models import (
    CountComparison, CountComparisonEntry, CountEntry, CountSession,
    Purchase, PurchaseItem, StockMovement, WasteRecord,
)
from app.routers import consumption

NOW = datetime(2026, 9, 8, 4)


@pytest.fixture
def scenario(db, make_user, make_item, make_batch, monkeypatch):
    monkeypatch.setattr(consumption, "utcnow", lambda: NOW)
    actor = make_user(username="reviewer", role="manager")
    first = make_user(username="counter1")
    second = make_user(username="counter2")
    item = make_item(name="面包", unit="袋", min_stock=10, shelf_life_days=30)
    batch = make_batch(item.id, 63, "2099-01-01")

    def anchor(qty, at, resolution="no_difference", result="same"):
        a = CountSession(created_by=first.id, created_at=at - timedelta(minutes=5), status="verified")
        b = CountSession(created_by=second.id, created_at=at, status="verified")
        db.add_all([a, b])
        db.flush()
        pair = CountComparison(first_session_id=a.id, second_session_id=b.id,
                               confirmed_by=actor.id, confirmed_at=at + timedelta(minutes=2),
                               resolution=resolution)
        db.add(pair)
        db.flush()
        a.comparison_id = b.comparison_id = pair.id
        # Both reviewed entries hold the same final quantity: never count twice.
        for session in (a, b):
            db.add(CountEntry(session_id=session.id, item_id=item.id,
                              qty_counted=qty, reviewed_qty=qty, expected_qty=999))
        entry = CountComparisonEntry(comparison_id=pair.id, item_id=item.id,
                                     first_qty=qty, second_qty=qty, final_qty=qty, result=result)
        db.add(entry)
        db.commit()
        return pair, entry

    def movement(qty, at, operation="stock_receive", reference_id=None):
        db.add(StockMovement(item_id=item.id, batch_id=batch.id, delta=qty, operation=operation,
                             actor_id=actor.id, created_at=at,
                             reference_type="count_comparison" if reference_id else "manual",
                             reference_id=reference_id))
        db.commit()

    def waste(qty, at, status="confirmed", confirmed_at=None):
        row = WasteRecord(item_id=item.id, qty=qty, reason="损坏", status=status,
                          reported_by=first.id, reported_at=at,
                          confirmed_by=actor.id if status == "confirmed" else None,
                          confirmed_at=(confirmed_at or at) if status == "confirmed" else None)
        db.add(row)
        db.commit()
        return row

    return item, batch, actor, anchor, movement, waste


def get(client, auth, token, params=""):
    response = client.get("/api/consumption" + params, headers=auth(token))
    assert response.status_code == 200, response.text
    return response.json()["items"][0]


def test_balance_forecast_no_double_count_and_read_only(client, auth, manager_token, db, scenario):
    item, batch, actor, anchor, movement, waste = scenario
    start, end = NOW - timedelta(days=9), NOW - timedelta(days=2)
    a, _ = anchor(100, start)
    b, _ = anchor(45, end)
    movement(60, start + timedelta(days=2), "purchase_receive")
    waste(5, start + timedelta(days=3))
    movement(-110, b.confirmed_at, "count_shortage", b.id)
    movement(20, end + timedelta(days=1))
    waste(2, end + timedelta(days=1))
    purchase = Purchase(created_by=actor.id, status="ordered")
    db.add(purchase)
    db.flush()
    db.add(PurchaseItem(purchase_id=purchase.id, item_id=item.id, qty=1000))
    db.commit()
    before = db.scalar(select(func.count(StockMovement.id)))

    row = get(client, auth, manager_token, "?coverage_days=3")
    assert row["valid_periods"] == row["period_count"] == 1
    assert row["consumption"] == 110 and row["waste"] == 5
    assert row["daily_rate"] == 15.7
    assert row["estimated_qty"] == 31.6 and row["days_remaining"] == 2
    assert row["replenishment_gap"] == 57  # Orders without arrival dates do not cancel the gap.
    assert row["ordered_qty"] == 1000
    assert row["forecast_issue"] is None
    assert row["periods"][0]["gross_depletion"] == 115
    assert row["periods"][0]["opening_comparison_id"] == a.id
    assert row["periods"][0]["closing_comparison_id"] == b.id
    db.refresh(batch)
    assert batch.qty == 63 and db.scalar(select(func.count(StockMovement.id))) == before


@pytest.mark.parametrize("kind,expected", [
    ("negative", "negative_consumption"), ("zero", "zero_rate"),
    ("pending", "pending_waste"), ("stale", "stale_count"),
    ("short", "short_period"), ("corrected", "corrected_time_unknown"),
    ("delayed", "late_confirmation"), ("receipt_during_review", "movement_during_confirmation"),
    ("waste_crosses_count", "waste_crosses_count"), ("expired", "expired_stock"),
])
def test_uncertain_data_never_produces_forecast(kind, expected, client, auth, manager_token, db, scenario):
    item, batch, actor, anchor, movement, waste = scenario
    end = NOW - timedelta(days=16 if kind == "stale" else 2)
    anchor(100, end - timedelta(days=0.5 if kind == "short" else 7))
    pair, _ = anchor(110 if kind == "negative" else 100 if kind == "zero" else 30, end,
                     "manager_corrected" if kind == "corrected" else "no_difference",
                     "different" if kind == "corrected" else "same")
    if kind == "pending":
        waste(3, end + timedelta(days=1), "pending")
    if kind == "delayed":
        pair.confirmed_at = end + timedelta(hours=7)
    if kind == "receipt_during_review":
        movement(10, end + timedelta(minutes=1))
    if kind == "waste_crosses_count":
        waste(5, end - timedelta(hours=2), confirmed_at=end + timedelta(hours=1))
    if kind == "expired":
        batch.expiry_date = "2026-09-07"
    db.commit()
    row = get(client, auth, manager_token)
    assert row["forecast_issue"] == expected
    assert row["estimated_qty"] is None and row["days_remaining"] is None
    assert row["replenishment_gap"] is None
    if kind == "negative":
        assert row["periods"][0]["consumption"] == -10  # Preserve evidence.


def test_weighted_by_duration_and_excluded_periods(client, auth, manager_token, scenario):
    _, _, _, anchor, _, _ = scenario
    anchor(200, NOW - timedelta(days=15))
    anchor(160, NOW - timedelta(days=13))  # 40 / 2
    anchor(50, NOW - timedelta(days=2))   # 110 / 11
    row = get(client, auth, manager_token)
    assert row["valid_periods"] == 2
    assert row["daily_rate"] == 11.5  # 150 / 13, not (20 + 10) / 2.
    short_window = get(client, auth, manager_token, "?days=7")
    assert short_window["valid_periods"] == 0
    assert short_window["periods"][0]["exclusion"] == "outside_window"


def test_daily_shortage_overrides_prediction_and_inactive_hidden(client, auth, manager_token, db, scenario, make_item):
    item, _, actor, anchor, _, _ = scenario
    anchor(150, NOW - timedelta(days=9))
    anchor(100, NOW - timedelta(days=2))
    daily = CountSession(created_by=actor.id, count_type="daily", status="completed", business_date="2026-09-08")
    db.add(daily)
    db.flush()
    db.add(CountEntry(session_id=daily.id, item_id=item.id, qty_counted=999,
                      expected_qty=999, is_enough=False, reported_qty=1))
    db.commit()
    make_item(name="停用物品", active=False)
    row = get(client, auth, manager_token)
    assert row["status"] == "shortage" and row["daily_shortage"] is True
    assert row["last_count_qty"] == 100  # Daily observations are not training anchors.
    response = client.get("/api/consumption", headers=auth(manager_token)).json()
    assert len(response["items"]) == 1


def test_roles_validation_and_cold_start(client, auth, staff_token, manager_token, admin_token, scenario):
    assert client.get("/api/consumption").status_code == 401
    assert client.get("/api/consumption", headers=auth(staff_token)).status_code == 403
    for token in (manager_token, admin_token):
        row = get(client, auth, token)
        assert row["forecast_issue"] == "no_count"
        assert row["periods"] == []
        assert row["estimated_qty"] is None
    for query in ("days=0", "days=181", "lead_days=-1", "lead_days=31", "coverage_days=0", "coverage_days=31"):
        assert client.get("/api/consumption?" + query, headers=auth(manager_token)).status_code == 422
