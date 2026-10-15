"""Persistent storage on Vercel Blob (used when the bot runs as a serverless function).

Design: every record is a small JSON document. Each write creates a *new* blob with a
timestamped pathname (``kv/<key>/<ts>.json``) and older versions are deleted afterwards, so
reads never hit a stale CDN cache. Small list indexes (``idx/...``) make the admin
queries cheap. Volume is restaurant-scale, so this is plenty.
"""

from __future__ import annotations

import json
import secrets
import string
import time
from datetime import datetime, timezone
from typing import Any

import httpx

from .storage import ORDER_STATUSES, Order

BLOB_API = "https://blob.vercel-storage.com"
MAX_INDEX = 300


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _new_order_id() -> str:
    alphabet = string.ascii_uppercase + string.digits
    return "LL-" + "".join(secrets.choice(alphabet) for _ in range(6))


class BlobKV:
    """Tiny key → JSON document store on top of Vercel Blob."""

    def __init__(self, token: str, *, transport: httpx.BaseTransport | None = None) -> None:
        self._auth = {"authorization": f"Bearer {token}"}
        self._client = httpx.Client(timeout=20, transport=transport)
        self._cache: dict[str, Any] = {}

    # -- low level ---------------------------------------------------------
    def _list(self, prefix: str, limit: int = 1000) -> list[dict[str, Any]]:
        blobs: list[dict[str, Any]] = []
        cursor = None
        while True:
            params: dict[str, Any] = {"prefix": prefix, "limit": limit}
            if cursor:
                params["cursor"] = cursor
            r = self._client.get(f"{BLOB_API}/", params=params, headers={**self._auth, "x-api-version": "7"})
            r.raise_for_status()
            data = r.json()
            blobs.extend(data.get("blobs", []))
            if not data.get("hasMore") or not data.get("cursor"):
                return blobs
            cursor = data["cursor"]

    def _put(self, pathname: str, payload: Any) -> str:
        r = self._client.put(
            f"{BLOB_API}/{pathname}",
            content=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                **self._auth,
                "x-api-version": "7",
                "x-content-type": "application/json",
                "x-add-random-suffix": "0",
                "x-allow-overwrite": "1",
                "x-cache-control-max-age": "60",
            },
        )
        r.raise_for_status()
        return r.json()["url"]

    def _delete(self, urls: list[str]) -> None:
        if not urls:
            return
        r = self._client.post(
            f"{BLOB_API}/delete",
            json={"urls": urls},
            headers={**self._auth, "x-api-version": "7"},
        )
        r.raise_for_status()

    def _read(self, url: str) -> Any:
        r = self._client.get(url, headers=self._auth)
        r.raise_for_status()
        return r.json()

    # -- public ------------------------------------------------------------
    def get(self, key: str, default: Any = None) -> Any:
        if key in self._cache:
            return self._cache[key]
        blobs = self._list(f"kv/{key}/")
        if not blobs:
            self._cache[key] = default
            return default
        blobs.sort(key=lambda b: b["pathname"])
        latest = blobs[-1]
        value = self._read(latest["url"])
        self._cache[key] = value
        # Opportunistic cleanup of superseded versions.
        self._delete([b["url"] for b in blobs[:-1]])
        return value

    def set(self, key: str, value: Any) -> None:
        old = self._list(f"kv/{key}/")
        self._put(f"kv/{key}/{int(time.time() * 1000):015d}-{secrets.token_hex(3)}.json", value)
        self._cache[key] = value
        self._delete([b["url"] for b in old])

    def delete(self, key: str) -> None:
        self._delete([b["url"] for b in self._list(f"kv/{key}/")])
        self._cache.pop(key, None)

    def close(self) -> None:
        self._client.close()


