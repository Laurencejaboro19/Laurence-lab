"""Text builders shared by the handlers."""

from __future__ import annotations

import re
from datetime import datetime

from .restaurant import PLATFORM, RESTAURANT, RESTAURANTS, get_restaurant
from .storage import STATUS_LABELS, Order


def money(amount: int | float, currency: str = "₦") -> str:
    return f"{currency}{int(round(amount)):,}"


def md(text: str | None) -> str:
    """Escape user-supplied text for Telegram's legacy Markdown parse mode."""
    if not text:
        return ""
    return re.sub(r"([_*`\[])", r"\\\1", str(text))


def cart_lines(cart: dict[str, int], currency: str) -> tuple[str, int]:
    """Return (text, subtotal) for a cart of {item_id: qty}."""
    from .restaurant import MENU_BY_ID

    lines = []
    subtotal = 0
    for item_id, qty in cart.items():
        item = MENU_BY_ID.get(item_id)
        if not item or qty <= 0:
            continue
        line_total = item.price * qty
        subtotal += line_total
        lines.append(f"{item.emoji} {qty} × {item.name} — {money(line_total, currency)}")
    return "\n".join(lines), subtotal


def order_items_text(order: Order, currency: str) -> str:
    return "\n".join(
        f"• {line['qty']} × {line['name']} — {money(line['price'] * line['qty'], currency)}" for line in order.items
    )


def order_summary(order: Order, currency: str, *, for_admin: bool = False) -> str:
    fulfil = "🛵 Delivery" if order.fulfilment == "delivery" else "🛍️ Pickup"
    pay_status = {
        "pending": "⏳ Pending",
        "awaiting_confirmation": "🕵️ Awaiting confirmation",
        "paid": "✅ Paid",
        "pay_on_delivery": "💵 Pay on delivery",
        "failed": "❌ Failed",
    }.get(order.payment_status, order.payment_status)
    pay_method = {
        "paystack": "Online (Paystack)",
        "telegram": "Telegram payment",
        "transfer": "Bank transfer",
        "cod": "Pay on delivery",
    }.get(order.payment_method, order.payment_method or "—")
    rest = get_restaurant(order.restaurant_id)
    parts = [
        f"🧾 *Order {order.id}*",
        f"🏪 {rest.emoji} {rest.name}" if rest else "",
        "",
        order_items_text(order, currency),
        "",
        f"Subtotal: {money(order.subtotal, currency)}",
        f"Delivery: {money(order.delivery_fee, currency) if order.delivery_fee else 'Free' if order.fulfilment == 'delivery' else '—'}",
        f"*Total: {money(order.total, currency)}*",
        "",
        f"{fulfil}" + (f" — {md(order.address)}" if order.address else ""),
        f"Payment: {pay_method} · {pay_status}",
        f"Status: {STATUS_LABELS.get(order.status, order.status)}",
    ]
    if order.eta_minutes and order.status not in ("delivered", "cancelled"):
        parts.append(f"ETA: ~{order.eta_minutes} min")
    if order.notes:
        parts.append(f"Notes: {md(order.notes)}")
    if for_admin:
        parts.insert(1, f"Customer: {md(order.customer_name) or '—'} · {md(order.phone) or '—'} · user `{order.user_id}`")
        parts.append(f"Placed: {_fmt_time(order.created_at)}")
    return "\n".join(parts)


def tracking_timeline(order: Order) -> str:
    if order.status == "cancelled":
        return "❌ This order was cancelled."
    steps = ["received", "confirmed", "preparing"]
    steps.append("out_for_delivery" if order.fulfilment == "delivery" else "ready_for_pickup")
    steps.append("delivered")
    try:
        current = steps.index(order.status)
    except ValueError:
        current = 0
    lines = []
    for i, step in enumerate(steps):
        label = STATUS_LABELS[step].split(" ", 1)[1]
        if i < current:
            lines.append(f"✅ {label}")
        elif i == current:
            lines.append(f"🔵 *{label}* ← now")
        else:
            lines.append(f"⚪ {label}")
    return "\n".join(lines)


def _fmt_time(iso: str) -> str:
    try:
        return datetime.fromisoformat(iso).strftime("%d %b %Y, %H:%M UTC")
    except ValueError:
        return iso


def about_text() -> str:
    p = PLATFORM
    rests = "\n".join(f"{r.emoji} *{r.name}* — {r.cuisine} ({'open now' if r.is_open_now() else 'closed now'})"
                      for r in RESTAURANTS)
    return (
        f"🍽️ *{p['name']}*\n_{p['tagline']}_\n\n{p['description']}\n\n*Partner restaurants:*\n{rests}\n\n"
        f"📞 Support: {p['support_phone']}\n✉️ {p['support_email']}\n🌐 {p['website']}\n📸 {p['instagram']}"
    )


def hours_text() -> str:
    lines = ["🕒 *Opening hours*", ""]
    for r in RESTAURANTS:
        lines.append(f"{r.emoji} *{r.name}* — {'🟢 open now' if r.is_open_now() else '🔴 closed now'}")
        lines.append(r.hours_text())
        lines.append("")
    return "\n".join(lines).strip()


def restaurant_text(restaurant_id: str) -> str:
    r = get_restaurant(restaurant_id)
    if not r:
        return "Restaurant not found."
    return (
        f"{r.emoji} *{r.name}*\n_{r.tagline}_\n{r.cuisine}\n\n"
        f"{'🟢 Open now' if r.is_open_now() else '🔴 Closed now (you can still pre-order)'}\n\n"
        f"📍 {r.address}\n📞 {r.phone}\n\n{r.hours_text()}"
    )


def faq_text() -> str:
    lines = ["❓ *Frequently asked questions*", ""]
    for q, a in PLATFORM["faq"]:
        lines.append(f"*{q}*\n{a}\n")
    return "\n".join(lines).strip()
