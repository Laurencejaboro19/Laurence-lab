"""Restaurant-side flow: staff link to their restaurant with a vendor code and act on incoming orders."""

from __future__ import annotations

from telegram import Update
from telegram.ext import ContextTypes

from ..formatting import md, order_summary
from ..keyboards import after_order_keyboard, admin_order_keyboard, vendor_order_keyboard
from ..restaurant import find_restaurant_by_code, get_restaurant
from ..storage import STATUS_LABELS
from .common import currency, is_admin, notify_admins, notify_user, respond, storage
from .tracking import status_message

REJECT_REASONS = {
    "stock": "Rejected by restaurant: item out of stock",
    "closed": "Rejected by restaurant: kitchen is closed",
    "busy": "Rejected by restaurant: kitchen too busy",
}


async def cmd_vendor(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    chat = update.effective_chat
    db = storage(context)
    arg = " ".join(context.args).strip() if context.args else ""
    current = db.vendor_restaurant(user.id)

    if arg.lower() in ("off", "stop", "unlink"):
        db.unregister_vendor(user.id)
        await update.message.reply_text("You will no longer receive restaurant orders.")
        return
    if not arg:
        if current:
            r = get_restaurant(current)
            await update.message.reply_text(
                f"🏪 You receive orders for *{r.name if r else current}*.\n\n/queue – active orders\n"
                "/order LL-XXXXXX – view one\n/vendor off – stop receiving orders", parse_mode="Markdown")
        else:
            await update.message.reply_text(
                "🏪 *Restaurant staff login*\n\nSend `/vendor <your restaurant code>` to start receiving orders "
                "for your kitchen here. Ask Laurence Lab support for your code.", parse_mode="Markdown")
        return
    r = find_restaurant_by_code(arg)
    if r is None:
        await update.message.reply_text("❌ That code isn't valid. Check it with Laurence Lab support.")
        return
    db.register_vendor(user.id, r.id, user.username or "", chat.id)
    await update.message.reply_text(
        f"✅ Linked! You now receive every order for *{r.name}* right here, with Accept / Reject and status buttons.\n\n"
        "Commands: /queue (active orders) · /order LL-XXXXXX · /vendor off", parse_mode="Markdown")
    await notify_admins(context, f"🏪 {md(user.full_name)} (@{user.username or '—'}, `{user.id}`) linked as staff of *{r.name}*.")


async def cb_vendor(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    parts = query.data.split(":")
    action, order_id = parts[1], parts[2]
    user = update.effective_user
    db = storage(context)
    order = db.get_order(order_id)
    if order is None:
        await query.answer("Order not found", show_alert=True)
        return
    admin = is_admin(context, user.id)
    if not admin and db.vendor_restaurant(user.id) != order.restaurant_id:
        await query.answer("This order belongs to another restaurant.", show_alert=True)
        return
    cur = currency(context)

    if action == "accept":
        if order.status == "received":
            order = db.set_status(order.id, "confirmed")
            await notify_user(context, order.chat_id, status_message(order), after_order_keyboard(order.id))
            await notify_admins(context, f"✅ *{get_restaurant(order.restaurant_id).name}* accepted order *{order.id}*.")
        await query.answer("Accepted ✅")
    elif action == "reject":
        reason = REJECT_REASONS.get(parts[3] if len(parts) > 3 else "", "Rejected by restaurant")
        if order.status in ("received", "confirmed"):
            order = db.update_order(order.id, status="cancelled", notes=reason)
            await notify_user(context, order.chat_id, status_message(order), after_order_keyboard(order.id))
            await notify_admins(context, f"❌ *{get_restaurant(order.restaurant_id).name}* rejected order *{order.id}* "
                                f"({reason.split(': ', 1)[-1]}). Payment status: {order.payment_status}.")
        await query.answer("Rejected")
    elif action == "status":
        new = parts[3]
        if new in STATUS_LABELS and new != "cancelled":
            order = db.set_status(order.id, new)
            await notify_user(context, order.chat_id, status_message(order), after_order_keyboard(order.id))
        await query.answer(f"→ {STATUS_LABELS.get(new, new)}")
    else:
        await query.answer()
    markup = admin_order_keyboard(order) if admin and not db.vendor_restaurant(user.id) else vendor_order_keyboard(order)
    await respond(update, order_summary(order, cur, for_admin=True), markup)
