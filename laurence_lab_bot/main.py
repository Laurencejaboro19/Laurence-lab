"""Application entry point: `python -m laurence_lab_bot`."""

from __future__ import annotations

import logging

from telegram import BotCommand, Update
from telegram.ext import Application, PicklePersistence

from .config import load_settings
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


def build_application() -> Application:
    settings = load_settings()
    persistence = PicklePersistence(filepath="bot_state.pickle")
    app = (
        Application.builder()
        .token(settings.bot_token)
        .persistence(persistence)
        .post_init(_post_init)
        .build()
    )
    app.bot_data["settings"] = settings
    app.bot_data["storage"] = Storage(settings.db_path)
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
