"""Offline end-to-end test of the Vercel path: fake Blob API + fake Telegram API."""

import json
import re
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from telegram.request import BaseRequest

from laurence_lab_bot.blob_store import BlobKV, BlobStorage
from laurence_lab_bot.serverless import extract_user_id, process_update, webhook_secret


class FakeBlobServer:
    """In-memory stand-in for blob.vercel-storage.com."""

    def __init__(self):
        self.blobs: dict[str, bytes] = {}
        self.calls: list[str] = []

    def url_for(self, pathname):
        return f"https://fake.public.blob.vercel-storage.com/{pathname}"

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(f"{request.method} {request.url.path}")
        assert request.headers.get("authorization") == "Bearer test-token"
        if request.url.host == "fake.public.blob.vercel-storage.com":
            path = request.url.path.lstrip("/")
            if path in self.blobs:
                return httpx.Response(200, content=self.blobs[path])
            return httpx.Response(404)
        if request.method == "GET" and request.url.path == "/":
            q = parse_qs(request.url.query.decode())
            prefix = q.get("prefix", [""])[0]
            blobs = [
                {"url": self.url_for(p), "pathname": p, "size": len(b), "uploadedAt": "2026-01-01T00:00:00Z"}
                for p, b in self.blobs.items() if p.startswith(prefix)
            ]
            return httpx.Response(200, json={"blobs": blobs, "hasMore": False, "cursor": None})
        if request.method == "PUT":
            path = request.url.path.lstrip("/")
            self.blobs[path] = request.content
            return httpx.Response(200, json={"url": self.url_for(path), "pathname": path})
        if request.method == "POST" and request.url.path == "/delete":
            for url in json.loads(request.content)["urls"]:
                self.blobs.pop(urlparse(url).path.lstrip("/"), None)
            return httpx.Response(200, json={})
        return httpx.Response(400)


@pytest.fixture
def blob():
    return FakeBlobServer()


@pytest.fixture
def kv(blob):
    return BlobKV("test-token", transport=httpx.MockTransport(blob.handler))


def test_kv_roundtrip_and_version_cleanup(blob, kv):
    assert kv.get("missing") is None
    kv.set("a", {"x": 1})
    kv.set("a", {"x": 2})
    assert len([p for p in blob.blobs if p.startswith("kv/a/")]) == 1  # old version deleted
    fresh = BlobKV("test-token", transport=httpx.MockTransport(blob.handler))
    assert fresh.get("a") == {"x": 2}
    fresh.delete("a")
    assert fresh.get("a") is None


def test_blob_storage_matches_sqlite_behaviour(kv):
    db = BlobStorage(kv)
    o = db.create_order(user_id=1, chat_id=1, customer_name="Ada", phone="0800",
                        items=[{"id": "jollof", "name": "Jollof Rice", "price": 1500, "qty": 2}],
                        subtotal=3000, delivery_fee=500, total=3500, fulfilment="delivery", address="Lekki",
                        payment_method="cod")
    assert o.id.startswith("LL-") and o.status == "received"
    assert db.get_order(o.id.lower()).total == 3500
    assert db.set_status(o.id, "preparing").status == "preparing"
    assert db.update_order(o.id, payment_status="paid").payment_status == "paid"
    with pytest.raises(ValueError):
        db.set_status(o.id, "bogus")
    db.create_order(user_id=1, chat_id=1, items=[], subtotal=0, delivery_fee=0, total=1000, fulfilment="pickup",
                    status="delivered")
    assert len(db.orders_for_user(1)) == 2
    assert [x.id for x in db.active_orders()] == [o.id]
    s = db.stats()
    assert s["orders"] == 2 and s["revenue"] == 4500 and s["paid_orders"] == 1
    db.remember_customer(5, name="Ada", phone="0801")
    db.remember_customer(5, last_address="VI")
    assert db.get_customer(5)["phone"] == "0801"
    assert db.create_inquiry(5, 5, "Ada", "Acme", "0801", "Catering") == 1
    assert db.create_inquiry(5, 5, "Ada", "Acme", "0801", "More") == 2
    assert db.list_inquiries()[0]["id"] == 2
    db.create_ticket(5, 5, "ada", "hi")
    assert db.stats()["open_tickets"] == 1
    db.close_tickets_for_user(5)
    assert db.stats()["open_tickets"] == 0
    db.save_user_state(9, {"cart": {"jollof": 2}})
    assert db.load_user_state(9) == {"cart": {"jollof": 2}}
    db.save_user_state(9, {})
    assert db.load_user_state(9) == {}


