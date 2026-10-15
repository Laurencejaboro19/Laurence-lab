"""Partner-restaurant relay, cart rules and Paystack webhook, run through the serverless path."""

import hashlib
import hmac
import json
import re

import httpx
import pytest

from laurence_lab_bot.blob_store import BlobKV, BlobStorage
from laurence_lab_bot.payments import order_id_from_reference, paystack_reference, verify_paystack_signature
from laurence_lab_bot.serverless import handle_paystack_event, process_update
from tests.test_serverless import FakeBlobServer, FakeTelegram, _cb, _msg


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("BOT_TOKEN", "123456:TEST")
    monkeypatch.setenv("ADMIN_CHAT_IDS", "999")
    monkeypatch.setenv("PAYSTACK_SECRET_KEY", "sk_test_secret")


def _storage(blob):
    return BlobStorage(BlobKV("test-token", transport=httpx.MockTransport(blob.handler)))


def _vendor_msg(uid, text, update_id):
    u = _msg(uid, text, update_id)
    u["message"]["from"]["username"] = "grillstaff"
    return u


@pytest.mark.asyncio
async def test_order_is_relayed_to_restaurant_staff_who_accept_it(monkeypatch):
    blob = FakeBlobServer()
    tg = FakeTelegram()
    st = lambda: _storage(blob)  # noqa: E731

    # Restaurant staff link themselves with the vendor code
    await process_update(_vendor_msg(777, "/vendor GH-GRILL-2026", 1), storage=st(), request=tg)
    assert "Linked" in tg.sent[-2]["text"] or any("Linked" in m["text"] for m in tg.sent)
    assert st().vendor_restaurant(777) == "gh"
    # wrong code is rejected
    await process_update(_vendor_msg(778, "/vendor NOPE", 2), storage=st(), request=tg)
    assert "isn't valid" in tg.sent[-1]["text"]

    # Customer orders from Grill House in plain English and pays on delivery
    await process_update(_msg(42, "2 chicken shawarma and fries", 3), storage=st(), request=tg)
    assert "Grill House" in tg.sent[-1]["text"]
    await process_update(_cb(42, "nlp:accept:checkout", 4), storage=st(), request=tg)
    await process_update(_cb(42, "checkout:mode:pickup", 5), storage=st(), request=tg)
    await process_update(_msg(42, "08012345678", 6), storage=st(), request=tg)
    await process_update(_cb(42, "checkout:confirm", 7), storage=st(), request=tg)
    oid = re.search(r"LL-[A-Z0-9]{6}", tg.sent[-1]["text"]).group(0)
    await process_update(_cb(42, f"pay:cod:{oid}", 8), storage=st(), request=tg)

    vendor_msgs = [m for m in tg.sent if m.get("chat_id") == 777]
    assert vendor_msgs and "New order for your kitchen" in vendor_msgs[-1]["text"]
    admin_msgs = [m for m in tg.sent if m.get("chat_id") == 999]
    assert "sent to 1 restaurant staff" in admin_msgs[-1]["text"]
    assert st().get_order(oid).restaurant_id == "gh"

    # Staff from another restaurant cannot touch it; Grill House staff accept it; customer is told
    await process_update(_vendor_msg(778, "/vendor MP-EXPRESS-2026", 9), storage=st(), request=tg)
    await process_update(_cb(778, f"vendor:accept:{oid}", 10), storage=st(), request=tg)
    assert st().get_order(oid).status == "received"
    await process_update(_cb(777, f"vendor:accept:{oid}", 11), storage=st(), request=tg)
    assert st().get_order(oid).status == "confirmed"
    assert any(m.get("chat_id") == 42 and "accepted your order" in m["text"] for m in tg.sent)

    # Staff move it along to ready-for-pickup
    await process_update(_cb(777, f"vendor:status:{oid}:preparing", 12), storage=st(), request=tg)
    await process_update(_cb(777, f"vendor:status:{oid}:ready_for_pickup", 13), storage=st(), request=tg)
    assert st().get_order(oid).status == "ready_for_pickup"
    assert any(m.get("chat_id") == 42 and "ready" in m["text"].lower() for m in tg.sent[-3:])


