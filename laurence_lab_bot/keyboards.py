"""Inline keyboards."""

from __future__ import annotations

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, KeyboardButton, ReplyKeyboardMarkup

from .restaurant import CATEGORIES, MENU_BY_ID, items_in_category
from .storage import ORDER_STATUSES, STATUS_LABELS, Order


def main_menu(cart_count: int = 0) -> InlineKeyboardMarkup:
    cart_label = f"🛒 My Cart ({cart_count})" if cart_count else "🛒 My Cart"
    rows = [
        [InlineKeyboardButton("ℹ️ About Us", callback_data="info:about")],
        [InlineKeyboardButton("🍽️ Browse Menu", callback_data="menu:root")],
        [InlineKeyboardButton("📦 Track Order", callback_data="track:prompt")],
        [InlineKeyboardButton("💬 Speak to Support", callback_data="support:start")],
        [InlineKeyboardButton(cart_label, callback_data="cart:view"),
         InlineKeyboardButton("🤝 Business Inquiries", callback_data="inquiry:start")],
    ]
    return InlineKeyboardMarkup(rows)


def home_button() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[InlineKeyboardButton("🏠 Main menu", callback_data="home")]])


def info_menu() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [
            [InlineKeyboardButton("🕒 Opening hours", callback_data="info:hours"),
             InlineKeyboardButton("📍 Location", callback_data="info:location")],
            [InlineKeyboardButton("❓ FAQ", callback_data="info:faq"),
             InlineKeyboardButton("🤝 Business Inquiries", callback_data="inquiry:start")],
            [InlineKeyboardButton("🍽️ Browse Menu", callback_data="menu:root"),
             InlineKeyboardButton("🏠 Main menu", callback_data="home")],
        ]
    )


def categories_menu(cart_count: int = 0) -> InlineKeyboardMarkup:
    rows = [[InlineKeyboardButton(label, callback_data=f"menu:cat:{cid}")] for cid, label in CATEGORIES]
    rows.append(
        [InlineKeyboardButton(f"🛒 Cart ({cart_count})", callback_data="cart:view"),
         InlineKeyboardButton("🏠 Main menu", callback_data="home")]
    )
    return InlineKeyboardMarkup(rows)


def category_items(category_id: str, currency: str) -> InlineKeyboardMarkup:
    rows = [
        [InlineKeyboardButton(f"{it.emoji} {it.name} — {currency}{it.price:,}", callback_data=f"menu:item:{it.id}")]
        for it in items_in_category(category_id)
    ]
    rows.append(
        [InlineKeyboardButton("⬅️ Categories", callback_data="menu:root"),
         InlineKeyboardButton("🛒 Cart", callback_data="cart:view")]
    )
    return InlineKeyboardMarkup(rows)


def item_actions(item_id: str, qty: int = 1) -> InlineKeyboardMarkup:
    item = MENU_BY_ID[item_id]
    return InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton("➖", callback_data=f"menu:qty:{item_id}:{max(1, qty - 1)}"),
                InlineKeyboardButton(f"{qty}", callback_data="noop"),
                InlineKeyboardButton("➕", callback_data=f"menu:qty:{item_id}:{min(50, qty + 1)}"),
            ],
            [InlineKeyboardButton(f"🛒 Add {qty} to cart", callback_data=f"cart:add:{item_id}:{qty}")],
            [InlineKeyboardButton(f"⬅️ Back", callback_data=f"menu:cat:{item.category}"),
             InlineKeyboardButton("🛒 View cart", callback_data="cart:view")],
        ]
    )


def cart_actions(cart: dict[str, int]) -> InlineKeyboardMarkup:
    rows = []
    for item_id, qty in cart.items():
        item = MENU_BY_ID.get(item_id)
        if not item:
            continue
        rows.append(
            [
                InlineKeyboardButton(f"➖ {item.name}", callback_data=f"cart:dec:{item_id}"),
                InlineKeyboardButton(f"➕", callback_data=f"cart:inc:{item_id}"),
                InlineKeyboardButton("🗑", callback_data=f"cart:remove:{item_id}"),
            ]
        )
    if cart:
        rows.append([InlineKeyboardButton("✅ Checkout", callback_data="checkout:start")])
        rows.append(
            [InlineKeyboardButton("➕ Add more", callback_data="menu:root"),
             InlineKeyboardButton("🧹 Clear cart", callback_data="cart:clear")]
        )
    else:
        rows.append([InlineKeyboardButton("🍽️ Browse Menu", callback_data="menu:root")])
    rows.append([InlineKeyboardButton("🏠 Main menu", callback_data="home")])
    return InlineKeyboardMarkup(rows)


