from __future__ import annotations

from telegram import Update
from telegram.ext import ContextTypes

from ..formatting import md
from ..keyboards import cancel_flow_keyboard, home_button
from ..restaurant import RESTAURANT
from .common import all_admin_ids, clear_flow, notify_admins, respond, set_flow, storage


async def cmd_support(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await start_support(update, context)


async def cb_support_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.callback_query.answer()
    await start_support(update, context)


async def start_support(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    set_flow(context, "support_message")
    await respond(
        update,
        "💬 *Speak to support*\n\nType your message and a member of our team will reply here in Telegram. "
        f"You can also call {RESTAURANT['phone']}.",
        cancel_flow_keyboard(),
    )


async def handle_support_message(update: Update, context: ContextTypes.DEFAULT_TYPE, text: str) -> None:
    user = update.effective_user
    chat = update.effective_chat
    db = storage(context)
    ticket_id = db.create_ticket(user.id, chat.id, user.username or "", text)
    clear_flow(context)
    if all_admin_ids(context):
        handle = f"@{user.username}" if user.username else "no username"
        await notify_admins(
            context,
            f"💬 *Support ticket #{ticket_id}*\nFrom: {md(user.full_name)} ({handle}) · user `{user.id}`\n\n"
            f"{md(text)}\n\nReply with: `/reply {user.id} your message`",
        )
        await update.message.reply_text(
            f"✅ Message sent (ticket #{ticket_id}). We'll reply here shortly.", reply_markup=home_button()
        )
    else:
        await update.message.reply_text(
            f"✅ Message saved (ticket #{ticket_id}). Our team will get back to you. "
            f"For urgent issues call {RESTAURANT['phone']}.", reply_markup=home_button()
        )
