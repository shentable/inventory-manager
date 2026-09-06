"""库存变动必须形成带操作人的不可变流水。"""


def test_purchase_and_waste_movements(
    client, staff_token, manager_token, auth, make_item
):
    item = make_item(name="流水商品")
    purchase = client.post(
        "/api/purchases",
        json={"items": [{"item_id": item.id, "qty": 5}]},
        headers=auth(manager_token),
    ).json()
    line_id = purchase["items"][0]["id"]
    received = client.post(
        f"/api/purchases/{purchase['id']}/receive",
        json={"items": [{"purchase_item_id": line_id, "expiry_date": "2099-01-01"}]},
        headers=auth(manager_token),
    )
    assert received.status_code == 200

    waste = client.post(
        "/api/waste",
        json={"item_id": item.id, "qty": 2, "reason": "试运行"},
        headers=auth(staff_token),
    ).json()
    assert client.post(
        f"/api/waste/{waste['id']}/confirm", headers=auth(manager_token)
    ).status_code == 200

    movements = client.get(
        f"/api/items/{item.id}/movements", headers=auth(manager_token)
    ).json()
    assert [row["delta"] for row in movements] == [-2, 5]
    assert [row["operation"] for row in movements] == ["waste", "purchase_receive"]
    assert all(row["actor_name"] == "店长" for row in movements)
