"""Application entry point: `python -m laurence_lab_bot` (long polling or webhook server)."""

from __future__ import annotations

import logging
from typing import Any, Callable, Optional

from telegram import BotCommand, Update
from telegram.ext import Application, BasePersistence, PicklePersistence

from .config import Settings, load_settings
from .handlers import register
from .storage import Storage

logging.basicConfig(format="%(asctime)s %(levelname)s %(name)s: %(message)s", level=logging.INFO)
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("laurence_lab_bot")

COMMANDS = [
    BotCommand("start", "Main menu"),
    BotCommand("menu", "Browse the menu"),
    BotCommand("cart", "View your cart"),
    BotCommand("track", "Track an order"),
    BotCommand("orders", "Your recent orders"),
    BotCommand("support", "Speak to support"),
    BotCommand("about", "About the restaurant"),
    BotCommand("hours", "Opening hours"),
    BotCommand("help", "How to use this bot"),
    BotCommand("cancel", "Cancel the current action"),
]


async def _post_init(app: Application) -> None:
    await app.bot.set_my_commands(COMMANDS)
    me = await app.bot.get_me()
    log.info("Running as @%s — open https://t.me/%s on your phone", me.username, me.username)


_DEFAULT = object()


def build_application(
    settings: Optional[Settings] = None,
    storage: Any = _DEFAULT,
    persistence: Any = _DEFAULT,
    post_init: Any = _DEFAULT,
    request: Any = None,
) -> Application:
    """Build the bot. Defaults: SQLite storage, pickle persistence, command registration on start."""
    settings = settings or load_settings()
    if storage is _DEFAULT:
        storage = Storage(settings.db_path)
    if persistence is _DEFAULT:
        persistence = PicklePersistence(filepath="bot_state.pickle")
    if post_init is _DEFAULT:
        post_init = _post_init

    builder = Application.builder().token(settings.bot_token)
    if request is not None:
        builder = builder.request(request).get_updates_request(request)
    if persistence is not None:
        builder = builder.persistence(persistence)
    if post_init is not None:
        builder = builder.post_init(post_init)
    app = builder.build()
    app.bot_data["settings"] = settings
    app.bot_data["storage"] = storage
    register(app)
    return app


def main() -> None:
    app = build_application()
    settings = app.bot_data["settings"]
    if settings.webhook_url:
        log.info("Starting in webhook mode on port %s", settings.port)
        app.run_webhook(
            listen="0.0.0.0",
            port=settings.port,
            url_path=settings.bot_token,
            webhook_url=f"{settings.webhook_url.rstrip('/')}/{settings.bot_token}",
            allowed_updates=Update.ALL_TYPES,
            drop_pending_updates=True,
        )
    else:
        log.info("Starting in long-polling mode")
        app.run_polling(allowed_updates=Update.ALL_TYPES, drop_pending_updates=True)


if __name__ == "__main__":
    main()
