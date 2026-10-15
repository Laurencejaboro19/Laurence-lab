"""Admin-only commands and buttons (users listed in ADMIN_CHAT_IDS)."""

from __future__ import annotations

from functools import wraps

from telegram import Update
from telegram.ext import ContextTypes

from ..formatting import md, money, order_summary
from ..keyboards import admin_order_keyboard, after_order_keyboard
from ..storage import ORDER_STATUSES, STATUS_LABELS
from .common import currency, is_admin, notify_user, respond, storage
from .tracking import status_message

ADMIN_HELP = (
    "*Admin commands*\n\n"
    "/queue – active orders\n"
    "/order LL-XXXXXX – view one order with action buttons\n"
    "/setstatus LL-XXXXXX <status> – update status\n"
    "   statuses: " + ", ".join(ORDER_STATUSES) + "\n"
    "/confirmpay LL-XXXXXX – mark a bank transfer as paid\n"
    "/reply <user_id> <message> – answer a support/inquiry message\n"
    "/inquiries – latest business inquiries\n"
    "/stats – totals\n"
    "/vendors – restaurant staff linked to each restaurant, with their vendor codes\n\n"
    "New orders, support messages and inquiries are pushed to you automatically."
)


def admin_only(func):
    @wraps(func)
    async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE):
        user = update.effective_user
        if user is None or not is_admin(context, user.id):
            if update.callback_query:
                await update.callback_query.answer("Admins only", show_alert=True)
            elif update.message:
                await update.message.reply_text("Sorry, that command is for restaurant staff only.")
            return
        return await func(update, context)

    return wrapper


