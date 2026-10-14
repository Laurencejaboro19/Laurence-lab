"""Run the bot as a stateless webhook function (Vercel). One Telegram update per invocation."""

from __future__ import annotations

import hashlib
import json
import logging
import os
from typing import Any, Optional

from telegram import BotCommand, Update
from telegram.ext import BasePersistence, PersistenceInput

from .blob_store import BlobKV, BlobStorage
from .config import Settings, load_settings
from .main import COMMANDS, build_application

log = logging.getLogger(__name__)


def webhook_secret(bot_token: str) -> str:
    return hashlib.sha256(("laurence-lab:" + bot_token).encode()).hexdigest()[:48]


def extract_user_id(update_json: dict[str, Any]) -> Optional[int]:
    for key in ("message", "edited_message", "callback_query", "pre_checkout_query", "shipping_query",
                "inline_query", "my_chat_member", "chat_member"):
        obj = update_json.get(key)
        if isinstance(obj, dict) and isinstance(obj.get("from"), dict):
            return obj["from"].get("id")
    return None


class SingleUserPersistence(BasePersistence):
    """Loads/saves only the current user's ``user_data`` from Blob storage."""

    def __init__(self, storage: BlobStorage, user_id: int) -> None:
        super().__init__(
            store_data=PersistenceInput(bot_data=False, chat_data=False, user_data=True, callback_data=False),
            update_interval=10**9,
        )
        self._storage = storage
        self._user_id = user_id
        self._loaded = storage.load_user_state(user_id)
        self._snapshot = json.dumps(self._loaded, sort_keys=True, default=str)

    async def get_user_data(self):
        return {self._user_id: dict(self._loaded)}

    async def update_user_data(self, user_id: int, data) -> None:
        if user_id != self._user_id:
            return
        snapshot = json.dumps(data, sort_keys=True, default=str)
        if snapshot != self._snapshot:
            self._storage.save_user_state(user_id, json.loads(snapshot))
            self._snapshot = snapshot

    async def refresh_user_data(self, user_id: int, user_data) -> None:
        return None

    async def drop_user_data(self, user_id: int) -> None:
        self._storage.save_user_state(user_id, {})

    # Unused parts of the interface
    async def get_chat_data(self):
        return {}

    async def update_chat_data(self, chat_id: int, data) -> None:
        return None

    async def refresh_chat_data(self, chat_id: int, chat_data) -> None:
        return None

    async def drop_chat_data(self, chat_id: int) -> None:
        return None

    async def get_bot_data(self):
        return {}

    async def update_bot_data(self, data) -> None:
        return None

    async def refresh_bot_data(self, bot_data) -> None:
        return None

    async def get_callback_data(self):
        return None

    async def update_callback_data(self, data) -> None:
        return None

    async def get_conversations(self, name: str):
        return {}

    async def update_conversation(self, name: str, key, new_state) -> None:
        return None

    async def flush(self) -> None:
        return None


def make_storage(settings: Settings) -> BlobStorage:
    token = os.getenv("BLOB_READ_WRITE_TOKEN", "")
    if not token:
        raise RuntimeError("BLOB_READ_WRITE_TOKEN is not set – attach a Vercel Blob store to the project.")
    return BlobStorage(BlobKV(token))


async def process_update(update_json: dict[str, Any], *, storage: Any = None, request: Any = None) -> None:
    settings = load_settings()
    storage = storage or make_storage(settings)
    user_id = extract_user_id(update_json)
    persistence = SingleUserPersistence(storage, user_id) if user_id else None
    app = build_application(settings=settings, storage=storage, persistence=persistence, post_init=None, request=request)
    try:
        async with app:
            update = Update.de_json(update_json, app.bot)
            await app.process_update(update)
    finally:
        storage.close()


async def setup_webhook(public_base_url: str) -> dict[str, Any]:
    """Point Telegram at this deployment and register the command menu."""
    settings = load_settings()
    app = build_application(settings=settings, storage=None, persistence=None, post_init=None)
    url = f"{public_base_url.rstrip('/')}/api/webhook"
    async with app:
        me = await app.bot.get_me()
        await app.bot.set_webhook(
            url=url,
            secret_token=webhook_secret(settings.bot_token),
            allowed_updates=Update.ALL_TYPES,
            drop_pending_updates=True,
            max_connections=20,
        )
        await app.bot.set_my_commands(COMMANDS)
        info = await app.bot.get_webhook_info()
    return {
        "ok": True,
        "bot": me.username,
        "bot_link": f"https://t.me/{me.username}",
        "webhook_url": info.url,
        "pending_updates": info.pending_update_count,
        "last_error": info.last_error_message,
    }


async def status() -> dict[str, Any]:
    settings = load_settings()
    app = build_application(settings=settings, storage=None, persistence=None, post_init=None)
    async with app:
        me = await app.bot.get_me()
        info = await app.bot.get_webhook_info()
    return {
        "ok": True,
        "bot": me.username,
        "bot_link": f"https://t.me/{me.username}",
        "webhook_url": info.url,
        "pending_updates": info.pending_update_count,
        "last_error": info.last_error_message,
        "admins_configured": len(settings.admin_chat_ids),
        "blob_storage": bool(os.getenv("BLOB_READ_WRITE_TOKEN")),
    }
