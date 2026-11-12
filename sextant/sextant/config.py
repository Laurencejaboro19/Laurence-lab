"""Configuration, read once from environment variables (see .env.example)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    try:
        return int(raw) if raw else default
    except ValueError:
        raise SystemExit(f"Config error: {name} must be an integer, got {raw!r}")


def _float(name: str, default: float) -> float:
    raw = os.getenv(name, "").strip()
    try:
        return float(raw) if raw else default
    except ValueError:
        raise SystemExit(f"Config error: {name} must be a number, got {raw!r}")


def _bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name, "").strip().lower()
    return default if not raw else raw in {"1", "true", "yes", "on"}


def _list(name: str, default: str = "") -> list[str]:
    return [p.strip() for p in os.getenv(name, default).split(",") if p.strip()]


@dataclass(frozen=True)
class Depth:
    """A research-depth preset: every number here is a hard ceiling."""

    name: str
    max_queries: int  # search queries across the whole task
    max_sources: int  # pages fetched and read
    max_iterations: int  # search -> read -> gap-check rounds
    max_ai_calls: int
    max_tokens: int  # prompt + completion tokens across the task


DEPTHS = {
    "quick": Depth("quick", max_queries=4, max_sources=5, max_iterations=1, max_ai_calls=5, max_tokens=60_000),
    "standard": Depth("standard", max_queries=8, max_sources=10, max_iterations=2, max_ai_calls=9, max_tokens=140_000),
    "deep": Depth("deep", max_queries=14, max_sources=18, max_iterations=3, max_ai_calls=14, max_tokens=260_000),
}


@dataclass
class Config:
    bot_token: str = ""
    allowed_user_ids: frozenset[int] = frozenset()
    data_dir: Path = Path("data")
    telegram_base_url: str = ""  # only for tests / self-hosted Bot API server

    # --- AI providers -------------------------------------------------
    ai_provider_order: list[str] = field(default_factory=list)
    gemini_api_key: str = ""
    gemini_model: str = "gemini-3.5-flash-lite"
    gemini_base_url: str = "https://generativelanguage.googleapis.com/v1beta"
    groq_api_key: str = ""
    groq_model: str = "openai/gpt-oss-120b"
    groq_vision_model: str = ""
    openrouter_api_key: str = ""
    openrouter_model: str = "openrouter/free"
    openrouter_vision_model: str = ""
    ollama_base_url: str = ""
    ollama_model: str = "llama3.2"
    ollama_vision_model: str = ""
    custom_base_url: str = ""
    custom_api_key: str = ""
    custom_model: str = ""
    custom_vision_model: str = ""
    ocr_space_api_key: str = ""
    ai_daily_request_limit: int = 400  # per provider, counted from usage_logs
    ai_min_interval: float = 4.5  # seconds between calls to one provider
    ai_max_retries: int = 3
    ai_timeout: float = 90.0
    ai_max_prompt_chars: int = 60_000

    # --- Search -------------------------------------------------------
    search_provider_order: list[str] = field(default_factory=list)
    brave_api_key: str = ""
    tavily_api_key: str = ""
    searxng_url: str = ""
    search_cache_hours: int = 24
    search_results_per_query: int = 6
    http_timeout: float = 20.0
    max_page_bytes: int = 1_500_000
    page_chars: int = 5_000  # characters of each page handed to the model
    respect_robots: bool = True
    allow_private_fetch: bool = False  # tests only: lets the fetcher hit localhost

    # --- Research behaviour -------------------------------------------
    default_depth: str = "standard"
    max_report_chars: int = 16_000
    attach_window: float = 8.0  # seconds a new task waits for images/extra context
    max_research_per_hour: int = 6
    heartbeat_seconds: float = 20.0
    stale_seconds: float = 180.0  # PROCESSING with no heartbeat for this long = abandoned
    max_attempts: int = 2

    # --- Images -------------------------------------------------------
    max_image_bytes: int = 10 * 1024 * 1024
    max_images_per_task: int = 6

    # --- Scheduling ---------------------------------------------------
    scheduler_enabled: bool = False
    default_timezone: str = "Africa/Lagos"
    schedule_catchup_hours: float = 6.0

    log_level: str = "INFO"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "sextant.db"

    @property
    def image_dir(self) -> Path:
        return self.data_dir / "images"

    def depth(self, name: str | None = None) -> Depth:
        return DEPTHS.get((name or self.default_depth).lower(), DEPTHS["standard"])


def load_config() -> Config:
    try:
        from dotenv import load_dotenv

        load_dotenv()
    except ImportError:  # python-dotenv is optional at runtime
        pass

    ids: set[int] = set()
    for part in _list("ALLOWED_USER_IDS"):
        if not part.lstrip("-").isdigit():
            raise SystemExit(f"Config error: ALLOWED_USER_IDS must be numeric Telegram IDs, got {part!r}")
        ids.add(int(part))

    cfg = Config(
        bot_token=os.getenv("TELEGRAM_BOT_TOKEN", "").strip(),
        allowed_user_ids=frozenset(ids),
        data_dir=Path(os.getenv("DATA_DIR", "data")),
        telegram_base_url=os.getenv("TELEGRAM_BASE_URL", "").strip(),
        ai_provider_order=_list("AI_PROVIDER_ORDER", "gemini,groq,openrouter,custom,ollama"),
        gemini_api_key=os.getenv("GEMINI_API_KEY", "").strip(),
        gemini_model=os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite").strip(),
        gemini_base_url=os.getenv("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta").rstrip("/"),
        groq_api_key=os.getenv("GROQ_API_KEY", "").strip(),
        groq_model=os.getenv("GROQ_MODEL", "openai/gpt-oss-120b").strip(),
        groq_vision_model=os.getenv("GROQ_VISION_MODEL", "").strip(),
        openrouter_api_key=os.getenv("OPENROUTER_API_KEY", "").strip(),
        openrouter_model=os.getenv("OPENROUTER_MODEL", "openrouter/free").strip(),
        openrouter_vision_model=os.getenv("OPENROUTER_VISION_MODEL", "").strip(),
        ollama_base_url=os.getenv("OLLAMA_BASE_URL", "").rstrip("/"),
        ollama_model=os.getenv("OLLAMA_MODEL", "llama3.2").strip(),
        ollama_vision_model=os.getenv("OLLAMA_VISION_MODEL", "").strip(),
        custom_base_url=os.getenv("CUSTOM_AI_BASE_URL", "").rstrip("/"),
        custom_api_key=os.getenv("CUSTOM_AI_API_KEY", "").strip(),
        custom_model=os.getenv("CUSTOM_AI_MODEL", "").strip(),
        custom_vision_model=os.getenv("CUSTOM_AI_VISION_MODEL", "").strip(),
        ocr_space_api_key=os.getenv("OCR_SPACE_API_KEY", "").strip(),
        ai_daily_request_limit=_int("AI_DAILY_REQUEST_LIMIT", 400),
        ai_min_interval=_float("AI_MIN_INTERVAL_SECONDS", 4.5),
        ai_max_retries=_int("AI_MAX_RETRIES", 3),
        ai_timeout=_float("AI_TIMEOUT_SECONDS", 90.0),
        ai_max_prompt_chars=_int("AI_MAX_PROMPT_CHARS", 60_000),
        search_provider_order=_list("SEARCH_PROVIDER_ORDER", "brave,tavily,searxng,duckduckgo"),
        brave_api_key=os.getenv("BRAVE_API_KEY", "").strip(),
        tavily_api_key=os.getenv("TAVILY_API_KEY", "").strip(),
        searxng_url=os.getenv("SEARXNG_URL", "").rstrip("/"),
        search_cache_hours=_int("SEARCH_CACHE_HOURS", 24),
        search_results_per_query=_int("SEARCH_RESULTS_PER_QUERY", 6),
        http_timeout=_float("HTTP_TIMEOUT_SECONDS", 20.0),
        page_chars=_int("PAGE_CHARS", 5_000),
        respect_robots=_bool("RESPECT_ROBOTS_TXT", True),
        allow_private_fetch=_bool("ALLOW_PRIVATE_FETCH", False),
        default_depth=os.getenv("RESEARCH_DEPTH", "standard").strip().lower(),
        max_report_chars=_int("MAX_REPORT_CHARS", 16_000),
        attach_window=_float("ATTACH_WINDOW_SECONDS", 8.0),
        max_research_per_hour=_int("MAX_RESEARCH_PER_HOUR", 6),
        stale_seconds=_float("STALE_TASK_SECONDS", 180.0),
        max_attempts=_int("MAX_TASK_ATTEMPTS", 2),
        max_image_bytes=_int("MAX_IMAGE_MB", 10) * 1024 * 1024,
        max_images_per_task=_int("MAX_IMAGES_PER_TASK", 6),
        scheduler_enabled=_bool("SCHEDULER_ENABLED", False),
        default_timezone=os.getenv("DEFAULT_TIMEZONE", "Africa/Lagos").strip(),
        schedule_catchup_hours=_float("SCHEDULE_CATCHUP_HOURS", 6.0),
        log_level=os.getenv("LOG_LEVEL", "INFO").strip().upper(),
    )
    if cfg.default_depth not in DEPTHS:
        raise SystemExit(f"Config error: RESEARCH_DEPTH must be one of {', '.join(DEPTHS)}")
    return cfg


def require_runtime(cfg: Config) -> None:
    """Fail fast with a precise message when the bot cannot possibly work."""
    problems = []
    if not cfg.bot_token:
        problems.append("TELEGRAM_BOT_TOKEN is not set (create a bot with @BotFather).")
    if not cfg.allowed_user_ids:
        problems.append("ALLOWED_USER_IDS is empty (get your numeric ID from @userinfobot).")
    if problems:
        raise SystemExit("Cannot start:\n- " + "\n- ".join(problems))
