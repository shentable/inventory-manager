"""门店试运行安全基线：健康检查、首次改 PIN、会话撤销和登录限流。"""


def test_health_is_public(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["api_version"] == "1"
    assert body["db_schema"] == "20260904_08"
    assert body["backend_kind"] == "python"
    assert set(body) == {
        "status", "api_version", "db_schema", "store_id", "backend_kind", "app_version"
    }


def test_first_login_requires_pin_change_and_revokes_old_token(client, make_user, auth):
    make_user(username="first", pin="1234", must_change_pin=True)
    login = client.post("/api/auth/login", json={"username": "first", "pin": "1234"})
    assert login.status_code == 200
    old_token = login.json()["token"]
    assert login.json()["user"]["must_change_pin"] is True

    blocked = client.get("/api/items", headers=auth(old_token))
    assert blocked.status_code == 403
    assert blocked.json()["detail"]["code"] == "pin_change_required"

    changed = client.post(
        "/api/auth/change-pin",
        json={"current_pin": "1234", "new_pin": "5678"},
        headers=auth(old_token),
    )
    assert changed.status_code == 200
    assert changed.json()["user"]["must_change_pin"] is False
    assert client.get("/api/auth/me", headers=auth(old_token)).status_code == 401
    assert client.get("/api/items", headers=auth(changed.json()["token"])).status_code == 200


def test_admin_pin_reset_revokes_session(client, admin_token, make_user, auth):
    make_user(username="worker", pin="1234")
    worker_token = client.post(
        "/api/auth/login", json={"username": "worker", "pin": "1234"}
    ).json()["token"]
    worker = client.get("/api/auth/me", headers=auth(worker_token)).json()

    reset = client.patch(
        f"/api/users/{worker['id']}", json={"pin": "9876"}, headers=auth(admin_token)
    )
    assert reset.status_code == 200
    assert reset.json()["must_change_pin"] is True
    assert client.get("/api/auth/me", headers=auth(worker_token)).status_code == 401


def test_login_rate_limit_and_retry_after(client, make_user):
    make_user(username="limited", pin="1234")
    for _ in range(4):
        assert client.post(
            "/api/auth/login", json={"username": "limited", "pin": "0000"}
        ).status_code == 401
    locked = client.post(
        "/api/auth/login", json={"username": "limited", "pin": "0000"}
    )
    assert locked.status_code == 429
    assert int(locked.headers["Retry-After"]) > 0
    assert client.post(
        "/api/auth/login", json={"username": "limited", "pin": "1234"}
    ).status_code == 429


def test_successful_login_clears_scoped_failures(client, make_user):
    make_user(username="cleared", pin="1234")
    for _ in range(4):
        assert client.post(
            "/api/auth/login", json={"username": "cleared", "pin": "9999"}
        ).status_code == 401
    assert client.post(
        "/api/auth/login", json={"username": "cleared", "pin": "1234"}
    ).status_code == 200
    for _ in range(4):
        assert client.post(
            "/api/auth/login", json={"username": "cleared", "pin": "9999"}
        ).status_code == 401


def test_role_and_active_changes_revoke_sessions(client, admin_token, make_user, auth):
    user = make_user(username="role-change", pin="1234", role="manager")
    token = client.post(
        "/api/auth/login", json={"username": "role-change", "pin": "1234"}
    ).json()["token"]
    assert client.patch(
        f"/api/users/{user.id}", json={"role": "staff"}, headers=auth(admin_token)
    ).status_code == 200
    assert client.get("/api/auth/me", headers=auth(token)).status_code == 401

    token = client.post(
        "/api/auth/login", json={"username": "role-change", "pin": "1234"}
    ).json()["token"]
    assert client.patch(
        f"/api/users/{user.id}", json={"active": False}, headers=auth(admin_token)
    ).status_code == 200
    assert client.get("/api/auth/me", headers=auth(token)).status_code == 401


def test_admin_username_change_normalizes_and_revokes_session(
    client, admin_token, make_user, auth
):
    user = make_user(username="old-name", pin="1234")
    make_user(username="already-used", pin="5678")
    old_token = client.post(
        "/api/auth/login", json={"username": "old-name", "pin": "1234"}
    ).json()["token"]

    renamed = client.patch(
        f"/api/users/{user.id}",
        json={"username": "  NEW-NAME  "},
        headers=auth(admin_token),
    )
    assert renamed.status_code == 200
    assert renamed.json()["username"] == "new-name"
    assert client.get("/api/auth/me", headers=auth(old_token)).status_code == 401
    assert client.post(
        "/api/auth/login", json={"username": "old-name", "pin": "1234"}
    ).status_code == 401
    assert client.post(
        "/api/auth/login", json={"username": "new-name", "pin": "1234"}
    ).status_code == 200

    duplicate = client.patch(
        f"/api/users/{user.id}",
        json={"username": "ALREADY-USED"},
        headers=auth(admin_token),
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"] == "用户名已存在"

def test_staff_cannot_list_purchases(client, staff_token, auth):
    assert client.get("/api/purchases", headers=auth(staff_token)).status_code == 403
