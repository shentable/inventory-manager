"""双人独立盘点配对、差异处置、缺项与权限。"""


def test_receipt_after_count_cannot_be_erased_by_fresh_preview(
    client, staff_token, staff_b_token, manager_token, auth, make_item, make_batch
):
    item = make_item(name="延迟确认保护")
    make_batch(item.id, 50, "2099-01-01")
    first = _count(client, auth, staff_token, [{"item_id": item.id, "qty": 40}])
    second = _count(client, auth, staff_b_token, [{"item_id": item.id, "qty": 40}])
    received = client.post("/api/stock/receive", headers=auth(manager_token), json={
        "items": [{"item_id": item.id, "qty": 20, "expiry_date": "2099-01-01"}]
    })
    assert received.status_code == 201
    preview = _preview(client, auth, manager_token, first, second).json()
    result = _confirm(client, auth, manager_token, preview, "no_difference")
    assert result.status_code == 409
    assert result.json()["detail"]["code"] == "count_observation_stale"
    assert client.get("/api/stock", headers=auth(manager_token)).json()[0]["stock"] == 70
    # Returning the pair for a recount remains possible, and does not change stock.
    assert _confirm(client, auth, manager_token, preview, "recount_required", "到货后重新盘点").status_code == 201


def _count(client, auth, token, entries):
    response = client.post("/api/counts", json={"count_type": "weekly", "entries": entries}, headers=auth(token))
    assert response.status_code == 201
    return response.json()


def _preview(client, auth, token, first, second):
    return client.post(
        "/api/count-comparisons/preview",
        json={"first_count_id": first["id"], "second_count_id": second["id"]},
        headers=auth(token),
    )


def _confirm(client, auth, token, preview, resolution, note=None, corrections=None):
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
        headers=auth(token),
    )


def test_different_submitters_and_legacy_verify_required(
    client, staff_token, staff_b_token, manager_token, auth, make_item
):
    item = make_item(name="独立盘点")
    first = _count(client, auth, staff_token, [{"item_id": item.id, "qty": 2}])
    same_user = _count(client, auth, staff_token, [{"item_id": item.id, "qty": 2}])
    assert _preview(client, auth, manager_token, first, same_user).status_code == 400
    legacy = client.post(
        f"/api/counts/{first['id']}/verify",
        json={"entries": [{"item_id": item.id, "qty": 2}]},
        headers=auth(manager_token),
    )
    assert legacy.status_code == 409
    assert legacy.json()["detail"]["code"] == "pair_verification_required"


def test_mismatched_sets_update_only_intersection(
    client, staff_token, staff_b_token, manager_token, auth, make_item, make_batch
):
    common = make_item(name="共同项")
    left_only = make_item(name="甲缺项")
    right_only = make_item(name="乙缺项")
    for item in (common, left_only, right_only):
        make_batch(item.id, 10, "2099-01-01")
    first = _count(client, auth, staff_token, [
        {"item_id": common.id, "qty": 8}, {"item_id": left_only.id, "qty": 1}
    ])
    second = _count(client, auth, staff_b_token, [
        {"item_id": common.id, "qty": 8}, {"item_id": right_only.id, "qty": 2}
    ])
    preview = _preview(client, auth, manager_token, first, second).json()
    assert preview["shared_count"] == 1
    assert preview["missing_count"] == 2
    confirmed = _confirm(client, auth, manager_token, preview, "no_difference")
    assert confirmed.status_code == 201
    stock = {row["item"]["id"]: row["stock"] for row in client.get("/api/stock", headers=auth(manager_token)).json()}
    assert stock == {common.id: 8, left_only.id: 10, right_only.id: 10}
    assert [entry["final_qty"] for entry in confirmed.json()["entries"]] == [8, None, None]


