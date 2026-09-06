"""盘点：双人实数核对、三天汇总、盘亏 FEFO / 盘盈 adjust 与事务守卫。"""
from datetime import date, datetime, timedelta

from app.models import CountSession


def preview_pair(client, auth, manager_token, first_id, second_id):
    return client.post(
        "/api/count-comparisons/preview",
        json={"first_count_id": first_id, "second_count_id": second_id},
        headers=auth(manager_token),
    )


def confirm_pair(client, auth, manager_token, preview, resolution, note=None, corrections=None):
    return client.post(
        "/api/count-comparisons",
        json={
            "first_count_id": preview["first"]["id"],
            "second_count_id": preview["second"]["id"],
            "comparison_token": preview["comparison_token"],
            "resolution": resolution,
            "note": note,
            "corrections": corrections or [],
        },
        headers=auth(manager_token),
    )


def test_create_count_snapshot(client, manager_token, auth, make_item, make_batch):
    item = make_item(name="鸡蛋", shelf_life_days=21)
    make_batch(item_id=item.id, qty=8, expiry_date="2099-01-01")
    r = client.post(
        "/api/counts",
        json={"entries": [{"item_id": item.id, "qty": 5}], "note": "晚班盘点"},
        headers=auth(manager_token),
    )
    assert r.status_code == 201
    body = r.json()
    assert body["status"] == "submitted"
    assert body["note"] == "晚班盘点"
    assert body["entries"][0]["expected_qty"] == 8
    assert body["entries"][0]["qty_counted"] == 5
    assert body["entries"][0]["diff"] == -3


def test_count_duplicate_entries_400(client, manager_token, auth, make_item):
    item = make_item(name="番茄")
    r = client.post(
        "/api/counts",
        json={"entries": [{"item_id": item.id, "qty": 1}, {"item_id": item.id, "qty": 2}]},
        headers=auth(manager_token),
    )
    assert r.status_code == 400


def test_verify_surplus_creates_adjust_batch(client, staff_token, staff_b_token, manager_token, auth, make_item, make_batch):
    item = make_item(name="番茄", shelf_life_days=5, unit="个")
    make_batch(item_id=item.id, qty=5, expiry_date="2099-01-01")
    r = client.post(
        "/api/counts", json={"entries": [{"item_id": item.id, "qty": 9}]}, headers=auth(staff_token)
    )
    cid = r.json()["id"]
    other = client.post("/api/counts", json={"entries": [{"item_id": item.id, "qty": 9}]}, headers=auth(staff_b_token)).json()
    preview = preview_pair(client, auth, manager_token, cid, other["id"]).json()
    vr = confirm_pair(client, auth, manager_token, preview, "no_difference")
    assert vr.status_code == 201
    assert vr.json()["resolution"] == "no_difference"
    assert vr.json()["entries"][0]["final_qty"] == 9

    batches = client.get(f"/api/items/{item.id}/batches", headers=auth(manager_token)).json()
    adjust = [b for b in batches if b["source"] == "adjust"]
    assert len(adjust) == 1
    assert adjust[0]["qty"] == 4
    assert adjust[0]["note"] == "双人盘点盘盈"
    assert adjust[0]["expiry_date"] == (date.today() + timedelta(days=5)).isoformat()

    stock = client.get("/api/stock", headers=auth(manager_token)).json()
    assert next(e for e in stock if e["item"]["id"] == item.id)["stock"] == 9


def test_verify_shortage_fefo(client, staff_token, staff_b_token, manager_token, auth, make_item, make_batch):
    item = make_item(name="牛奶")
    make_batch(item_id=item.id, qty=3, expiry_date="2026-03-01")
    make_batch(item_id=item.id, qty=7, expiry_date="2026-05-01")
    r = client.post(
        "/api/counts", json={"entries": [{"item_id": item.id, "qty": 6}]}, headers=auth(staff_token)
    )
    cid = r.json()["id"]
    other = client.post("/api/counts", json={"entries": [{"item_id": item.id, "qty": 6}]}, headers=auth(staff_b_token)).json()
    preview = preview_pair(client, auth, manager_token, cid, other["id"]).json()
    assert confirm_pair(client, auth, manager_token, preview, "no_difference").status_code == 201

    batches = {
        b["expiry_date"]: b["qty"]
        for b in client.get(f"/api/items/{item.id}/batches", headers=auth(manager_token)).json()
    }
    assert batches["2026-03-01"] == 0  # 先到期批次先扣完
    assert batches["2026-05-01"] == 6  # 10-6=4 中剩余的 1 从后批次扣


