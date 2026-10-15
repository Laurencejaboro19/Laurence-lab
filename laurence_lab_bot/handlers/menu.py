from __future__ import annotations

from telegram import Update
from telegram.ext import ContextTypes

from ..formatting import money, restaurant_text
from ..keyboards import category_items, item_actions, restaurant_info_keyboard, restaurant_menu, restaurants_menu
from ..restaurant import MENU_BY_ID, category_label, get_restaurant
from .common import cart_count, currency, respond


def restaurants_text() -> str:
    return ("🏪 *Choose a restaurant*\n\n🟢 open now · 🔴 closed (pre-orders accepted)\n\n"
            "…or just type what you want, e.g. _2 jollof and 1 chicken_ or _chicken shawarma and fries_.")


async def cmd_menu(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await respond(update, restaurants_text(), restaurants_menu(cart_count(context)))


async def cb_menu(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()
    parts = query.data.split(":")
    action = parts[1]
    cur = currency(context)

    if action == "root":
        await respond(update, restaurants_text(), restaurants_menu(cart_count(context)))
    elif action == "rest":
        r = get_restaurant(parts[2])
        if r is None:
            await respond(update, restaurants_text(), restaurants_menu(cart_count(context)))
            return
        state = "🟢 Open now" if r.is_open_now() else "🔴 Closed now – pre-orders accepted"
        await respond(update, f"{r.emoji} *{r.name}*\n_{r.tagline}_\n{state}\n\nPick a category:",
                      restaurant_menu(r.id, cart_count(context)))
    elif action == "info":
        await respond(update, restaurant_text(parts[2]), restaurant_info_keyboard(parts[2]))
        r = get_restaurant(parts[2])
        if r:
            await update.effective_chat.send_location(r.latitude, r.longitude)
    elif action == "cat":
        rid, cat_id = parts[2], parts[3]
        r = get_restaurant(rid)
        await respond(update, f"{r.emoji if r else ''} *{r.name if r else ''}* › {category_label(cat_id)}\n\n"
                      "Tap an item to see details and add it to your cart.", category_items(rid, cat_id, cur))
    elif action in ("item", "qty"):
        item_id = parts[2]
        qty = int(parts[3]) if action == "qty" and len(parts) > 3 else 1
        item = MENU_BY_ID.get(item_id)
        if item is None:
            await respond(update, "Sorry, that item is no longer available.", restaurants_menu(cart_count(context)))
            return
        r = get_restaurant(item.restaurant_id)
        text = (f"{item.emoji} *{item.name}*\n{item.description}\n🏪 {r.name if r else ''}\n\n"
                f"Price: *{money(item.price, cur)}* per {item.unit}\nQuantity: {qty} → {money(item.price * qty, cur)}")
        await respond(update, text, item_actions(item_id, qty))
