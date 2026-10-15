"""Smoke test: the application builds and all handlers register without a live token."""

import os

import pytest


@pytest.fixture(autouse=True)
def _env(monkeypatch, tmp_path):
    monkeypatch.setenv("BOT_TOKEN", "123456:TEST")
    monkeypatch.setenv("ADMIN_CHAT_IDS", "1, 2")
    monkeypatch.setenv("DB_PATH", str(tmp_path / "app.db"))
    monkeypatch.chdir(tmp_path)


def test_application_builds():
    from laurence_lab_bot.main import build_application

    app = build_application()
    assert app.bot_data["settings"].admin_chat_ids == (1, 2)
    handlers = [h for group in app.handlers.values() for h in group]
    assert len(handlers) > 25


def test_formatting_roundtrip():
    from laurence_lab_bot.formatting import md, money, order_summary, tracking_timeline
    from laurence_lab_bot.storage import Storage

    db = Storage(os.environ["DB_PATH"])
    o = db.create_order(
        user_id=1, chat_id=1, customer_name="A_b*c", phone="0800",
        items=[{"id": "jollof", "name": "Jollof Rice", "price": 1500, "qty": 1}],
        subtotal=1500, delivery_fee=0, total=1500, fulfilment="pickup", address="", payment_method="cod",
        payment_status="pay_on_delivery", status="preparing", eta_minutes=25,
    )
    text = order_summary(o, "₦", for_admin=True)
    assert "A\\_b\\*c" in text and money(1500) in text
    tl = tracking_timeline(o)
    assert "← now" in tl and "Ready for pickup" in tl
    assert md(None) == ""


def test_admin_by_username_registers_and_notifies(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from telegram import Chat, Message, Update, User
    from datetime import datetime

    monkeypatch.setenv("ADMIN_USERNAMES", "@Dayankolev247, other")
    from laurence_lab_bot.config import load_settings
    from laurence_lab_bot.handlers.common import all_admin_ids, is_admin, register_admin_by_username
    from laurence_lab_bot.storage import Storage

    settings = load_settings()
    assert settings.admin_usernames == ("dayankolev247", "other")
    ctx = SimpleNamespace(bot=AsyncMock(), bot_data={"settings": settings, "storage": Storage(os.environ["DB_PATH"])}, user_data={})
    user = User(555, "Laurence", False, username="Dayankolev247")
    msg = Message(1, datetime.now(), Chat(555, "private"), from_user=user, text="/start")
    assert not is_admin(ctx, 555)
    asyncio.run(register_admin_by_username(Update(1, message=msg), ctx))
    assert is_admin(ctx, 555) and all_admin_ids(ctx) == {1, 2, 555}
    # a normal customer never becomes admin
    msg2 = Message(2, datetime.now(), Chat(7, "private"), from_user=User(7, "Ada", False, username="ada"), text="hi")
    asyncio.run(register_admin_by_username(Update(2, message=msg2), ctx))
    assert not is_admin(ctx, 7)
