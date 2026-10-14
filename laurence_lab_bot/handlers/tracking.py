from __future__ import annotations

import re

from telegram import Update
from telegram.ext import ContextTypes

from ..formatting import order_summary, tracking_timeline
from ..keyboards import cancel_flow_keyboard, recent_orders_keyboard, track_keyboard
from ..storage import STATUS_LABELS
from .common import clear_flow, currency, notify_admins, respond, set_flow, storage

ORDER_ID_RE = re.compile(r"\bLL-?([A-Z0-9]{6})\b", re.IGNORECASE)


def extract_order_id(text: str) -> str | None:
    m = ORDER_ID_RE.search(text)
    return f"LL-{m.group(1).upper()}" if m else None


async def show_order(update: Update, context: ContextTypes.DEFAULT_TYPE, order_id: str) -> None:
    clear_flow(context)
    db = storage(context)
    order = db.get_order(order_id)
    user = update.effective_user
    if order is None or order.user_id != user.id:
        await respond(update, f"❌ I couldn't find order *{order_id}* for your account. "
                      "Check the ID or view your recent orders.", track_keyboard(None))
        return
    text = (
        f"📦 *Tracking {order.id}*\n\n{tracking_timeline(order)}\n\n"
        + order_summary(order, currency(context))
    )
    await respond(update, text, track_keyboard(order))


async def cmd_track(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    arg = " ".join(context.args) if context.args else ""
    oid = extract_order_id(arg) if arg else None
    if oid:
        await show_order(update, context, oid)
    else:
        await prompt_for_id(update, context)


async def prompt_for_id(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    last = context.user_data.get("last_order_id")
    recent = storage(context).orders_for_user(update.effective_user.id, limit=5)
    if recent:
        set_flow(context, "track_id")
        await respond(update, "📦 *Track order*\n\nPick one of your recent orders, or type an order ID "
                      f"(e.g. `{last or recent[0].id}`).", recent_orders_keyboard(recent))
    else:
        set_flow(context, "track_id")
        await respond(update, "📦 *Track order*\n\nType your order ID (it looks like `LL-AB12CD`).",
                      cancel_flow_keyboard())


async def cmd_my_orders(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    recent = storage(context).orders_for_user(update.effective_user.id, limit=10)
    if not recent:
        await respond(update, "You haven't placed any orders yet.", track_keyboard(None))
        return
    await respond(update, "📋 *Your recent orders*", recent_orders_keyboard(recent))


async def cb_track(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()
    parts = query.data.split(":")
    action = parts[1]
    if action == "prompt":
        await prompt_for_id(update, context)
    elif action == "list":
        await cmd_my_orders(update, context)
    elif action == "cancel":
        order_id = parts[2]
        db = storage(context)
        order = db.get_order(order_id)
        if order and order.user_id == update.effective_user.id and order.status in ("received", "confirmed") \
                and order.payment_status != "paid":
            order = db.set_status(order.id, "cancelled")
            await notify_admins(context, f"⚠️ Customer cancelled order *{order.id}*.")
            await show_order(update, context, order.id)
        else:
            await query.answer("This order can't be cancelled from here. Contact support.", show_alert=True)
    else:
        await show_order(update, context, action)


def status_message(order) -> str:
    label = STATUS_LABELS.get(order.status, order.status)
    extra = {
        "confirmed": "We've confirmed your order and the kitchen is on it.",
        "preparing": "Your food is being prepared right now 🔥",
        "out_for_delivery": f"Our rider is on the way! ETA ~{order.eta_minutes} min." if order.eta_minutes else "Our rider is on the way!",
        "ready_for_pickup": "Your order is ready — come and grab it!",
        "delivered": "Enjoy your meal! Thanks for ordering from Laurence Lab 🙏",
        "cancelled": "This order has been cancelled. Contact support if this is unexpected.",
    }.get(order.status, "")
    return f"📦 Order *{order.id}* — {label}\n{extra}"
