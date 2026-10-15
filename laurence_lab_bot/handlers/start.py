from __future__ import annotations

from telegram import Update
from telegram.ext import ContextTypes

from ..formatting import md
from ..keyboards import main_menu
from ..restaurant import PLATFORM
from .common import cart_count, clear_flow, is_admin, respond


def welcome_text(first_name: str) -> str:
    return (
        f"Hey {md(first_name)}! Welcome to *{PLATFORM['name']}* 🍔\n\n"
        f"{PLATFORM['tagline']} Choose an option below or just tell me what you'd like to order, e.g.\n"
        "_\"2 portions of jollof, 1 chicken and a bottle water\"_"
    )


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    clear_flow(context)
    user = update.effective_user
    await respond(update, welcome_text(user.first_name if user else "there"), main_menu(cart_count(context)))


async def cb_home(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.callback_query.answer()
    clear_flow(context)
    user = update.effective_user
    await respond(update, welcome_text(user.first_name if user else "there"), main_menu(cart_count(context)))


async def cb_noop(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.callback_query.answer()


async def cmd_help(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    text = (
        "*How to use this bot*\n\n"
        "/start – main menu\n"
        "/menu – browse the menu\n"
        "/cart – view your cart\n"
        "/track – track an order\n"
        "/orders – your recent orders\n"
        "/support – talk to a human\n"
        "/about – restaurant info\n"
        "/hours – opening hours\n"
        "/cancel – cancel what you're doing\n\n"
        "You can also type your order in plain English, e.g. "
        "_\"4 portions of jollof, 1 chicken, 1 chivita, 2 plantain and bottle water\"_."
    )
    text += "\n\n*Restaurant staff:* /vendor <code> to receive your kitchen's orders here."
    if update.effective_user and is_admin(context, update.effective_user.id):
        text += "\n\n*Admin*\n/admin – admin help"
    await respond(update, text, main_menu(cart_count(context)))


async def cmd_myid(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    chat = update.effective_chat
    await update.message.reply_text(
        f"Your Telegram user ID: `{user.id}`\nThis chat ID: `{chat.id}`\n\n"
        "Add your user ID to ADMIN_CHAT_IDS in the bot's .env to receive orders and use admin commands.",
        parse_mode="Markdown",
    )
