from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict


ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
load_dotenv(BACKEND_ROOT / ".env")


class Settings(BaseSettings):
    openai_api_key: str = ""
    agent_model: str = "gpt-5-mini"
    postgres_dsn: str = "postgresql://expense_guard:expense_guard@127.0.0.1:55432/expense_guard"
    synapsor_url: str = "https://synapsor.ai"
    synapsor_project_id: str = "expense_guard"
    synapsor_database_id: str = "db_expense_guard_dev_replace_me"
    synapsor_api_key: str = ""
    cors_origins: str = "http://localhost:5174,http://127.0.0.1:5174"
    background_interval_seconds: int = 25
    log_level: str = "INFO"

    model_config = SettingsConfigDict(env_file=(ROOT / ".env", BACKEND_ROOT / ".env"), extra="ignore")

    @property
    def cors_origin_list(self) -> list[str]:
        return [item.strip() for item in self.cors_origins.split(",") if item.strip()]

    @property
    def synapsor_remote_api_key(self) -> str:
        return self.synapsor_api_key

    def configure_openai_environment(self) -> None:
        if self.openai_api_key:
            os.environ["OPENAI_API_KEY"] = self.openai_api_key


@lru_cache
def get_settings() -> Settings:
    return Settings()