class BlobStorage:
    """Same interface as :class:`laurence_lab_bot.storage.Storage`, backed by :class:`BlobKV`."""

    def __init__(self, kv: BlobKV) -> None:
        self.kv = kv

    # -- helpers -----------------------------------------------------------
    def _index(self, name: str) -> list[dict[str, Any]]:
        return list(self.kv.get(f"idx/{name}", []) or [])

    def _save_index(self, name: str, rows: list[dict[str, Any]]) -> None:
        self.kv.set(f"idx/{name}", rows[:MAX_INDEX])

    def _upsert_order_index(self, order: dict[str, Any]) -> None:
        rows = [r for r in self._index("orders") if r.get("id") != order["id"]]
        rows.insert(0, order)
        rows.sort(key=lambda r: r.get("created_at", ""), reverse=True)
        self._save_index("orders", rows)

    @staticmethod
    def _to_order(data: dict[str, Any]) -> Order:
        data = dict(data)
        data.setdefault("restaurant_id", "ll")
        return Order(**data)

    # -- orders ------------------------------------------------------------
    def create_order(self, **fields: Any) -> Order:
        now = _now()
        order_id = _new_order_id()
        while self.kv.get(f"orders/{order_id}") is not None:
            order_id = _new_order_id()
        data = {
            "id": order_id,
            "restaurant_id": fields.get("restaurant_id", "ll"),
            "user_id": fields["user_id"],
            "chat_id": fields["chat_id"],
            "customer_name": fields.get("customer_name", ""),
            "phone": fields.get("phone", ""),
            "items": fields["items"],
            "subtotal": fields["subtotal"],
            "delivery_fee": fields["delivery_fee"],
            "total": fields["total"],
            "fulfilment": fields["fulfilment"],
            "address": fields.get("address", ""),
            "latitude": fields.get("latitude"),
            "longitude": fields.get("longitude"),
            "payment_method": fields.get("payment_method", ""),
            "payment_status": fields.get("payment_status", "pending"),
            "payment_ref": fields.get("payment_ref", ""),
            "status": fields.get("status", "received"),
            "eta_minutes": fields.get("eta_minutes", 0),
            "notes": fields.get("notes", ""),
            "created_at": now,
            "updated_at": now,
        }
        self.kv.set(f"orders/{order_id}", data)
        self._upsert_order_index(data)
        return self._to_order(data)

    def get_order(self, order_id: str) -> Order | None:
        data = self.kv.get(f"orders/{order_id.upper().strip()}")
        return self._to_order(data) if data else None

    def orders_for_user(self, user_id: int, limit: int = 5) -> list[Order]:
        rows = [r for r in self._index("orders") if r.get("user_id") == user_id]
        return [self._to_order(r) for r in rows[:limit]]

    def list_orders(self, status: str | None = None, limit: int = 20) -> list[Order]:
        rows = self._index("orders")
        if status:
            rows = [r for r in rows if r.get("status") == status]
        return [self._to_order(r) for r in rows[:limit]]

    def active_orders(self, limit: int = 50, restaurant_id: str | None = None) -> list[Order]:
        rows = [r for r in self._index("orders") if r.get("status") not in ("delivered", "cancelled")
                and (restaurant_id is None or r.get("restaurant_id", "ll") == restaurant_id)]
        rows.sort(key=lambda r: r.get("created_at", ""))
        return [self._to_order(r) for r in rows[:limit]]

    def order_by_payment_ref(self, reference: str) -> Order | None:
        for r in self._index("orders"):
            if r.get("payment_ref") == reference:
                return self.get_order(r["id"])
        return None

    def update_order(self, order_id: str, **fields: Any) -> Order | None:
        data = self.kv.get(f"orders/{order_id.upper().strip()}")
        if not data:
            return None
        if fields:
            data.update(fields)
            data["updated_at"] = _now()
            self.kv.set(f"orders/{data['id']}", data)
            self._upsert_order_index(data)
        return self._to_order(data)

    def set_status(self, order_id: str, status: str) -> Order | None:
        if status not in ORDER_STATUSES:
            raise ValueError(f"Unknown status {status!r}")
        return self.update_order(order_id, status=status)

    def stats(self) -> dict[str, Any]:
        rows = self._index("orders")
        by_status: dict[str, int] = {}
        for r in rows:
            by_status[r.get("status", "?")] = by_status.get(r.get("status", "?"), 0) + 1
        paid = [r for r in rows if r.get("payment_status") == "paid"]
        tickets = self._index("tickets")
        return {
            "orders": len(rows),
            "revenue": sum(r.get("total", 0) for r in rows),
            "paid_orders": len(paid),
            "paid_revenue": sum(r.get("total", 0) for r in paid),
            "by_status": by_status,
            "inquiries": len(self._index("inquiries")),
            "open_tickets": sum(1 for t in tickets if t.get("status") == "open"),
        }

    # -- admins ------------------------------------------------------------
    def register_admin(self, user_id: int, username: str = "", chat_id: int | None = None) -> None:
        rows = [r for r in self._index("admins") if r.get("user_id") != user_id]
        rows.append({"user_id": user_id, "username": username, "chat_id": chat_id or user_id, "created_at": _now()})
        self._save_index("admins", rows)

    def admin_ids(self) -> set[int]:
        return {r["user_id"] for r in self._index("admins")}

    # -- vendors -----------------------------------------------------------
    def register_vendor(self, user_id: int, restaurant_id: str, username: str = "", chat_id: int | None = None) -> None:
        rows = [r for r in self._index("vendors") if r.get("user_id") != user_id]
        rows.append({"user_id": user_id, "restaurant_id": restaurant_id, "username": username,
                     "chat_id": chat_id or user_id, "created_at": _now()})
        self._save_index("vendors", rows)

    def unregister_vendor(self, user_id: int) -> None:
        rows = [r for r in self._index("vendors") if r.get("user_id") != user_id]
        self._save_index("vendors", rows)

    def vendor_restaurant(self, user_id: int) -> str | None:
        for r in self._index("vendors"):
            if r.get("user_id") == user_id:
                return r.get("restaurant_id")
        return None

    def vendor_chat_ids(self, restaurant_id: str) -> list[int]:
        return [r["chat_id"] for r in self._index("vendors") if r.get("restaurant_id") == restaurant_id]

    # -- customers ---------------------------------------------------------
    def remember_customer(self, user_id: int, **fields: Any) -> None:
        existing = self.get_customer(user_id) or {}
        data = {
            "user_id": user_id,
            "name": fields.get("name", existing.get("name")),
            "phone": fields.get("phone", existing.get("phone")),
            "last_address": fields.get("last_address", existing.get("last_address")),
            "updated_at": _now(),
        }
        self.kv.set(f"customers/{user_id}", data)

    def get_customer(self, user_id: int) -> dict[str, Any] | None:
        return self.kv.get(f"customers/{user_id}")

    # -- inquiries ---------------------------------------------------------
    def create_inquiry(self, user_id: int, chat_id: int, name: str, company: str, contact: str, message: str) -> int:
        rows = self._index("inquiries")
        new_id = max((r.get("id", 0) for r in rows), default=0) + 1
        rows.insert(0, {
            "id": new_id, "user_id": user_id, "chat_id": chat_id, "name": name, "company": company,
            "contact": contact, "message": message, "status": "new", "created_at": _now(),
        })
        self._save_index("inquiries", rows)
        return new_id

    def list_inquiries(self, limit: int = 10) -> list[dict[str, Any]]:
        return self._index("inquiries")[:limit]

    # -- tickets -----------------------------------------------------------
    def create_ticket(self, user_id: int, chat_id: int, username: str, message: str) -> int:
        rows = self._index("tickets")
        new_id = max((r.get("id", 0) for r in rows), default=0) + 1
        rows.insert(0, {
            "id": new_id, "user_id": user_id, "chat_id": chat_id, "username": username,
            "message": message, "status": "open", "created_at": _now(),
        })
        self._save_index("tickets", rows)
        return new_id

    def close_tickets_for_user(self, user_id: int) -> None:
        rows = self._index("tickets")
        changed = False
        for t in rows:
            if t.get("user_id") == user_id and t.get("status") == "open":
                t["status"] = "closed"
                changed = True
        if changed:
            self._save_index("tickets", rows)

    # -- user conversation state (used by the serverless persistence) -----
    def load_user_state(self, user_id: int) -> dict[str, Any]:
        return dict(self.kv.get(f"state/{user_id}", {}) or {})

    def save_user_state(self, user_id: int, data: dict[str, Any]) -> None:
        if data:
            self.kv.set(f"state/{user_id}", data)
        else:
            self.kv.delete(f"state/{user_id}")

    def close(self) -> None:
        self.kv.close()
