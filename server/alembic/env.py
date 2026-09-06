from logging.config import fileConfig
import os

from alembic import context
from sqlalchemy import engine_from_config, pool

from app.database import Base, _resolve_db_url
from app import models  # noqa: F401

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

config.set_main_option("sqlalchemy.url", _resolve_db_url().replace("%", "%%"))
target_metadata = Base.metadata


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    raise RuntimeError("本项目迁移需要在线 SQLite 连接")
run_migrations_online()
