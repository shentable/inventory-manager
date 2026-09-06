"""认证：登录、登录选项、当前用户、token 校验。"""
from app.auth import create_token


def test_login_success(client, make_user):
    make_user(username="alice", display_name="爱丽丝", pin="1234", role="staff")
    r = client.post("/api/auth/login", json={"username": "alice", "pin": "1234"})
    assert r.status_code == 200
    data = r.json()
    assert data["token"]
    assert data["user"]["username"] == "alice"
    assert data["user"]["display_name"] == "爱丽丝"
    assert data["user"]["role"] == "staff"


def test_login_wrong_pin(client, make_user):
    make_user(username="alice", pin="1234")
    r = client.post("/api/auth/login", json={"username": "alice", "pin": "0000"})
    assert r.status_code == 401


def test_login_unknown_user(client):
    r = client.post("/api/auth/login", json={"username": "nobody", "pin": "0000"})
    assert r.status_code == 401


def test_login_inactive_user(client, make_user):
    make_user(username="bob", pin="0000", active=False)
    r = client.post("/api/auth/login", json={"username": "bob", "pin": "0000"})
    assert r.status_code == 401


def test_login_options_only_active(client, make_user):
    make_user(username="u1", display_name="一号", role="manager")
    make_user(username="u2", display_name="二号", active=False)
    r = client.get("/api/auth/login-options")
    assert r.status_code == 200
    users = r.json()["users"]
    names = {u["username"] for u in users}
    assert "u1" in names
    assert "u2" not in names
    assert users[0]["display_name"] == "一号"


def test_me(client, make_user, auth):
    make_user(username="alice", pin="1234")
    token = client.post(
        "/api/auth/login", json={"username": "alice", "pin": "1234"}
    ).json()["token"]
    r = client.get("/api/auth/me", headers=auth(token))
    assert r.status_code == 200
    assert r.json()["username"] == "alice"


def test_me_requires_valid_token(client, make_user, auth):
    make_user(username="alice")
    assert client.get("/api/auth/me").status_code == 401
    assert (
        client.get("/api/auth/me", headers={"Authorization": "Bearer bad.token"}).status_code
        == 401
    )
    token = client.post(
        "/api/auth/login", json={"username": "alice", "pin": "0000"}
    ).json()["token"]
    assert (
        client.get("/api/auth/me", headers=auth(token + "x")).status_code == 401
    )


def test_expired_token_rejected(client, make_user, auth):
    make_user(username="alice")  # 全新库中 id=1
    token = create_token(1, ttl=-10)
    assert client.get("/api/auth/me", headers=auth(token)).status_code == 401


def test_token_ttl_is_30_days():
    import time

    payload = create_token(42)
    raw = payload.split(".")[0]
    import base64
    import json

    data = json.loads(base64.urlsafe_b64decode(raw.encode("ascii")).decode("utf-8"))
    assert data["uid"] == 42
    assert abs((data["exp"] - time.time()) - 30 * 24 * 3600) < 60