def test_verify_status_guards(client, staff_token, staff_b_token, manager_token, auth, make_item):
    item = make_item(name="鸡蛋")
    r = client.post(
        "/api/counts", json={"entries": [{"item_id": item.id, "qty": 0}]}, headers=auth(staff_token)
    )
    cid = r.json()["id"]
    other = client.post("/api/counts", json={"entries": [{"item_id": item.id, "qty": 0}]}, headers=auth(staff_b_token)).json()
    preview = preview_pair(client, auth, manager_token, cid, other["id"]).json()
    assert confirm_pair(client, auth, manager_token, preview, "no_difference").status_code == 201
    assert confirm_pair(client, auth, manager_token, preview, "no_difference").status_code == 409
    assert client.post(f"/api/counts/{cid}/reject", headers=auth(manager_token)).status_code == 409


def test_reject_count(client, staff_token, staff_b_token, manager_token, auth, make_item):
    item = make_item(name="面包")
    r = client.post(
        "/api/counts", json={"entries": [{"item_id": item.id, "qty": 2}]}, headers=auth(staff_token)
    )
    cid = r.json()["id"]
    other = client.post(
        "/api/counts", json={"entries": [{"item_id": item.id, "qty": 3}]},
        headers=auth(staff_b_token),
    ).json()
    preview = preview_pair(client, auth, manager_token, cid, other["id"]).json()
    assert confirm_pair(
        client, auth, manager_token, preview, "recount_required", note="现场条件异常"
    ).status_code == 201
    assert client.post(f"/api/counts/{cid}/reject", headers=auth(manager_token)).status_code == 409
    assert client.post(f"/api/counts/{cid}/verify", json={"entries": [{"item_id": item.id, "qty": 2}]}, headers=auth(manager_token)).status_code == 409


def test_verify_insufficient_stock_rollback(
    client, staff_token, staff_b_token, manager_token, auth, make_item, make_batch
):
    """核对时库存已被别的流程扣掉 → 快照冲突 409，且盘点保持待处理。"""
    item = make_item(name="肉")
    make_batch(item_id=item.id, qty=10, expiry_date="2099-01-01")
    r = client.post(
        "/api/counts", json={"entries": [{"item_id": item.id, "qty": 6}]}, headers=auth(staff_token)
    )
    cid = r.json()["id"]
    other = client.post(
        "/api/counts", json={"entries": [{"item_id": item.id, "qty": 6}]},
        headers=auth(staff_b_token),
    ).json()
    preview = preview_pair(client, auth, manager_token, cid, other["id"]).json()

    wr = client.post(
        "/api/waste", json={"item_id": item.id, "qty": 9, "reason": "变质"}, headers=auth(staff_token)
    ).json()
    assert (
        client.post(f"/api/waste/{wr['id']}/confirm", headers=auth(manager_token)).status_code == 200
    )

    vr = confirm_pair(client, auth, manager_token, preview, "no_difference")
    assert vr.status_code == 409
    assert vr.json()["detail"]["code"] == "count_comparison_changed"
    # 回滚：状态仍 submitted，库存未被部分扣减（仍是 1）
    assert (
        client.get(f"/api/counts/{cid}", headers=auth(manager_token)).json()["status"]
        == "submitted"
    )
    stock = client.get("/api/stock", headers=auth(manager_token)).json()
    assert next(e for e in stock if e["item"]["id"] == item.id)["stock"] == 1


def test_count_list_and_detail(client, staff_token, manager_token, auth, make_item):
    item = make_item(name="芝士")
    r = client.post(
        "/api/counts", json={"entries": [{"item_id": item.id, "qty": 4}]}, headers=auth(manager_token)
    )
    cid = r.json()["id"]
    assert client.get("/api/counts", headers=auth(staff_token)).json() == []
    assert client.get(f"/api/counts/{cid}", headers=auth(staff_token)).status_code == 403
    lst = client.get("/api/counts", headers=auth(manager_token)).json()
    entry = next(x for x in lst if x["id"] == cid)
    assert entry["entries_count"] == 1
    assert entry["created_by_name"] == "店长"

    detail = client.get(f"/api/counts/{cid}", headers=auth(manager_token)).json()
    assert detail["entries"][0]["item_name"] == "芝士"
    assert detail["entries"][0]["diff"] == 4


