"""FastAPI 应用入口。

- API 前缀 /api（认证、库存品、库存/效期、盘点、报损、采购、用户、仪表盘）
- CORS 全开 + GZip 压缩
- 前端静态目录：优先环境变量 WEB_DIR，缺省回退到仓库根 web/（相对 server/ 的 ../web），
  两者都不存在时跳过挂载（纯 API 运行）
- 数据库路径：环境变量 DATABASE_URL（缺省 server/data/app.db，见 database.py）
- 表结构只由 Alembic 迁移；启动时校验密钥，并在 AUTO_SEED!=0 时执行幂等种子数据
"""
import hashlib
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response

from .auth import validate_secret_key
from .database import SessionLocal
from .routers import auth, count_comparisons, counts, dashboard, health, items, purchases, stock, users, waste

DEFAULT_WEB_DIR = Path(__file__).resolve().parents[2] / "web"  # <仓库根>/web


def _resolve_web_dir() -> Path | None:
    """WEB_DIR 环境变量优先；缺省回退 ../web；都不存在返回 None（跳过挂载）。"""
    candidates = []
    env_dir = os.environ.get("WEB_DIR")
    if env_dir:
        candidates.append(Path(env_dir))
    candidates.append(DEFAULT_WEB_DIR)
    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    return None


def _run_seed() -> None:
    try:
        from .. import seed  # app 作为子包被导入时
    except ImportError:  # uvicorn 从 server/ 启动时（app 为顶级包）
        import seed
    with SessionLocal() as db:
        seed.run_seed(db)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    validate_secret_key()
    if os.environ.get("AUTO_SEED", "1") == "1":
        _run_seed()
    yield


app = FastAPI(title="飨拓™库存管理", lifespan=lifespan)


@app.middleware("http")
async def api_etag(request, call_next):
    """为成功的 GET API 响应提供强 ETag，并支持条件请求。

    客户端按资源 URL 保存 JSON；恢复联通后用 If-None-Match 逐项验证，
    304 表示本地副本仍然有效，只有变化的资源才重新下载。
    """
    response = await call_next(request)
    if request.method != "GET" or not request.url.path.startswith("/api/") or response.status_code != 200:
        return response

    body = b"".join([chunk async for chunk in response.body_iterator])
    etag = '"' + hashlib.sha256(body).hexdigest() + '"'
    headers = dict(response.headers)
    headers["etag"] = etag
    headers["cache-control"] = "no-cache"
    headers["access-control-expose-headers"] = "ETag"
    if request.headers.get("if-none-match") == etag:
        headers.pop("content-length", None)
        headers.pop("content-encoding", None)
        return Response(status_code=304, headers=headers)
    return Response(
        content=body,
        status_code=response.status_code,
        headers=headers,
        media_type=response.media_type,
        background=response.background,
    )

app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(health.router)
app.include_router(users.router)
app.include_router(items.router)
app.include_router(stock.router)
app.include_router(counts.router)
app.include_router(count_comparisons.router)
app.include_router(waste.router)
app.include_router(purchases.router)
app.include_router(dashboard.router)

web_dir = _resolve_web_dir()
if web_dir is not None:
    app.mount("/", StaticFiles(directory=web_dir, html=True), name="web")