def test_trusted_record_and_manager_correction_require_notes(
    client, staff_token, staff_b_token, manager_token, auth, make_item
):
    item = make_item(name="可信选择")
    first = _count(client, auth, staff_token, [{"item_id": item.id, "qty": 4}])
    second = _count(client, auth, staff_b_token, [{"item_id": item.id, "qty": 6}])
    preview = _preview(client, auth, manager_token, first, second).json()
    assert _confirm(client, auth, manager_token, preview, "trusted_first").status_code == 400
    result = _confirm(client, auth, manager_token, preview, "trusted_first", "复核凭证支持第一份")
    assert result.status_code == 201
    assert result.json()["entries"][0]["final_qty"] == 4

    other = make_item(name="管理员更正")
    third = _count(client, auth, staff_token, [{"item_id": other.id, "qty": 3}])
    fourth = _count(client, auth, staff_b_token, [{"item_id": other.id, "qty": 7}])
    preview2 = _preview(client, auth, manager_token, third, fourth).json()
    corrected = _confirm(
        client, auth, manager_token, preview2, "manager_corrected", "现场凭证确认",
        [{"item_id": other.id, "qty": 5}],
    )
    assert corrected.status_code == 201
    assert corrected.json()["entries"][0]["final_qty"] == 5


def test_recount_keeps_stock_and_locks_both_records(
    client, staff_token, staff_b_token, manager_token, auth, make_item, make_batch
):
    item = make_item(name="退回重盘")
    make_batch(item.id, 9, "2099-01-01")
    first = _count(client, auth, staff_token, [{"item_id": item.id, "qty": 4}])
    second = _count(client, auth, staff_b_token, [{"item_id": item.id, "qty": 6}])
    preview = _preview(client, auth, manager_token, first, second).json()
    result = _confirm(client, auth, manager_token, preview, "recount_required", "差异无法解释")
    assert result.status_code == 201
    assert result.json()["entries"][0]["final_qty"] is None
    assert client.get("/api/stock", headers=auth(manager_token)).json()[0]["stock"] == 9
    assert _confirm(client, auth, manager_token, preview, "recount_required", "再次处理").status_code == 409


def test_manager_may_submit_but_cannot_confirm_own_pair_and_admin_cannot_submit(
    client, staff_token, manager_token, admin_token, auth, make_item
):
    item = make_item(name="店长参与盘点")
    manager_count = _count(client, auth, manager_token, [{"item_id": item.id, "qty": 1}])
    staff_count = _count(client, auth, staff_token, [{"item_id": item.id, "qty": 1}])
    denied = _preview(client, auth, manager_token, manager_count, staff_count)
    assert denied.status_code == 409
    assert denied.json()["detail"]["code"] == "self_review_not_allowed"
    preview = _preview(client, auth, admin_token, manager_count, staff_count).json()
    assert _confirm(client, auth, admin_token, preview, "no_difference").status_code == 201
    admin_submit = client.post(
        "/api/counts", json={"count_type": "weekly", "entries": [{"item_id": item.id, "qty": 1}]},
        headers=auth(admin_token),
    )
    assert admin_submit.status_code == 403


def test_no_shared_items_and_preview_token_after_edit(
    client, staff_token, staff_b_token, manager_token, auth, make_item
):
    left = make_item(name="无交集甲")
    right = make_item(name="无交集乙")
    first = _count(client, auth, staff_token, [{"item_id": left.id, "qty": 1}])
    second = _count(client, auth, staff_b_token, [{"item_id": right.id, "qty": 2}])
    no_shared = _preview(client, auth, manager_token, first, second)
    assert no_shared.status_code == 400
    assert no_shared.json()["detail"]["code"] == "no_comparable_items"

    third = _count(client, auth, staff_b_token, [{"item_id": left.id, "qty": 1}])
    preview = _preview(client, auth, manager_token, first, third).json()
    edited = client.patch(
        f"/api/counts/{first['id']}",
        json={"entries": [{"item_id": left.id, "qty": 3}], "note": "重新清点"},
        headers=auth(staff_token),
    )
    assert edited.status_code == 200
    stale = _confirm(client, auth, manager_token, preview, "no_difference")
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "count_comparison_changed"
