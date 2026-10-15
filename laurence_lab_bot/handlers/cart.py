from __future__ import annotations

from telegram import Update
from telegram.ext import ContextTypes

from ..formatting import cart_lines, money
from ..keyboards import cart_actions, replace_cart_keyboard
from ..restaurant import MENU_BY_ID, get_restaurant
from .common import add_to_cart, cart, cart_restaurant_id, currency, respond


def cart_text(context: ContextTypes.DEFAULT_TYPE) -> str:
    items = cart(context)
    if not items:
        return "🛒 *Your cart is empty.*\n\nBrowse the restaurants or type what you'd like to order."
    r = get_restaurant(cart_restaurant_id(context))
    lines, subtotal = cart_lines(items, currency(context))
    return (f"🛒 *Your cart* — {r.emoji + ' ' + r.name if r else ''}\n\n{lines}\n\n"
            f"*Subtotal: {money(subtotal, currency(context))}*\nDelivery fee is calculated at checkout.")


async def show_cart(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await respond(update, cart_text(context), cart_actions(cart(context), cart_restaurant_id(context)))


async def cmd_cart(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await show_cart(update, context)


async def cb_cart(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    parts = query.data.split(":")
    action = parts[1]
    items = cart(context)

    if action == "view":
        await query.answer()
    elif action in ("add", "replace"):
        item_id, qty = parts[2], int(parts[3])
        conflict = add_to_cart(context, item_id, qty, replace=(action == "replace"))
        if conflict:
            await query.answer()
            await respond(update, f"Your cart has items from *{conflict}*. One restaurant per order, so each kitchen "
                          "can cook and dispatch on its own.\n\nStart a new cart with this item instead?",
                          replace_cart_keyboard(item_id, qty))
            return
        name = MENU_BY_ID[item_id].name if item_id in MENU_BY_ID else "item"
        await query.answer(f"Added {qty} × {name} ✅")
    elif action == "inc":
        if parts[2] in items:
            items[parts[2]] = min(99, items[parts[2]] + 1)
        await query.answer()
    elif action == "dec":
        if parts[2] in items:
            items[parts[2]] -= 1
            if items[parts[2]] <= 0:
                del items[parts[2]]
        await query.answer()
    elif action == "remove":
        items.pop(parts[2], None)
        await query.answer("Removed")
    elif action == "clear":
        items.clear()
        context.user_data.pop("cart_restaurant", None)
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
        await respond(update, "Okay, discarded. Browse the restaurants or tell me something else to order.",
                      cart_actions(cart(context), cart_restaurant_id(context)))
        return
    first = True
    for item_id, qty in pending.items():
        # a typed order always comes from one restaurant; it replaces a cart from another restaurant
        add_to_cart(context, item_id, qty, replace=first)
        first = False
    if parts[2] == "checkout":
        await start_checkout(update, context)
    else:
        await show_cart(update, context)
