from __future__ import annotations

from telegram import Update
from telegram.ext import ContextTypes

from ..formatting import money
from ..keyboards import categories_menu, category_items, item_actions
from ..restaurant import MENU_BY_ID, category_label
from .common import cart_count, currency, respond


def categories_text() -> str:
    return "🍽️ *Our menu*\n\nPick a category, or just type what you want (e.g. _2 jollof and 1 chicken_)."


async def cmd_menu(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await respond(update, categories_text(), categories_menu(cart_count(context)))


async def cb_menu(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()
    parts = query.data.split(":")
    action = parts[1]
    cur = currency(context)

    if action == "root":
        await respond(update, categories_text(), categories_menu(cart_count(context)))
    elif action == "cat":
        cat_id = parts[2]
        await respond(update, f"*{category_label(cat_id)}*\n\nTap an item to see details and add it to your cart.",
                      category_items(cat_id, cur))
    elif action in ("item", "qty"):
        item_id = parts[2]
        qty = int(parts[3]) if action == "qty" and len(parts) > 3 else 1
        item = MENU_BY_ID.get(item_id)
        if item is None:
            await respond(update, "Sorry, that item is no longer available.", categories_menu(cart_count(context)))
            return
        text = (
            f"{item.emoji} *{item.name}*\n{item.description}\n\n"
            f"Price: *{money(item.price, cur)}* per {item.unit}\n"
            f"Quantity: {qty} → {money(item.price * qty, cur)}"
        )
        await respond(update, text, item_actions(item_id, qty))