def test_extract_user_id_and_secret():
    assert extract_user_id({"message": {"from": {"id": 7}}}) == 7
    assert extract_user_id({"callback_query": {"from": {"id": 8}}}) == 8
    assert extract_user_id({"channel_post": {}}) is None
    s = webhook_secret("123:abc")
    assert re.fullmatch(r"[A-Za-z0-9_-]{1,256}", s) and s == webhook_secret("123:abc")


class FakeTelegram(BaseRequest):
    """Answers the Bot API calls python-telegram-bot makes, recording outgoing messages."""

    def __init__(self):
        self.sent: list[dict] = []

    async def initialize(self):
        pass

    async def shutdown(self):
        pass

    async def do_request(self, url, method, request_data=None, read_timeout=None, write_timeout=None,
                         connect_timeout=None, pool_timeout=None):
        api = url.rsplit("/", 1)[-1]
        params = request_data.parameters if request_data else {}
        if api == "getMe":
            result = {"id": 1, "is_bot": True, "first_name": "Laurence Lab", "username": "LaurenceLabBot"}
        elif api in ("sendMessage", "editMessageText"):
            self.sent.append({"api": api, **params})
            result = {"message_id": 1, "date": 0, "chat": {"id": params.get("chat_id", 42), "type": "private"},
                      "text": params.get("text", "")}
        elif api == "sendLocation":
            result = {"message_id": 2, "date": 0, "chat": {"id": 42, "type": "private"}}
        else:
            result = True
        return 200, json.dumps({"ok": True, "result": result}).encode()


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("BOT_TOKEN", "123456:TEST")
    monkeypatch.setenv("ADMIN_CHAT_IDS", "999")


def _msg(uid, text, update_id=1):
    entities = [{"type": "bot_command", "offset": 0, "length": len(text.split()[0])}] if text.startswith("/") else []
    return {"update_id": update_id, "message": {"message_id": update_id, "date": 0, "text": text,
            "entities": entities, "chat": {"id": uid, "type": "private"},
            "from": {"id": uid, "is_bot": False, "first_name": "Aruya"}}}


def _cb(uid, data, update_id=1):
    return {"update_id": update_id, "callback_query": {"id": str(update_id), "chat_instance": "x", "data": data,
            "from": {"id": uid, "is_bot": False, "first_name": "Aruya"},
            "message": {"message_id": 5, "date": 0, "text": "m", "chat": {"id": uid, "type": "private"}}}}


@pytest.mark.asyncio
async def test_serverless_conversation_persists_between_invocations(blob):
    """Each update is a separate function invocation; state must survive via Blob storage."""
    tg = FakeTelegram()

    def storage():
        return BlobStorage(BlobKV("test-token", transport=httpx.MockTransport(blob.handler)))

    await process_update(_msg(42, "/start"), storage=storage(), request=tg)
    assert "Welcome" in tg.sent[-1]["text"]

    await process_update(_msg(42, "2 jollof and 1 chicken", 2), storage=storage(), request=tg)
    assert "Here's what I understood" in tg.sent[-1]["text"]
    assert BlobStorage(BlobKV("test-token", transport=httpx.MockTransport(blob.handler))).load_user_state(42)["pending_order"] == {"ll_jollof": 2, "ll_chicken": 1}

    await process_update(_cb(42, "nlp:accept:checkout", 3), storage=storage(), request=tg)
    assert "Checkout" in tg.sent[-1]["text"]
    await process_update(_cb(42, "checkout:mode:pickup", 4), storage=storage(), request=tg)
    await process_update(_msg(42, "08012345678", 5), storage=storage(), request=tg)
    assert "Review your order" in tg.sent[-1]["text"]
    await process_update(_cb(42, "checkout:confirm", 6), storage=storage(), request=tg)
    text = tg.sent[-1]["text"]
    oid = re.search(r"LL-[A-Z0-9]{6}", text).group(0)
    await process_update(_cb(42, f"pay:cod:{oid}", 7), storage=storage(), request=tg)
    admin_msgs = [m for m in tg.sent if m.get("chat_id") == 999]
    assert admin_msgs and "New order" in admin_msgs[-1]["text"]

    # Admin advances the order from a *separate* invocation; customer gets notified.
    await process_update({"update_id": 8, "callback_query": {"id": "8", "chat_instance": "y",
                          "data": f"admin:status:{oid}:preparing",
                          "from": {"id": 999, "is_bot": False, "first_name": "Boss"},
                          "message": {"message_id": 9, "date": 0, "text": "m", "chat": {"id": 999, "type": "private"}}}},
                         storage=storage(), request=tg)
    assert any(m.get("chat_id") == 42 and "Preparing" in m["text"] for m in tg.sent[-3:])
    order = storage().get_order(oid)
    assert order.status == "preparing" and order.payment_status == "pay_on_delivery"
    assert storage().load_user_state(42).get("cart", {}) == {}