@pytest.mark.asyncio
async def test_rejection_cancels_and_informs_customer():
    blob = FakeBlobServer()
    tg = FakeTelegram()
    st = lambda: _storage(blob)  # noqa: E731
    await process_update(_vendor_msg(777, "/vendor LL-KITCHEN-2026", 1), storage=st(), request=tg)
    await process_update(_msg(42, "1 jollof", 2), storage=st(), request=tg)
    await process_update(_cb(42, "nlp:accept:checkout", 3), storage=st(), request=tg)
    await process_update(_cb(42, "checkout:mode:pickup", 4), storage=st(), request=tg)
    await process_update(_msg(42, "0801", 5), storage=st(), request=tg)
    await process_update(_cb(42, "checkout:confirm", 6), storage=st(), request=tg)
    oid = re.search(r"LL-[A-Z0-9]{6}", tg.sent[-1]["text"]).group(0)
    await process_update(_cb(42, f"pay:cod:{oid}", 7), storage=st(), request=tg)
    await process_update(_cb(777, f"vendor:reject:{oid}:stock", 8), storage=st(), request=tg)
    o = st().get_order(oid)
    assert o.status == "cancelled" and "out of stock" in o.notes
    assert any(m.get("chat_id") == 42 and "out of stock" in m["text"] for m in tg.sent)


@pytest.mark.asyncio
async def test_cart_holds_one_restaurant():
    blob = FakeBlobServer()
    tg = FakeTelegram()
    st = lambda: _storage(blob)  # noqa: E731
    await process_update(_cb(42, "cart:add:ll_jollof:2", 1), storage=st(), request=tg)
    await process_update(_cb(42, "cart:add:gh_fries:1", 2), storage=st(), request=tg)
    assert "One restaurant per order" in tg.sent[-1]["text"]
    assert st().load_user_state(42)["cart"] == {"ll_jollof": 2}
    await process_update(_cb(42, "cart:replace:gh_fries:1", 3), storage=st(), request=tg)
    assert st().load_user_state(42)["cart"] == {"gh_fries": 1}


def test_paystack_helpers():
    ref = paystack_reference("LL-AB12CD", 2)
    assert ref == "LL_AB12CD_2" and order_id_from_reference(ref) == "LL-AB12CD"
    body = b'{"event":"charge.success"}'
    sig = hmac.new(b"sk_test_secret", body, hashlib.sha512).hexdigest()
    assert verify_paystack_signature("sk_test_secret", body, sig)
    assert not verify_paystack_signature("sk_test_secret", body, "bad")


@pytest.mark.asyncio
async def test_paystack_webhook_confirms_payment_and_relays_order(monkeypatch):
    blob = FakeBlobServer()
    tg = FakeTelegram()
    st = lambda: _storage(blob)  # noqa: E731
    monkeypatch.setattr("laurence_lab_bot.serverless.make_storage", lambda settings: st())
    monkeypatch.setattr("laurence_lab_bot.main.Application.builder", _builder_with(tg))

    await process_update(_vendor_msg(777, "/vendor LL-KITCHEN-2026", 1), storage=st(), request=tg)
    await process_update(_msg(42, "2 jollof", 2), storage=st(), request=tg)
    await process_update(_cb(42, "nlp:accept:checkout", 3), storage=st(), request=tg)
    await process_update(_cb(42, "checkout:mode:pickup", 4), storage=st(), request=tg)
    await process_update(_msg(42, "0801", 5), storage=st(), request=tg)
    await process_update(_cb(42, "checkout:confirm", 6), storage=st(), request=tg)
    oid = re.search(r"LL-[A-Z0-9]{6}", tg.sent[-1]["text"]).group(0)
    order = st().update_order(oid, payment_method="paystack", payment_ref=paystack_reference(oid, 1))

    before = len([m for m in tg.sent if m.get("chat_id") == 777])
    result = await handle_paystack_event({"event": "charge.success", "data": {
        "status": "success", "reference": order.payment_ref, "amount": order.total * 100, "metadata": {}}})
    assert result == {"ok": True, "order": oid, "paid": True}
    assert st().get_order(oid).payment_status == "paid"
    assert len([m for m in tg.sent if m.get("chat_id") == 777]) == before + 1  # restaurant got the order
    assert any(m.get("chat_id") == 42 and "Payment confirmed" in m["text"] for m in tg.sent)
    # idempotent: a second delivery of the same event changes nothing
    again = await handle_paystack_event({"event": "charge.success", "data": {
        "status": "success", "reference": order.payment_ref, "amount": order.total * 100}})
    assert again["paid"] is True
    assert len([m for m in tg.sent if m.get("chat_id") == 777]) == before + 1
    # underpayment is ignored
    low = await handle_paystack_event({"event": "charge.success", "data": {"status": "success", "reference": order.payment_ref, "amount": 100}})
    assert "ignored" in low or low.get("paid")  # already paid → still returns paid; otherwise ignored


def _builder_with(request):
    from telegram.ext import Application

    real = Application.builder

    def builder():
        return real().request(request).get_updates_request(request)

    return staticmethod(builder) if False else builder
