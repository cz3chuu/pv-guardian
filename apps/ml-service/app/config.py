from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "postgresql://pvguardian:pvguardian@localhost:5432/pvguardian"
    automation_enabled: bool = True
    automation_daily_seconds: int = 86400
    automation_weekly_seconds: int = 604800

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
