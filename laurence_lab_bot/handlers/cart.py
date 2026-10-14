from __future__ import annotations

from telegram import Update
from telegram.ext import ContextTypes

from ..formatting import cart_lines, money
from ..keyboards import cart_actions
from ..restaurant import MENU_BY_ID
from .common import cart, currency, respond


def cart_text(context: ContextTypes.DEFAULT_TYPE) -> str:
    items = cart(context)
    if not items:
        return "🛒 *Your cart is empty.*\n\nBrowse the menu or type what you'd like to order."
    lines, subtotal = cart_lines(items, currency(context))
    return f"🛒 *Your cart*\n\n{lines}\n\n*Subtotal: {money(subtotal, currency(context))}*\nDelivery fee is calculated at checkout."


async def show_cart(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await respond(update, cart_text(context), cart_actions(cart(context)))


async def cmd_cart(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await show_cart(update, context)


async def cb_cart(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    parts = query.data.split(":")
    action = parts[1]
    items = cart(context)

    if action == "view":
        await query.answer()
    elif action == "add":
        item_id, qty = parts[2], int(parts[3])
        if item_id in MENU_BY_ID:
            items[item_id] = min(99, items.get(item_id, 0) + qty)
            await query.answer(f"Added {qty} × {MENU_BY_ID[item_id].name} ✅")
        else:
            await query.answer("Item not available")
    elif action == "inc":
        item_id = parts[2]
        if item_id in items:
            items[item_id] = min(99, items[item_id] + 1)
        await query.answer()
    elif action == "dec":
        item_id = parts[2]
        if item_id in items:
            items[item_id] -= 1
            if items[item_id] <= 0:
                del items[item_id]
        await query.answer()
    elif action == "remove":
        items.pop(parts[2], None)
        await query.answer("Removed")
    elif action == "clear":
        items.clear()
        await query.answer("Cart cleared")
    else:
        await query.answer()
    await show_cart(update, context)


async def cb_nlp(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Buttons shown after we parsed a plain-text order."""
    from .checkout import start_checkout

    query = update.callback_query
    await query.answer()
    parts = query.data.split(":")
    pending: dict[str, int] = context.user_data.pop("pending_order", {}) or {}
    if parts[1] == "discard" or not pending:
        await respond(update, "Okay, discarded. Browse the menu or tell me something else to order.",
                      cart_actions(cart(context)))
        return
    items = cart(context)
    for item_id, qty in pending.items():
        items[item_id] = min(99, items.get(item_id, 0) + qty)
    if parts[2] == "checkout":
        await start_checkout(update, context)
    else:
        await show_cart(update, context)
