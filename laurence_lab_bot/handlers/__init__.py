"""Telegram update handlers."""

from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    MessageHandler,
    PreCheckoutQueryHandler,
    filters,
)

from . import admin, cart, checkout, info, menu, payment, start, support, text, tracking


def register(app: Application) -> None:
    # Commands
    app.add_handler(CommandHandler("start", start.cmd_start))
    app.add_handler(CommandHandler("help", start.cmd_help))
    app.add_handler(CommandHandler("myid", start.cmd_myid))
    app.add_handler(CommandHandler("menu", menu.cmd_menu))
    app.add_handler(CommandHandler("cart", cart.cmd_cart))
    app.add_handler(CommandHandler("track", tracking.cmd_track))
    app.add_handler(CommandHandler("orders", tracking.cmd_my_orders))
    app.add_handler(CommandHandler("support", support.cmd_support))
    app.add_handler(CommandHandler("about", info.cmd_about))
    app.add_handler(CommandHandler("hours", info.cmd_hours))
    app.add_handler(CommandHandler("cancel", text.cmd_cancel))

    # Admin commands
    app.add_handler(CommandHandler("admin", admin.cmd_admin))
    app.add_handler(CommandHandler("queue", admin.cmd_queue))
    app.add_handler(CommandHandler("order", admin.cmd_order))
    app.add_handler(CommandHandler("setstatus", admin.cmd_setstatus))
    app.add_handler(CommandHandler("confirmpay", admin.cmd_confirmpay))
    app.add_handler(CommandHandler("reply", admin.cmd_reply))
    app.add_handler(CommandHandler("inquiries", admin.cmd_inquiries))
    app.add_handler(CommandHandler("stats", admin.cmd_stats))

    # Inline button callbacks, by prefix
    app.add_handler(CallbackQueryHandler(start.cb_home, pattern=r"^home$"))
    app.add_handler(CallbackQueryHandler(start.cb_noop, pattern=r"^noop$"))
    app.add_handler(CallbackQueryHandler(text.cb_cancel_flow, pattern=r"^flow:cancel$"))
    app.add_handler(CallbackQueryHandler(info.cb_info, pattern=r"^info:"))
    app.add_handler(CallbackQueryHandler(info.cb_inquiry_start, pattern=r"^inquiry:start$"))
    app.add_handler(CallbackQueryHandler(menu.cb_menu, pattern=r"^menu:"))
    app.add_handler(CallbackQueryHandler(cart.cb_cart, pattern=r"^cart:"))
    app.add_handler(CallbackQueryHandler(cart.cb_nlp, pattern=r"^nlp:"))
    app.add_handler(CallbackQueryHandler(checkout.cb_checkout, pattern=r"^checkout:"))
    app.add_handler(CallbackQueryHandler(payment.cb_pay, pattern=r"^pay:"))
    app.add_handler(CallbackQueryHandler(tracking.cb_track, pattern=r"^track:"))
    app.add_handler(CallbackQueryHandler(support.cb_support_start, pattern=r"^support:start$"))
    app.add_handler(CallbackQueryHandler(admin.cb_admin, pattern=r"^admin:"))

    # Telegram native payments
    app.add_handler(PreCheckoutQueryHandler(payment.precheckout))
    app.add_handler(MessageHandler(filters.SUCCESSFUL_PAYMENT, payment.successful_payment))

    # Free-form messages (addresses, phone numbers, natural-language orders, support text)
    app.add_handler(MessageHandler(filters.LOCATION, text.on_location))
    app.add_handler(MessageHandler(filters.CONTACT, text.on_contact))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, text.on_text))
