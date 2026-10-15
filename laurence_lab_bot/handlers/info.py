from __future__ import annotations

from telegram import Update
from telegram.ext import ContextTypes

from ..formatting import about_text, faq_text, hours_text
from ..keyboards import cancel_flow_keyboard, info_menu
from ..restaurant import RESTAURANTS
from .common import respond, set_flow


async def cmd_about(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await respond(update, about_text(), info_menu())


async def cmd_hours(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await respond(update, hours_text(), info_menu())


async def cb_info(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()
    action = query.data.split(":", 1)[1]
    if action == "about":
        await respond(update, about_text(), info_menu())
    elif action == "hours":
        await respond(update, hours_text(), info_menu())
    elif action == "faq":
        await respond(update, faq_text(), info_menu())
    elif action == "location":
        text = "📍 *Our restaurants*\n\n" + "\n".join(f"{r.emoji} *{r.name}*\n{r.address}\n" for r in RESTAURANTS)
        await respond(update, text, info_menu())
    else:
        await respond(update, about_text(), info_menu())


async def cb_inquiry_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.callback_query.answer()
    set_flow(context, "inquiry_name")
    await respond(
        update,
        "🤝 *Business inquiries*\n\n"
        "Catering, bulk orders, corporate lunches, partnerships, supplier offers — we'd love to hear from you.\n\n"
        "First, what's your *name*?",
        cancel_flow_keyboard(),
    )
