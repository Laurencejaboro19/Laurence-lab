from __future__ import annotations

import logging

from telegram import LabeledPrice, Update
from telegram.ext import ContextTypes

from ..formatting import money, order_summary
from ..keyboards import (admin_order_keyboard, after_order_keyboard, payment_methods_keyboard, paystack_keyboard,
                         transfer_keyboard, vendor_order_keyboard)
from ..payments import PaystackClient, available_payment_options, bank_transfer_text, paystack_reference
from ..restaurant import get_restaurant
from .common import currency, notify_admins, notify_restaurant, notify_user, respond, settings, storage

log = logging.getLogger(__name__)


async def announce_new_order(context: ContextTypes.DEFAULT_TYPE, order) -> None:
    """Relay a confirmed order to the restaurant's staff, with the admins in copy."""
    summary = order_summary(order, currency(context), for_admin=True)
    delivered_to = await notify_restaurant(context, order, "🔔 *New order for your kitchen!*\n\n" + summary
                                           + "\n\nPlease *accept* within a few minutes.", vendor_order_keyboard(order))
    rest = get_restaurant(order.restaurant_id)
    note = "" if delivered_to else (f"\n⚠️ No staff of *{rest.name if rest else order.restaurant_id}* is linked on Telegram yet. "
                                    f"Share the vendor code with them (`/vendor <code>`) or handle this order yourself.")
    await notify_admins(context, "🔔 *New order!*" + (f" (sent to {delivered_to} restaurant staff)" if delivered_to else "")
                        + "\n\n" + summary + note, admin_order_keyboard(order))


_announce_new_order = announce_new_order


async def mark_paid_and_announce(context: ContextTypes.DEFAULT_TYPE, order_id: str, *, reference: str | None = None) -> None:
    """Used by the Paystack webhook and the manual verify button."""
    db = storage(context)
    order = db.get_order(order_id)
    if order is None:
        return
    if order.payment_status == "paid":
        return  # idempotent: webhook + manual verify may both fire
    fields = {"payment_status": "paid"}
    if reference:
        fields["payment_ref"] = reference
    order = db.update_order(order.id, **fields)
    await notify_user(context, order.chat_id, "✅ Payment confirmed! Your order is now with the kitchen.\n\n"
                      + order_summary(order, currency(context)), after_order_keyboard(order.id))
    await announce_new_order(context, order)