def parsed_order_actions() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [
            [InlineKeyboardButton("✅ Add to cart & checkout", callback_data="nlp:accept:checkout")],
            [InlineKeyboardButton("🛒 Add to cart only", callback_data="nlp:accept:cart"),
             InlineKeyboardButton("❌ Discard", callback_data="nlp:discard")],
        ]
    )


def fulfilment_menu() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [
            [InlineKeyboardButton("🛵 Deliver to me", callback_data="checkout:mode:delivery")],
            [InlineKeyboardButton("🛍️ I'll pick up", callback_data="checkout:mode:pickup")],
            [InlineKeyboardButton("⬅️ Back to cart", callback_data="cart:view")],
        ]
    )


def location_request_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        [[KeyboardButton("📍 Share my location", request_location=True)]],
        resize_keyboard=True,
        one_time_keyboard=True,
        input_field_placeholder="…or type your delivery address",
    )


def contact_request_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        [[KeyboardButton("📱 Share my phone number", request_contact=True)]],
        resize_keyboard=True,
        one_time_keyboard=True,
        input_field_placeholder="…or type your phone number",
    )


def confirm_order_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [
            [InlineKeyboardButton("✅ Confirm & choose payment", callback_data="checkout:confirm")],
            [InlineKeyboardButton("📝 Add a note", callback_data="checkout:note"),
             InlineKeyboardButton("✏️ Change address", callback_data="checkout:start")],
            [InlineKeyboardButton("⬅️ Back to cart", callback_data="cart:view")],
        ]
    )


def payment_methods_keyboard(options, order_id: str) -> InlineKeyboardMarkup:
    rows = [[InlineKeyboardButton(o.label, callback_data=f"pay:{o.key}:{order_id}")] for o in options]
    return InlineKeyboardMarkup(rows)


def transfer_keyboard(order_id: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [
            [InlineKeyboardButton("✅ I have paid", callback_data=f"pay:paid:{order_id}")],
            [InlineKeyboardButton("🔁 Choose another method", callback_data=f"pay:choose:{order_id}")],
        ]
    )


def paystack_keyboard(url: str, order_id: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [
            [InlineKeyboardButton("💳 Open secure payment page", url=url)],
            [InlineKeyboardButton("🔄 I've completed payment", callback_data=f"pay:verify:{order_id}")],
            [InlineKeyboardButton("🔁 Choose another method", callback_data=f"pay:choose:{order_id}")],
        ]
    )


def after_order_keyboard(order_id: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [
            [InlineKeyboardButton("📦 Track this order", callback_data=f"track:{order_id}")],
            [InlineKeyboardButton("🏠 Main menu", callback_data="home")],
        ]
    )


def track_keyboard(order: Order | None) -> InlineKeyboardMarkup:
    rows = []
    if order:
        rows.append([InlineKeyboardButton("🔄 Refresh", callback_data=f"track:{order.id}")])
        if order.status in ("received", "confirmed") and order.payment_status != "paid":
            rows.append([InlineKeyboardButton("❌ Cancel order", callback_data=f"track:cancel:{order.id}")])
    rows.append([InlineKeyboardButton("📋 My recent orders", callback_data="track:list")])
    rows.append([InlineKeyboardButton("🏠 Main menu", callback_data="home")])
    return InlineKeyboardMarkup(rows)


def recent_orders_keyboard(orders: list[Order]) -> InlineKeyboardMarkup:
    rows = [
        [InlineKeyboardButton(f"{o.id} · {STATUS_LABELS.get(o.status, o.status)}", callback_data=f"track:{o.id}")]
        for o in orders
    ]
    rows.append([InlineKeyboardButton("🏠 Main menu", callback_data="home")])
    return InlineKeyboardMarkup(rows)


def admin_order_keyboard(order: Order) -> InlineKeyboardMarkup:
    next_statuses = {
        "received": ["confirmed", "cancelled"],
        "confirmed": ["preparing", "cancelled"],
        "preparing": ["out_for_delivery" if order.fulfilment == "delivery" else "ready_for_pickup", "cancelled"],
        "out_for_delivery": ["delivered"],
        "ready_for_pickup": ["delivered"],
    }.get(order.status, [])
    rows = [
        [InlineKeyboardButton(STATUS_LABELS[s], callback_data=f"admin:status:{order.id}:{s}") for s in next_statuses]
    ] if next_statuses else []
    if order.payment_status in ("pending", "awaiting_confirmation"):
        rows.append([InlineKeyboardButton("💰 Mark as paid", callback_data=f"admin:paid:{order.id}")])
    rows.append([InlineKeyboardButton("🔄 Refresh", callback_data=f"admin:view:{order.id}")])
    return InlineKeyboardMarkup(rows)


def cancel_flow_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[InlineKeyboardButton("❌ Cancel", callback_data="flow:cancel")]])
