"""Runtime configuration loaded from environment variables / .env file."""

from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


def _parse_ids(raw: str) -> tuple[int, ...]:
    ids = []
    for part in raw.replace(";", ",").split(","):
        part = part.strip()
        if part:
            try:
                ids.append(int(part))
            except ValueError:
                continue
    return tuple(ids)


@dataclass(frozen=True)
class Settings:
    bot_token: str
    admin_chat_ids: tuple[int, ...]
    db_path: str
    currency: str
    bank_name: str
    bank_account_name: str
    bank_account_number: str
    paystack_secret_key: str | None
    telegram_provider_token: str | None
    webhook_url: str | None
    port: int

    @property
    def paystack_enabled(self) -> bool:
        return bool(self.paystack_secret_key)

    @property
    def telegram_payments_enabled(self) -> bool:
        return bool(self.telegram_provider_token)


def load_settings() -> Settings:
    token = os.getenv("BOT_TOKEN", "").strip()
    if not token:
        raise SystemExit(
            "BOT_TOKEN is not set. Create a bot with @BotFather on Telegram, "
            "copy the token into a .env file (see .env.example) and try again."
        )
    return Settings(
        bot_token=token,
        admin_chat_ids=_parse_ids(os.getenv("ADMIN_CHAT_IDS", "")),
        db_path=os.getenv("DB_PATH", "laurence_lab.db"),
        currency=os.getenv("CURRENCY_SYMBOL", "₦"),
        bank_name=os.getenv("BANK_NAME", "Laurence Lab Bank"),
        bank_account_name=os.getenv("BANK_ACCOUNT_NAME", "Laurence Lab Kitchen"),
        bank_account_number=os.getenv("BANK_ACCOUNT_NUMBER", "0123456789"),
        paystack_secret_key=os.getenv("PAYSTACK_SECRET_KEY") or None,
        telegram_provider_token=os.getenv("TELEGRAM_PROVIDER_TOKEN") or None,
        webhook_url=os.getenv("WEBHOOK_URL") or None,
        port=int(os.getenv("PORT", "8080")),
    )
