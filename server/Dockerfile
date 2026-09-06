# 飨拓™库存管理镜像（后端 + 内嵌前端）
# 注意：构建上下文必须是仓库根目录：
#   docker build -f server/Dockerfile .
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# 先装依赖，利用构建缓存
COPY server/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# 后端代码
COPY server/app ./app
COPY server/seed.py ./seed.py
COPY server/alembic.ini ./alembic.ini
COPY server/alembic ./alembic

# 前端静态文件（FastAPI 挂载到 /）
COPY web ./web

# 数据目录（SQLite），运行时用 volume 持久化
RUN mkdir -p /app/data
ENV DATABASE_URL=sqlite:////app/data/app.db \
    WEB_DIR=/app/web

EXPOSE 8000

# 先升级数据库；FastAPI lifespan 再执行幂等引导数据。
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000"]
