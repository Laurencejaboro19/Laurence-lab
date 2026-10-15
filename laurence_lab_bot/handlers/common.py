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


def all_admin_ids(context: ContextTypes.DEFAULT_TYPE) -> set[int]:
    ids = set(settings(context).admin_chat_ids)
    try:
        ids |= storage(context).admin_ids()
    except Exception as exc:  # storage hiccup must not break the bot
        log.warning("Could not read registered admins: %s", exc)
    return ids


def is_admin(context: ContextTypes.DEFAULT_TYPE, user_id: int) -> bool:
    return user_id in all_admin_ids(context)


async def register_admin_by_username(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Runs before every update: users whose @username is in ADMIN_USERNAMES become admins."""
    user = update.effective_user
    if user is None or not user.username:
        return
    cfg = settings(context)
    if user.username.lower() in cfg.admin_usernames and user.id not in cfg.admin_chat_ids:
        db = storage(context)
        if user.id not in db.admin_ids():
            chat = update.effective_chat
            db.register_admin(user.id, user.username, chat.id if chat else user.id)
            log.info("Registered admin @%s (%s)", user.username, user.id)


# ------------------------------------------------------------------ user state
def cart(context: ContextTypes.DEFAULT_TYPE) -> dict[str, int]:
    return context.user_data.setdefault("cart", {})


def cart_count(context: ContextTypes.DEFAULT_TYPE) -> int:
    return sum(cart(context).values())


def cart_restaurant_id(context: ContextTypes.DEFAULT_TYPE) -> str | None:
    """The restaurant the cart belongs to (a cart holds items from one restaurant only)."""
    items = cart(context)
    if not items:
        context.user_data.pop("cart_restaurant", None)
        return None
    rid = context.user_data.get("cart_restaurant")
    if not rid:
        from ..restaurant import MENU_BY_ID
        first = MENU_BY_ID.get(next(iter(items)))
        rid = first.restaurant_id if first else None
        if rid:
            context.user_data["cart_restaurant"] = rid
    return rid


def add_to_cart(context: ContextTypes.DEFAULT_TYPE, item_id: str, qty: int, *, replace: bool = False) -> str | None:
    """Add an item. Returns the name of a conflicting restaurant if the cart belongs to another one."""
    from ..restaurant import MENU_BY_ID, get_restaurant
    item = MENU_BY_ID.get(item_id)
    if item is None:
        return None
    items = cart(context)
    current = cart_restaurant_id(context)
    if current and current != item.restaurant_id:
        if not replace:
            return get_restaurant(current).name
        items.clear()
    items[item_id] = min(99, items.get(item_id, 0) + qty)
    context.user_data["cart_restaurant"] = item.restaurant_id
    return None


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
    for admin_id in sorted(all_admin_ids(context)):
        try:
            await context.bot.send_message(admin_id, text, reply_markup=markup, parse_mode=ParseMode.MARKDOWN)
        except (Forbidden, BadRequest) as exc:
            log.warning("Could not notify admin %s: %s", admin_id, exc)


async def notify_restaurant(context: ContextTypes.DEFAULT_TYPE, order, text: str, markup=None) -> int:
    """Send an order to the restaurant's registered staff on Telegram (and by email as fallback).

    Returns how many Telegram chats received it.
    """
    from ..emailer import email_enabled, send_email
    from ..restaurant import get_restaurant

    sent = 0
    for chat_id in storage(context).vendor_chat_ids(order.restaurant_id):
        try:
            await context.bot.send_message(chat_id, text, reply_markup=markup, parse_mode=ParseMode.MARKDOWN)
            sent += 1
        except (Forbidden, BadRequest) as exc:
            log.warning("Could not notify vendor chat %s: %s", chat_id, exc)
    rest = get_restaurant(order.restaurant_id)
    if rest and rest.email and email_enabled():
        plain = text.replace("*", "").replace("`", "").replace("_", "")
        send_email(rest.email, f"New order {order.id} – {rest.name}", plain)
    return sent


def is_vendor_for(context: ContextTypes.DEFAULT_TYPE, user_id: int, restaurant_id: str) -> bool:
    return storage(context).vendor_restaurant(user_id) == restaurant_id


async def notify_user(context: ContextTypes.DEFAULT_TYPE, chat_id: int, text: str, markup=None) -> bool:
    try:
        await context.bot.send_message(chat_id, text, reply_markup=markup, parse_mode=ParseMode.MARKDOWN)
        return True
    except (Forbidden, BadRequest) as exc:
        log.warning("Could not message chat %s: %s", chat_id, exc)
        return False