async def cb_pay(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()
    parts = query.data.split(":")
    action, order_id = parts[1], parts[2]
    db = storage(context)
    order = db.get_order(order_id)
    user = update.effective_user
    if order is None or order.user_id != user.id:
        await respond(update, "I couldn't find that order.", after_order_keyboard(order_id))
        return
    cur = currency(context)
    cfg = settings(context)

    if action == "choose":
        await respond(update, f"How would you like to pay for *{order.id}* ({money(order.total, cur)})?",
                      payment_methods_keyboard(available_payment_options(cfg), order.id))

    elif action == "cod":
        order = db.update_order(order.id, payment_method="cod", payment_status="pay_on_delivery")
        await respond(update, "💵 You'll pay on delivery/pickup (cash or POS).\n\n" + order_summary(order, cur),
                      after_order_keyboard(order.id))
        await _announce_new_order(context, order)

    elif action == "transfer":
        order = db.update_order(order.id, payment_method="transfer", payment_status="pending")
        await respond(update, bank_transfer_text(cfg, order.total, order.id), transfer_keyboard(order.id))

    elif action == "paid":  # customer says the bank transfer was sent
        order = db.update_order(order.id, payment_method="transfer", payment_status="awaiting_confirmation")
        await respond(update, "🙏 Thanks! We're confirming your transfer. You'll get a message once it's verified.\n\n"
                      + order_summary(order, cur), after_order_keyboard(order.id))
        await _announce_new_order(context, order)

    elif action == "paystack":
        if not cfg.paystack_enabled:
            await respond(update, "Online payment isn't available right now.", payment_methods_keyboard(available_payment_options(cfg), order.id))
            return
        attempt = int(context.user_data.get("pay_attempt", 0)) + 1
        context.user_data["pay_attempt"] = attempt
        reference = paystack_reference(order.id, attempt)
        email = f"tg{user.id}@customers.laurencelab.ng"
        try:
            url = await PaystackClient(cfg.paystack_secret_key).initialize_with_url(
                email=email, amount_naira=order.total, reference=reference,
                metadata={"order_id": order.id, "telegram_user_id": user.id},
                callback_url=f"https://t.me/{(await context.bot.get_me()).username}",
            )
        except Exception as exc:  # network / API error
            log.exception("Paystack init failed")
            await respond(update, f"⚠️ Could not start online payment ({exc}). Please choose another method.",
                          payment_methods_keyboard(available_payment_options(cfg), order.id))
            return
        db.update_order(order.id, payment_method="paystack", payment_status="pending", payment_ref=reference)
        await respond(update, f"💳 Pay *{money(order.total, cur)}* securely via Paystack, then tap "
                      "*I've completed payment*.", paystack_keyboard(url, order.id))

    elif action == "verify":
        if not order.payment_ref or not cfg.paystack_enabled:
            await respond(update, "No online payment to verify.", payment_methods_keyboard(available_payment_options(cfg), order.id))
            return
        ok = False
        try:
            ok = await PaystackClient(cfg.paystack_secret_key).verify(order.payment_ref)
        except Exception:
            log.exception("Paystack verify failed")
        if ok:
            if order.payment_status == "paid":  # webhook already handled it
                await respond(update, "✅ Payment already confirmed.\n\n" + order_summary(order, cur), after_order_keyboard(order.id))
            else:
                await mark_paid_and_announce(context, order.id)
                order = db.get_order(order.id)
                await respond(update, "✅ Payment confirmed! Your order is now with the kitchen.\n\n" + order_summary(order, cur),
                              after_order_keyboard(order.id))
        else:
            await respond(update, "⏳ We haven't seen the payment yet. If you've paid, wait a moment and tap "
                          "*I've completed payment* again.", paystack_keyboard_from_order(order))

    elif action == "telegram":
        if not cfg.telegram_payments_enabled:
            await respond(update, "In-app payment isn't available right now.", payment_methods_keyboard(available_payment_options(cfg), order.id))
            return
        db.update_order(order.id, payment_method="telegram", payment_status="pending")
        prices = [LabeledPrice(f"{l['qty']} × {l['name']}", l["price"] * l["qty"] * 100) for l in order.items]
        if order.delivery_fee:
            prices.append(LabeledPrice("Delivery", order.delivery_fee * 100))
        await context.bot.send_invoice(
            chat_id=update.effective_chat.id,
            title=f"Laurence Lab order {order.id}",
            description="Fresh food, delivered hot.",
            payload=order.id,
            provider_token=cfg.telegram_provider_token,
            currency="NGN",
            prices=prices,
            need_phone_number=False,
        )


def paystack_keyboard_from_order(order):
    # We don't store the hosted URL; re-offer the verify / choose buttons only.
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup
    return InlineKeyboardMarkup(
        [
            [InlineKeyboardButton("🔄 I've completed payment", callback_data=f"pay:verify:{order.id}")],
            [InlineKeyboardButton("🔁 Choose another method", callback_data=f"pay:choose:{order.id}")],
        ]
    )


async def precheckout(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.pre_checkout_query
    order = storage(context).get_order(query.invoice_payload)
    if order is None or order.status == "cancelled":
        await query.answer(ok=False, error_message="This order is no longer available.")
        return
    await query.answer(ok=True)


async def successful_payment(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    sp = update.message.successful_payment
    db = storage(context)
    order = db.update_order(sp.invoice_payload, payment_status="paid", payment_method="telegram",
                            payment_ref=sp.telegram_payment_charge_id)
    if order is None:
        return
    await update.message.reply_text("✅ Payment received! Your order is now with the kitchen.\n\n"
                                    + order_summary(order, currency(context)),
                                    reply_markup=after_order_keyboard(order.id), parse_mode="Markdown")
    await _announce_new_order(context, order)
