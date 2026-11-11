from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Site URLs live in backend/scraper/sites.py; these are empty fallbacks only.
    base_url: str = ""
    database_url: str = f"sqlite:///{ROOT_DIR / 'data' / 'app.db'}"
    media_dir: Path = ROOT_DIR / "media"
    data_dir: Path = ROOT_DIR / "data"
    default_gallery_url: str = ""
    scrape_concurrency: int = 2
    frontend_dist: Path = ROOT_DIR / "frontend" / "dist"
    phash_threshold: int = 8


settings = Settings()