@admin_only
async def cmd_admin(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(ADMIN_HELP, parse_mode="Markdown")


async def cmd_queue(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Admins see every active order; restaurant staff see their restaurant's."""
    from ..restaurant import get_restaurant

    user = update.effective_user
    db = storage(context)
    vendor_rid = db.vendor_restaurant(user.id)
    if is_admin(context, user.id):
        orders = db.active_orders()
        title = "Active orders"
    elif vendor_rid:
        orders = db.active_orders(restaurant_id=vendor_rid)
        title = f"Active orders — {get_restaurant(vendor_rid).name}"
    else:
        await update.message.reply_text("Sorry, that command is for restaurant staff only.")
        return
    if not orders:
        await update.message.reply_text("No active orders 🎉")
        return
    cur = currency(context)
    lines = [f"*{title} ({len(orders)})*", ""]
    for o in orders:
        r = get_restaurant(o.restaurant_id)
        lines.append(f"`{o.id}` · {r.emoji if r else ''} · {STATUS_LABELS.get(o.status, o.status)} · {money(o.total, cur)} · "
                     f"{'🛵' if o.fulfilment == 'delivery' else '🛍️'} · {md(o.customer_name)}")
    lines.append("\nUse /order LL-XXXXXX to act on one.")
    await update.message.reply_text("\n".join(lines), parse_mode="Markdown")


async def cmd_order(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    from ..keyboards import vendor_order_keyboard

    if not context.args:
        await update.message.reply_text("Usage: /order LL-XXXXXX")
        return
    user = update.effective_user
    db = storage(context)
    order = db.get_order(context.args[0])
    if order is None:
        await update.message.reply_text("Order not found.")
        return
    if is_admin(context, user.id):
        markup = admin_order_keyboard(order)
    elif db.vendor_restaurant(user.id) == order.restaurant_id:
        markup = vendor_order_keyboard(order)
    else:
        await update.message.reply_text("Sorry, that command is for restaurant staff only.")
        return
    await update.message.reply_text(order_summary(order, currency(context), for_admin=True),
                                    reply_markup=markup, parse_mode="Markdown")


async def _apply_status(context: ContextTypes.DEFAULT_TYPE, order_id: str, status: str):
    db = storage(context)
    order = db.set_status(order_id, status)
    if order is not None:
        await notify_user(context, order.chat_id, status_message(order), after_order_keyboard(order.id))
    return order


@admin_only
async def cmd_setstatus(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if len(context.args) < 2 or context.args[1] not in ORDER_STATUSES:
        await update.message.reply_text("Usage: /setstatus LL-XXXXXX <status>\nStatuses: " + ", ".join(ORDER_STATUSES))
        return
    order = storage(context).get_order(context.args[0])
    if order is None:
        await update.message.reply_text("Order not found.")
        return
    order = await _apply_status(context, order.id, context.args[1])
    await update.message.reply_text(order_summary(order, currency(context), for_admin=True),
                                    reply_markup=admin_order_keyboard(order), parse_mode="Markdown")


async def _mark_paid(context: ContextTypes.DEFAULT_TYPE, order_id: str):
    db = storage(context)
    order = db.update_order(order_id, payment_status="paid")
    if order is not None:
        await notify_user(context, order.chat_id,
                          f"✅ Payment for order *{order.id}* confirmed. Thank you! Your food is on its way to the kitchen.",
                          after_order_keyboard(order.id))
    return order


@admin_only
async def cmd_confirmpay(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not context.args:
        await update.message.reply_text("Usage: /confirmpay LL-XXXXXX")
        return
    order = storage(context).get_order(context.args[0])
    if order is None:
        await update.message.reply_text("Order not found.")
        return
    order = await _mark_paid(context, order.id)
    await update.message.reply_text(order_summary(order, currency(context), for_admin=True),
                                    reply_markup=admin_order_keyboard(order), parse_mode="Markdown")


@admin_only
async def cmd_reply(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if len(context.args) < 2:
        await update.message.reply_text("Usage: /reply <user_id> <message>")
        return
    try:
        target = int(context.args[0])
    except ValueError:
        await update.message.reply_text("The first argument must be the numeric Telegram user ID.")
        return
    message = " ".join(context.args[1:])
    ok = await notify_user(context, target, f"💬 *Message from Laurence Lab support:*\n\n{md(message)}")
    if ok:
        storage(context).close_tickets_for_user(target)
        await update.message.reply_text("Sent ✅")
    else:
        await update.message.reply_text("Couldn't deliver — the user may have blocked the bot.")


@admin_only
async def cmd_inquiries(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    rows = storage(context).list_inquiries(limit=10)
    if not rows:
        await update.message.reply_text("No business inquiries yet.")
        return
    parts = ["*Latest business inquiries*", ""]
    for r in rows:
        parts.append(
            f"*#{r['id']}* {md(r['name'])} ({md(r['company']) or 'personal'}) · {md(r['contact'])} · user `{r['user_id']}`\n"
            f"{md(r['message'][:300])}\n"
        )
    await update.message.reply_text("\n".join(parts), parse_mode="Markdown")


@admin_only
async def cmd_stats(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    s = storage(context).stats()
    cur = currency(context)
    by_status = "\n".join(f"  {STATUS_LABELS.get(k, k)}: {v}" for k, v in s["by_status"].items()) or "  —"
    await update.message.reply_text(
        f"📊 *Stats*\n\nOrders: {s['orders']} (value {money(s['revenue'], cur)})\n"
        f"Paid orders: {s['paid_orders']} ({money(s['paid_revenue'], cur)})\n"
        f"By status:\n{by_status}\n\nInquiries: {s['inquiries']}\nOpen support tickets: {s['open_tickets']}",
        parse_mode="Markdown",
    )


@admin_only
async def cb_admin(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    parts = query.data.split(":")
    action, order_id = parts[1], parts[2]
    db = storage(context)
    order = db.get_order(order_id)
    if order is None:
        await query.answer("Order not found", show_alert=True)
        return
    if action == "status":
        order = await _apply_status(context, order.id, parts[3])
        await query.answer(f"Status → {STATUS_LABELS[parts[3]]}")
    elif action == "paid":
        order = await _mark_paid(context, order.id)
        await query.answer("Marked as paid")
    else:
        await query.answer()
    await respond(update, order_summary(order, currency(context), for_admin=True), admin_order_keyboard(order))


@admin_only
async def cmd_vendors(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    from ..restaurant import RESTAURANTS

    db = storage(context)
    lines = ["*Partner restaurants & linked staff*", ""]
    for r in RESTAURANTS:
        chats = db.vendor_chat_ids(r.id)
        lines.append(f"{r.emoji} *{r.name}* — code `{r.effective_vendor_code()}` — "
                     f"{len(chats)} staff linked" + (" ⚠️ none" if not chats else ""))
    lines.append("\nRestaurant staff link themselves by sending the bot:\n`/vendor <code>`")
    await update.message.reply_text("\n".join(lines), parse_mode="Markdown")
