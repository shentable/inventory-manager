"""同一审批被并发提交时只能有一个请求生效。"""

from concurrent.futures import ThreadPoolExecutor


def _twice(call):
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(call), pool.submit(call)]
        return sorted(future.result().status_code for future in futures)


def test_waste_confirmation_is_single_effect(
    client, staff_token, manager_token, auth, make_item, make_batch
):
    item = make_item(name="并发报损")
    make_batch(item.id, 10, "2099-01-01")
    waste = client.post(
        "/api/waste",
        json={"item_id": item.id, "qty": 3, "reason": "并发"},
        headers=auth(staff_token),
    ).json()

    def confirm():
        return client.post(f"/api/waste/{waste['id']}/confirm", headers=auth(manager_token))

    assert _twice(confirm) == [200, 409]
    stock = client.get("/api/stock", headers=auth(staff_token)).json()
    assert stock[0]["stock"] == 7


def test_count_verification_is_single_effect(
    client, staff_token, staff_b_token, manager_token, auth, make_item
):
    item = make_item(name="并发盘盈")
    count = client.post(
        "/api/counts",
        json={"entries": [{"item_id": item.id, "qty": 5}]},
        headers=auth(staff_token),
    ).json()
    other = client.post(
        "/api/counts",
        json={"entries": [{"item_id": item.id, "qty": 5}]},
        headers=auth(staff_b_token),
    ).json()
    preview = client.post(
        "/api/count-comparisons/preview",
        json={"first_count_id": count["id"], "second_count_id": other["id"]},
        headers=auth(manager_token),
    ).json()

    def verify():
        return client.post(
            "/api/count-comparisons",
            json={
                "first_count_id": count["id"], "second_count_id": other["id"],
                "comparison_token": preview["comparison_token"],
                "resolution": "no_difference", "corrections": [],
            },
            headers=auth(manager_token),
        )

    assert _twice(verify) == [201, 409]
    movements = client.get(
        f"/api/items/{item.id}/movements", headers=auth(manager_token)
    ).json()
    assert [row["delta"] for row in movements] == [5]


def test_purchase_receive_is_single_effect(
    client, manager_token, auth, make_item
):
    item = make_item(name="并发采购")
    purchase = client.post(
        "/api/purchases",
        json={"items": [{"item_id": item.id, "qty": 4}]},
        headers=auth(manager_token),
    ).json()
    payload = {
        "items": [
            {
                "purchase_item_id": purchase["items"][0]["id"],
                "expiry_date": "2099-01-01",
            }
        ]
    }

    def receive():
        return client.post(
            f"/api/purchases/{purchase['id']}/receive",
            json=payload,
            headers=auth(manager_token),
        )

    assert _twice(receive) == [200, 409]
    movements = client.get(
        f"/api/items/{item.id}/movements", headers=auth(manager_token)
    ).json()
    assert [row["delta"] for row in movements] == [4]


def test_concurrent_deductions_cannot_overdraw_stock(
    client, staff_token, manager_token, auth, make_item, make_batch
):
    item = make_item(name="并发原子扣减")
    make_batch(item.id, 10, "2099-01-01")
    ids = []
    for reason in ("并发 A", "并发 B"):
        ids.append(
            client.post(
                "/api/waste",
                json={"item_id": item.id, "qty": 7, "reason": reason},
                headers=auth(staff_token),
            ).json()["id"]
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(
            pool.map(
                lambda waste_id: client.post(
                    f"/api/waste/{waste_id}/confirm", headers=auth(manager_token)
                ),
                ids,
            )
        )
    assert sorted(response.status_code for response in responses) == [200, 400]
    stock = client.get("/api/stock", headers=auth(staff_token)).json()
    assert stock[0]["stock"] == 3