def test_daily_count_records_enough_without_adjusting_stock(
    client, staff_token, manager_token, auth, make_item, make_batch
):
    bread = make_item(name="每日吐司")
    lettuce = make_item(name="每日生菜")
    make_batch(item_id=bread.id, qty=8, expiry_date="2099-01-01")
    missing_quantity = client.post(
        "/api/counts",
        json={"count_type": "daily", "entries": [{"item_id": lettuce.id, "enough": False}]},
        headers=auth(staff_token),
    )
    assert missing_quantity.status_code == 400
    assert missing_quantity.json()["detail"] == "每日盘点选择不够时必须填写现场数量"
    response = client.post(
        "/api/counts",
        json={
            "count_type": "daily",
            "entries": [
                {"item_id": bread.id, "enough": True, "qty": 7},
                {"item_id": lettuce.id, "enough": False, "qty": 0},
            ],
        },
        headers=auth(staff_token),
    )
    assert response.status_code == 201
    body = response.json()
    assert body["count_type"] == "daily"
    assert body["status"] == "completed"
    assert [entry["is_enough"] for entry in body["entries"]] == [True, False]
    assert [entry["reported_qty"] for entry in body["entries"]] == [7, 0]
    daily_list = client.get(
        "/api/counts?count_type=daily", headers=auth(manager_token)
    ).json()
    assert len(daily_list) == 1
    assert daily_list[0]["enough_count"] == 1
    assert daily_list[0]["not_enough_count"] == 1
    assert daily_list[0]["quantity_count"] == 2
    assert client.get(
        "/api/counts?count_type=weekly", headers=auth(manager_token)
    ).json() == []
    assert client.post(f"/api/counts/{body['id']}/verify", json={"entries": [{"item_id": bread.id, "qty": 8}, {"item_id": lettuce.id, "qty": 0}]}, headers=auth(manager_token)).status_code == 409
    stock = client.get("/api/stock", headers=auth(staff_token)).json()
    assert next(row for row in stock if row["item"]["id"] == bread.id)["stock"] == 8


def test_daily_count_is_unique_per_day_and_requires_explicit_overwrite(
    client, staff_token, manager_token, auth, make_item
):
    bread = make_item(name="覆盖吐司")
    lettuce = make_item(name="覆盖生菜")
    first = client.post(
        "/api/counts",
        json={
            "count_type": "daily",
            "entries": [
                {"item_id": bread.id, "enough": True, "qty": 8},
                {"item_id": lettuce.id, "enough": False, "qty": 0},
            ],
        },
        headers=auth(staff_token),
    )
    assert first.status_code == 201
    count_id = first.json()["id"]
    business_date = first.json()["business_date"]

    conflict = client.post(
        "/api/counts",
        json={
            "count_type": "daily",
            "entries": [
                {"item_id": bread.id, "enough": False, "qty": 7},
                {"item_id": lettuce.id, "enough": False, "qty": 0},
            ],
        },
        headers=auth(staff_token),
    )
    assert conflict.status_code == 409
    detail = conflict.json()["detail"]
    assert detail["code"] == "daily_count_exists"
    assert detail["count_id"] == count_id
    assert detail["unchanged_count"] == 1
    assert detail["changes"] == [
        {
            "item_id": bread.id,
            "item_name": "覆盖吐司",
            "previous_enough": True,
            "new_enough": False,
            "previous_qty": 8,
            "new_qty": 7,
        }
    ]

    overwritten = client.post(
        "/api/counts",
        json={
            "count_type": "daily",
            "overwrite_daily": True,
            "entries": [
                {"item_id": bread.id, "enough": False, "qty": 6},
                {"item_id": lettuce.id, "enough": True},
            ],
        },
        headers=auth(staff_token),
    )
    assert overwritten.status_code == 201
    assert overwritten.json()["id"] == count_id
    assert overwritten.json()["business_date"] == business_date
    assert [entry["is_enough"] for entry in overwritten.json()["entries"]] == [False, True]
    assert [entry["reported_qty"] for entry in overwritten.json()["entries"]] == [6, None]
    rows = client.get(
        "/api/counts?status=completed&count_type=daily", headers=auth(manager_token)
    ).json()
    assert len(rows) == 1
    assert rows[0]["not_enough_count"] == 1


