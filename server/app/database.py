"""数据库连接与会话管理（SQLite + WAL）。

- 库位置优先级：
  1. 环境变量 DATABASE_URL（形如 sqlite:////app/data/app.db，Docker 部署用）
  2. 环境变量 SANDWICH_DB_PATH（测试用临时文件库，兼容旧约定）
  3. 缺省 <server>/data/app.db（自动建目录）
- DATABASE_URL 为 sqlite 文件库时，父目录自动创建（对 sqlite:////app/data/app.db 同样适用）。
"""
import os
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, sessionmaker

DEFAULT_DB_PATH = Path(__file__).resolve().parents[1] / "data" / "app.db"


def _ensure_sqlite_parent(url: str) -> None:
    """sqlite:/// 形式时确保库文件父目录存在（如 sqlite:////app/data/app.db → /app/data）。"""
    if url.startswith("sqlite:///"):
        db_path = Path(url.removeprefix("sqlite:///"))
        db_path.parent.mkdir(parents=True, exist_ok=True)


def _resolve_db_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if url:
        _ensure_sqlite_parent(url)
        return url
    override = os.environ.get("SANDWICH_DB_PATH")
    path = Path(override) if override else DEFAULT_DB_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    return f"sqlite:///{path}"


def utcnow() -> datetime:
    """本地库统一存 naive UTC，序列化时无时区歧义。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


engine = create_engine(
    _resolve_db_url(),
    connect_args={"check_same_thread": False},
)


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_conn, _connection_record):
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass
