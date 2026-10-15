from __future__ import annotations

from telegram import ReplyKeyboardRemove, Update
from telegram.ext import ContextTypes

from ..delivery import DeliveryQuote, quote_by_address, quote_by_coordinates, quote_pickup
from ..formatting import cart_lines, md, money
from ..keyboards import (
    cancel_flow_keyboard,
    confirm_order_keyboard,
    contact_request_keyboard,
    fulfilment_menu,
    location_request_keyboard,
    payment_methods_keyboard,
)
from ..payments import available_payment_options
from ..restaurant import DELIVERY, MENU_BY_ID, get_restaurant
from .common import cart, cart_restaurant_id, clear_flow, currency, flow_data, respond, set_flow, settings, storage


def _checkout(context: ContextTypes.DEFAULT_TYPE) -> dict:
    return context.user_data.setdefault("checkout", {})


async def start_checkout(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not cart(context):
        await respond(update, "🛒 Your cart is empty. Add something from the menu first.", fulfilment_menu())
        return
    context.user_data["checkout"] = {"restaurant_id": cart_restaurant_id(context)}
    clear_flow(context)
    lines, subtotal = cart_lines(cart(context), currency(context))
    r = get_restaurant(cart_restaurant_id(context))
    closed = "" if (r and r.is_open_now()) else f"\n⚠️ {r.name if r else 'The restaurant'} is closed right now; this will be a pre-order.\n"
    await respond(
        update,
        f"🧾 *Checkout* — {r.emoji + ' ' + r.name if r else ''}\n\n{lines}\n\nSubtotal: *{money(subtotal, currency(context))}*\n{closed}\n"
        "How would you like to get your order?",
        fulfilment_menu(),
    )


async def cb_checkout(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()
    parts = query.data.split(":")
    action = parts[1]

    if action == "start":
        await start_checkout(update, context)
    elif action == "mode":
        mode = parts[2]
        _checkout(context)["fulfilment"] = mode
        if mode == "delivery":
            set_flow(context, "checkout_address")
            await respond(
                update,
                "📍 *Delivery address*\n\nShare your location with the button below (most accurate), "
                "or type your address — e.g. _14 Fola Osibo St, Lekki Phase 1_.\n\n"
                f"We deliver within {DELIVERY['max_km']:.0f} km. "
                f"Delivery is free on orders from {money(DELIVERY['free_delivery_from'], currency(context))}.",
            )
            await update.effective_chat.send_message("Tap below or type your address 👇", reply_markup=location_request_keyboard())
        else:
            _checkout(context)["quote"] = quote_pickup().__dict__
            _checkout(context)["address"] = ""
            await ask_phone(update, context)
    elif action == "note":
        set_flow(context, "checkout_note")
        await respond(update, "📝 Type a note for the kitchen or rider (e.g. _no pepper_, _call on arrival_):",
                      cancel_flow_keyboard())
    elif action == "confirm":
        await place_order(update, context)


# ------------------------------------------------------------------- steps
async def handle_address(update: Update, context: ContextTypes.DEFAULT_TYPE, *, address: str | None = None,
                         lat: float | None = None, lon: float | None = None) -> None:
    _, subtotal = cart_lines(cart(context), currency(context))
    rid = cart_restaurant_id(context)
    if lat is not None and lon is not None:
        quote = quote_by_coordinates(lat, lon, subtotal, rid)
        address_text = address or f"Shared location ({lat:.5f}, {lon:.5f})"
    else:
        quote = quote_by_address(address or "", subtotal, rid)
        address_text = address or ""
    if not quote.deliverable:
        await update.message.reply_text(
            f"😔 {quote.reason}\n\nYou can type a different address, or tap below to pick up instead.",
            reply_markup=fulfilment_menu(),
        )
        return
    co = _checkout(context)
    co.update({"address": address_text, "lat": lat, "lon": lon, "quote": quote.__dict__})
    await update.message.reply_text("Got it ✅", reply_markup=ReplyKeyboardRemove())
    await ask_phone(update, context)


async def ask_phone(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    customer = storage(context).get_customer(user.id) if user else None
    if customer and customer.get("phone"):
        _checkout(context)["phone"] = customer["phone"]
        _checkout(context)["name"] = customer.get("name") or (user.full_name if user else "")
        await review_order(update, context)
        return
    set_flow(context, "checkout_phone")
    await update.effective_chat.send_message(
        "📱 What phone number should the rider call? Share it with the button or type it.",
        reply_markup=contact_request_keyboard(),
    )


async def handle_phone(update: Update, context: ContextTypes.DEFAULT_TYPE, phone: str) -> None:
    phone = phone.strip()
    digits = "".join(ch for ch in phone if ch.isdigit())
    if len(digits) < 7:
        await update.message.reply_text("That doesn't look like a phone number. Please try again.")
        return
    co = _checkout(context)
    co["phone"] = phone
    user = update.effective_user
    co.setdefault("name", user.full_name if user else "")
    storage(context).remember_customer(user.id, name=co["name"], phone=phone, last_address=co.get("address"))
    await update.message.reply_text("Thanks ✅", reply_markup=ReplyKeyboardRemove())
    await review_order(update, context)


async def handle_note(update: Update, context: ContextTypes.DEFAULT_TYPE, note: str) -> None:
    _checkout(context)["note"] = note.strip()[:300]
    await review_order(update, context)


async def review_order(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    clear_flow(context)
    co = _checkout(context)
    cur = currency(context)
    lines, subtotal = cart_lines(cart(context), cur)
    quote = DeliveryQuote(**co.get("quote", quote_pickup().__dict__))
    total = subtotal + quote.fee
    if co.get("fulfilment") == "delivery":
        fee_text = money(quote.fee, cur) if quote.fee else "FREE 🎉"
        where = f"🛵 Delivery to: {md(co.get('address', ''))}"
        if quote.distance_km is not None:
            where += f" (~{quote.distance_km:.1f} km)"
        elif quote.zone:
            where += f" ({quote.zone.title()} zone)"
    else:
        fee_text = "—"
        where = "🛍️ Pickup at the restaurant"
    text = (
        f"📋 *Review your order*\n\n{lines}\n\n"
        f"Subtotal: {money(subtotal, cur)}\nDelivery: {fee_text}\n*Total: {money(total, cur)}*\n\n"
        f"{where}\n📱 {md(co.get('phone', ''))}\n⏱ Estimated time: ~{quote.eta_minutes} min"
    )
    if co.get("note"):
        text += f"\n📝 Note: {md(co['note'])}"
    await respond(update, text, confirm_order_keyboard(), edit=update.callback_query is not None)


async def place_order(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    co = _checkout(context)
    items = cart(context)
    user = update.effective_user
    chat = update.effective_chat
    if not items or not co.get("fulfilment"):
        await respond(update, "Your cart is empty or checkout expired. Let's start again.", fulfilment_menu())
        return
    cur = currency(context)
    quote = DeliveryQuote(**co.get("quote", quote_pickup().__dict__))
    order_items = [
        {"id": iid, "name": MENU_BY_ID[iid].name, "price": MENU_BY_ID[iid].price, "qty": qty}
        for iid, qty in items.items() if iid in MENU_BY_ID
    ]
    subtotal = sum(line["price"] * line["qty"] for line in order_items)
    order = storage(context).create_order(
        restaurant_id=co.get("restaurant_id") or cart_restaurant_id(context) or "ll",
        user_id=user.id,
        chat_id=chat.id,
        customer_name=co.get("name") or user.full_name,
        phone=co.get("phone", ""),
        items=order_items,
        subtotal=subtotal,
        delivery_fee=quote.fee,
        total=subtotal + quote.fee,
        fulfilment=co["fulfilment"],
        address=co.get("address", ""),
        latitude=co.get("lat"),
        longitude=co.get("lon"),
        payment_method="",
        eta_minutes=quote.eta_minutes,
        notes=co.get("note", ""),
    )
    items.clear()
    context.user_data.pop("cart_restaurant", None)
    context.user_data.pop("checkout", None)
    context.user_data["last_order_id"] = order.id
    options = available_payment_options(settings(context))
    await respond(
        update,
        f"🎉 Order *{order.id}* created!\nTotal to pay: *{money(order.total, cur)}*\n\nHow would you like to pay?",
        payment_methods_keyboard(options, order.id),
    )
