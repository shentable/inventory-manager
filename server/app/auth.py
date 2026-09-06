"""PIN 哈希与自实现 HMAC token（无外部依赖）。

- PIN：hashlib.pbkdf2_hmac（sha256），存储格式 pbkdf2_sha256$iter$salt_hex$hash_hex
- Token：base64(payload).hmac_sha256(secret, payload)，payload 含 user_id 与过期时间
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import time

PIN_ITERATIONS = 200_000
TOKEN_TTL_SECONDS = 30 * 24 * 3600  # 30 天

def hash_pin(pin: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", pin.encode("utf-8"), salt, PIN_ITERATIONS)
    return f"pbkdf2_sha256${PIN_ITERATIONS}${salt.hex()}${dk.hex()}"


def verify_pin(pin: str, stored: str) -> bool:
    try:
        algo, iterations, salt_hex, hash_hex = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac(
            "sha256", pin.encode("utf-8"), bytes.fromhex(salt_hex), int(iterations)
        )
        return hmac.compare_digest(dk.hex(), hash_hex)
    except (ValueError, TypeError):
        return False


def _secret() -> str:
    secret = os.environ.get("SECRET_KEY", "")
    if len(secret) < 16:
        raise RuntimeError("SECRET_KEY 必须设置且至少 16 个字符")
    return secret


def validate_secret_key() -> None:
    """在应用启动阶段尽早拒绝缺失或过短的生产密钥。"""
    _secret()


def create_token(user_id: int, token_version: int = 0, ttl: int = TOKEN_TTL_SECONDS) -> str:
    payload = {"uid": user_id, "ver": token_version, "exp": int(time.time()) + ttl}
    raw = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode("utf-8")
    ).decode("ascii")
    sig = base64.urlsafe_b64encode(
        hmac.new(_secret().encode("utf-8"), raw.encode("ascii"), hashlib.sha256).digest()
    ).decode("ascii")
    return f"{raw}.{sig}"


def decode_token(token: str) -> tuple[int, int] | None:
    """校验签名与过期时间，返回 (user_id, token_version)。"""
    try:
        raw, sig = token.split(".", 1)
        expected = base64.urlsafe_b64encode(
            hmac.new(_secret().encode("utf-8"), raw.encode("ascii"), hashlib.sha256).digest()
        ).decode("ascii")
        if not hmac.compare_digest(sig, expected):
            return None
        payload = json.loads(base64.urlsafe_b64decode(raw.encode("ascii")).decode("utf-8"))
        if payload.get("exp", 0) < time.time():
            return None
        uid = payload.get("uid")
        version = payload.get("ver", 0)
        return (int(uid), int(version)) if isinstance(uid, int) and isinstance(version, int) else None
    except Exception:
        return None