def test_staff_can_submit_numeric_count_for_review(client, staff_token, auth, make_item):
    item = make_item(name="周盘权限")
    response = client.post(
        "/api/counts",
        json={"count_type": "weekly", "entries": [{"item_id": item.id, "qty": 0}]},
        headers=auth(staff_token),
    )
    assert response.status_code == 201
    assert response.json()["status"] == "submitted"


def test_two_person_review_requires_reason_then_accepts_normal_consumption(
    client, staff_token, staff_b_token, manager_token, auth, make_item, make_batch
):
    item = make_item(name="消耗差异")
    make_batch(item.id, 10, "2099-01-01")
    count = client.post(
        "/api/counts",
        json={"entries": [{"item_id": item.id, "qty": 9}]},
        headers=auth(staff_token),
    ).json()
    second = client.post("/api/counts", json={"entries": [{"item_id": item.id, "qty": 8}]}, headers=auth(staff_b_token)).json()
    preview = preview_pair(client, auth, manager_token, count["id"], second["id"]).json()
    assert preview["different_count"] == 1
    assert confirm_pair(client, auth, manager_token, preview, "no_difference").status_code == 400
    verified = confirm_pair(client, auth, manager_token, preview, "normal_consumption")
    assert verified.status_code == 201
    assert verified.json()["resolution"] == "normal_consumption"
    assert verified.json()["entries"][0]["final_qty"] == 8


def test_non_consumption_difference_requires_recount_note(
    client, staff_token, staff_b_token, manager_token, auth, make_item
):
    item = make_item(name="非消耗差异")
    count = client.post(
        "/api/counts", json={"entries": [{"item_id": item.id, "qty": 2}]}, headers=auth(staff_token)
    ).json()
    second = client.post("/api/counts", json={"entries": [{"item_id": item.id, "qty": 3}]}, headers=auth(staff_b_token)).json()
    preview = preview_pair(client, auth, manager_token, count["id"], second["id"]).json()
    assert confirm_pair(client, auth, manager_token, preview, "manager_corrected", corrections=[{"item_id": item.id, "qty": 4}]).status_code == 400
    result = confirm_pair(client, auth, manager_token, preview, "manager_corrected", "发现记录错误，已核实", [{"item_id": item.id, "qty": 4}])
    assert result.status_code == 201
    assert result.json()["resolution"] == "manager_corrected"


def test_submitter_cannot_review_own_count(client, staff_token, manager_token, auth, make_item):
    item = make_item(name="双人核对")
    count = client.post(
        "/api/counts", json={"entries": [{"item_id": item.id, "qty": 0}]}, headers=auth(manager_token)
    ).json()
    other = client.post("/api/counts", json={"entries": [{"item_id": item.id, "qty": 0}]}, headers=auth(staff_token)).json()
    result = preview_pair(client, auth, manager_token, count["id"], other["id"])
    assert result.status_code == 409
    assert result.json()["detail"]["code"] == "self_review_not_allowed"


def test_three_day_count_summary_filter(client, staff_token, auth, make_item, db):
    item = make_item(name="三天汇总")
    old = client.post(
        "/api/counts", json={"entries": [{"item_id": item.id, "qty": 0}]}, headers=auth(staff_token)
    ).json()
    db.get(CountSession, old["id"]).created_at = datetime.now() - timedelta(days=4)
    db.commit()
    recent = client.post(
        "/api/counts", json={"entries": [{"item_id": item.id, "qty": 1}]}, headers=auth(staff_token)
    ).json()
    rows = client.get("/api/counts?count_type=weekly&days=3", headers=auth(staff_token)).json()
    assert [row["id"] for row in rows] == [recent["id"]]


