"""Helpers shared by all handlers."""

from __future__ import annotations

import logging
from typing import Any

from telegram import InlineKeyboardMarkup, Update
from telegram.constants import ParseMode
from telegram.error import BadRequest, Forbidden
from telegram.ext import ContextTypes

from ..config import Settings
from ..storage import Storage

log = logging.getLogger(__name__)


def settings(context: ContextTypes.DEFAULT_TYPE) -> Settings:
    return context.bot_data["settings"]


def storage(context: ContextTypes.DEFAULT_TYPE) -> Storage:
    return context.bot_data["storage"]


def currency(context: ContextTypes.DEFAULT_TYPE) -> str:
    return settings(context).currency


def is_admin(context: ContextTypes.DEFAULT_TYPE, user_id: int) -> bool:
    return user_id in settings(context).admin_chat_ids


# ------------------------------------------------------------------ user state
def cart(context: ContextTypes.DEFAULT_TYPE) -> dict[str, int]:
    return context.user_data.setdefault("cart", {})


def cart_count(context: ContextTypes.DEFAULT_TYPE) -> int:
    return sum(cart(context).values())


def set_flow(context: ContextTypes.DEFAULT_TYPE, name: str | None, **data: Any) -> None:
    if name is None:
        context.user_data.pop("flow", None)
    else:
        context.user_data["flow"] = name
    if data:
        context.user_data.setdefault("flow_data", {}).update(data)


def flow(context: ContextTypes.DEFAULT_TYPE) -> str | None:
    return context.user_data.get("flow")


def flow_data(context: ContextTypes.DEFAULT_TYPE) -> dict[str, Any]:
    return context.user_data.setdefault("flow_data", {})


def clear_flow(context: ContextTypes.DEFAULT_TYPE) -> None:
    context.user_data.pop("flow", None)
    context.user_data.pop("flow_data", None)


# -------------------------------------------------------------------- replies
async def respond(
    update: Update,
    text: str,
    markup: InlineKeyboardMarkup | Any | None = None,
    *,
    edit: bool = True,
    parse_mode: str = ParseMode.MARKDOWN,
) -> None:
    """Edit the message behind a button press, or send a new message for a normal update."""
    query = update.callback_query
    if query is not None and edit and query.message is not None:
        try:
            await query.edit_message_text(text, reply_markup=markup, parse_mode=parse_mode)
            return
        except BadRequest as exc:
            if "not modified" in str(exc).lower():
                return
            # Message may be too old or had a photo; fall through and send a fresh one.
    chat = update.effective_chat
    if chat is not None:
        await chat.send_message(text, reply_markup=markup, parse_mode=parse_mode)


async def notify_admins(
    context: ContextTypes.DEFAULT_TYPE, text: str, markup: InlineKeyboardMarkup | None = None
) -> None:
    for admin_id in settings(context).admin_chat_ids:
        try:
            await context.bot.send_message(admin_id, text, reply_markup=markup, parse_mode=ParseMode.MARKDOWN)
        except (Forbidden, BadRequest) as exc:
            log.warning("Could not notify admin %s: %s", admin_id, exc)


async def notify_user(context: ContextTypes.DEFAULT_TYPE, chat_id: int, text: str, markup=None) -> bool:
    try:
        await context.bot.send_message(chat_id, text, reply_markup=markup, parse_mode=ParseMode.MARKDOWN)
        return True
    except (Forbidden, BadRequest) as exc:
        log.warning("Could not message chat %s: %s", chat_id, exc)
        return False
