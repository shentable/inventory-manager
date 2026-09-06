"""环境变量配置：DATABASE_URL / WEB_DIR（与 Docker 部署对齐）。"""
from pathlib import Path


def test_database_url_resolution(monkeypatch, tmp_path):
    from app.database import _resolve_db_url

    url = f"sqlite:///{tmp_path}/nested/data/app.db"
    monkeypatch.setenv("DATABASE_URL", url)
    assert _resolve_db_url() == url
    assert (tmp_path / "nested" / "data").is_dir()  # sqlite 父目录自动创建


def test_database_url_absolute_docker_style(monkeypatch, tmp_path):
    """Docker 使用的绝对路径形式 sqlite:////app/data/app.db。"""
    from app.database import _resolve_db_url

    target = tmp_path / "app" / "data" / "app.db"
    url = f"sqlite:///{target}"
    monkeypatch.setenv("DATABASE_URL", url)
    assert _resolve_db_url() == url
    assert target.parent.is_dir()


def test_database_default_fallback(monkeypatch):
    from app.database import _resolve_db_url

    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("SANDWICH_DB_PATH", raising=False)
    url = _resolve_db_url()
    assert url.startswith("sqlite:///")
    assert url.endswith("data/app.db")


def test_web_dir_env_wins(monkeypatch, tmp_path):
    from app.main import _resolve_web_dir

    sub = tmp_path / "static"
    sub.mkdir()
    monkeypatch.setenv("WEB_DIR", str(sub))
    assert _resolve_web_dir() == sub


def test_web_dir_fallback_to_repo_web(monkeypatch):
    from app.main import _resolve_web_dir

    monkeypatch.delenv("WEB_DIR", raising=False)
    result = _resolve_web_dir()
    repo_web = Path(__file__).resolve().parents[2] / "web"
    if repo_web.is_dir():
        assert result == repo_web
    else:
        assert result is None


def test_web_dir_skips_when_all_missing(monkeypatch, tmp_path):
    from app.main import _resolve_web_dir

    monkeypatch.setenv("WEB_DIR", str(tmp_path / "does-not-exist"))
    repo_web = Path(__file__).resolve().parents[2] / "web"
    result = _resolve_web_dir()
    # 环境变量指向不存在目录时回退 ../web；两者都缺失才返回 None
    assert result == (repo_web if repo_web.is_dir() else None)