def test_daily_accepts_optional_qty_but_weekly_rejects_enough(client, manager_token, auth, make_item):
    item = make_item(name="盘点字段边界")
    daily = client.post(
        "/api/counts",
        json={"count_type": "daily", "entries": [{"item_id": item.id, "enough": True, "qty": 1}]},
        headers=auth(manager_token),
    )
    weekly = client.post(
        "/api/counts",
        json={"count_type": "weekly", "entries": [{"item_id": item.id, "qty": 1, "enough": True}]},
        headers=auth(manager_token),
    )
    assert daily.status_code == 201
    assert daily.json()["entries"][0]["reported_qty"] == 1
    assert weekly.status_code == 400


def test_count_type_rejects_items_outside_configured_scope(client, staff_token, auth, make_item):
    weekly_only = make_item(name="仅每周盘点", daily_count_enabled=False, weekly_count_enabled=True)
    daily_only = make_item(name="仅每日盘点", daily_count_enabled=True, weekly_count_enabled=False)
    daily_rejected = client.post(
        "/api/counts",
        json={"count_type": "daily", "entries": [{"item_id": weekly_only.id, "enough": True}]},
        headers=auth(staff_token),
    )
    weekly_rejected = client.post(
        "/api/counts",
        json={"count_type": "weekly", "entries": [{"item_id": daily_only.id, "qty": 0}]},
        headers=auth(staff_token),
    )
    assert daily_rejected.status_code == 400
    assert daily_rejected.json()["detail"] == "库存品未启用每日盘点：仅每周盘点"
    assert weekly_rejected.status_code == 400
    assert weekly_rejected.json()["detail"] == "库存品未启用每周盘点：仅每日盘点"


def test_staff_sees_and_edits_only_own_pending_weekly_count(
    client, staff_token, manager_token, auth, make_item, make_user
):
    item = make_item(name="店员自助修改盘点", unit="袋")
    added_item = make_item(name="后来补盘商品", unit="盒")
    submitted = client.post(
        "/api/counts",
        json={"count_type": "weekly", "entries": [{"item_id": item.id, "qty": 3}]},
        headers=auth(staff_token),
    ).json()

    make_user(username="other_staff", display_name="另一店员", pin="4444", role="staff")
    other_token = client.post(
        "/api/auth/login", json={"username": "other_staff", "pin": "4444"}
    ).json()["token"]
    assert client.get("/api/counts?count_type=weekly", headers=auth(other_token)).json() == []
    assert client.get(f"/api/counts/{submitted['id']}", headers=auth(other_token)).status_code == 403
    assert client.patch(
        f"/api/counts/{submitted['id']}",
        json={"entries": [{"item_id": item.id, "qty": 9}]},
        headers=auth(other_token),
    ).status_code == 403
    assert client.get("/api/dashboard", headers=auth(other_token)).json()["recent_counts_3d"] == 0

    edited = client.patch(
        f"/api/counts/{submitted['id']}",
        json={
            "entries": [
                {"item_id": item.id, "qty": 7},
                {"item_id": added_item.id, "qty": 5},
            ],
            "note": "重新清点并补充漏项",
        },
        headers=auth(staff_token),
    )
    assert edited.status_code == 200
    assert [(entry["item_id"], entry["qty_counted"]) for entry in edited.json()["entries"]] == [
        (item.id, 7),
        (added_item.id, 5),
    ]
    assert edited.json()["note"] == "重新清点并补充漏项"
    assert client.get("/api/dashboard", headers=auth(staff_token)).json()["recent_counts_3d"] == 1
    manager_rows = client.get("/api/counts?count_type=weekly", headers=auth(manager_token)).json()
    assert [row["id"] for row in manager_rows] == [submitted["id"]]

    other = client.post(
        "/api/counts",
        json={"entries": [{"item_id": item.id, "qty": 7}, {"item_id": added_item.id, "qty": 5}]},
        headers=auth(other_token),
    ).json()
    preview = preview_pair(client, auth, manager_token, submitted["id"], other["id"]).json()
    verified = confirm_pair(client, auth, manager_token, preview, "no_difference")
    assert verified.status_code == 201
    locked = client.patch(
        f"/api/counts/{submitted['id']}",
        json={"entries": [{"item_id": item.id, "qty": 8}]},
        headers=auth(staff_token),
    )
    assert locked.status_code == 409
