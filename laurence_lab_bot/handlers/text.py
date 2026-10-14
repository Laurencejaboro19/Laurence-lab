"""Dispatches free-form messages (text, location, contact) based on the user's current flow."""

from __future__ import annotations

from telegram import ReplyKeyboardRemove, Update
from telegram.ext import ContextTypes

from ..formatting import md, money
from ..keyboards import cancel_flow_keyboard, home_button, main_menu, parsed_order_actions
from ..nlp import looks_like_order, parse_order
from . import checkout, support, tracking
from .common import cart_count, clear_flow, currency, flow, flow_data, notify_admins, respond, storage


async def cmd_cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    clear_flow(context)
    context.user_data.pop("pending_order", None)
    await update.message.reply_text("Cancelled.", reply_markup=ReplyKeyboardRemove())
    await respond(update, "What would you like to do next?", main_menu(cart_count(context)))


async def cb_cancel_flow(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.callback_query.answer()
    clear_flow(context)
    await respond(update, "Cancelled. What would you like to do next?", main_menu(cart_count(context)))


async def on_location(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    loc = update.message.location
    if flow(context) == "checkout_address":
        await checkout.handle_address(update, context, lat=loc.latitude, lon=loc.longitude)
    else:
        await update.message.reply_text(
            "Thanks for the location! Start a checkout and I'll use it for delivery.", reply_markup=main_menu(cart_count(context))
        )


async def on_contact(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    contact = update.message.contact
    if flow(context) == "checkout_phone":
        await checkout.handle_phone(update, context, contact.phone_number)
    else:
        storage(context).remember_customer(update.effective_user.id, phone=contact.phone_number)
        await update.message.reply_text("Saved your number ✅", reply_markup=ReplyKeyboardRemove())


async def on_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    text = (update.message.text or "").strip()
    current = flow(context)

    # ---- checkout steps
    if current == "checkout_address":
        await checkout.handle_address(update, context, address=text)
        return
    if current == "checkout_phone":
        await checkout.handle_phone(update, context, text)
        return
    if current == "checkout_note":
        await checkout.handle_note(update, context, text)
        return

    # ---- order tracking
    if current == "track_id":
        oid = tracking.extract_order_id(text)
        if oid:
            await tracking.show_order(update, context, oid)
        else:
            await update.message.reply_text("That doesn't look like an order ID (format: LL-AB12CD). Try again or tap Cancel.",
                                            reply_markup=cancel_flow_keyboard())
        return

    # ---- support
    if current == "support_message":
        await support.handle_support_message(update, context, text)
        return

    # ---- business inquiry form
    if current and current.startswith("inquiry_"):
        await _inquiry_step(update, context, current, text)
        return

    # ---- no active flow: maybe the message is an order ID or a plain-text order
    oid = tracking.extract_order_id(text)
    if oid:
        await tracking.show_order(update, context, oid)
        return
    if looks_like_order(text):
        parsed = parse_order(text)
        if not parsed.is_empty:
            cur = currency(context)
            context.user_data["pending_order"] = {item.id: qty for item, qty in parsed.lines}
            lines = "\n".join(f"{item.emoji} {qty} × {item.name} — {money(item.price * qty, cur)}" for item, qty in parsed.lines)
            subtotal = sum(item.price * qty for item, qty in parsed.lines)
            reply = f"Here's what I understood:\n\n{lines}\n\n*Subtotal: {money(subtotal, cur)}*"
            if parsed.unmatched:
                reply += "\n\n🤔 I couldn't match: _" + md(", ".join(parsed.unmatched)) + "_. You can add those from the menu."
            await update.message.reply_text(reply, reply_markup=parsed_order_actions(), parse_mode="Markdown")
            return
    await update.message.reply_text(
        "I'm not sure what you mean 🤔 Use the buttons below, or type an order like "
        "_\"2 jollof and 1 chicken\"_.",
        reply_markup=main_menu(cart_count(context)),
        parse_mode="Markdown",
    )


async def _inquiry_step(update: Update, context: ContextTypes.DEFAULT_TYPE, step: str, text: str) -> None:
    data = flow_data(context)
    if step == "inquiry_name":
        data["name"] = text[:100]
        context.user_data["flow"] = "inquiry_company"
        await update.message.reply_text("Which *company or organisation* are you with? (type _none_ if personal)",
                                        reply_markup=cancel_flow_keyboard(), parse_mode="Markdown")
    elif step == "inquiry_company":
        data["company"] = "" if text.lower() in ("none", "n/a", "-") else text[:100]
        context.user_data["flow"] = "inquiry_contact"
        await update.message.reply_text("Best *phone number or email* to reach you?",
                                        reply_markup=cancel_flow_keyboard(), parse_mode="Markdown")
    elif step == "inquiry_contact":
        data["contact"] = text[:100]
        context.user_data["flow"] = "inquiry_message"
        await update.message.reply_text("Tell us about your inquiry — event date, number of guests, budget, anything useful:",
                                        reply_markup=cancel_flow_keyboard())
    elif step == "inquiry_message":
        user = update.effective_user
        chat = update.effective_chat
        inquiry_id = storage(context).create_inquiry(
            user.id, chat.id, data.get("name", ""), data.get("company", ""), data.get("contact", ""), text[:2000]
        )
        clear_flow(context)
        await notify_admins(
            context,
            f"🤝 *New business inquiry #{inquiry_id}*\n"
            f"Name: {md(data.get('name'))}\nCompany: {md(data.get('company')) or '—'}\n"
            f"Contact: {md(data.get('contact'))}\nTelegram user: `{user.id}`\n\n{md(text[:2000])}\n\n"
            f"Reply with: `/reply {user.id} your message`",
        )
        await update.message.reply_text(
            f"🙏 Thank you! Your inquiry (#{inquiry_id}) has been received. Our team will contact you within 24 hours.",
            reply_markup=home_button(),
        )
