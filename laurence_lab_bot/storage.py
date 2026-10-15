"""SQLite persistence for orders, business inquiries and support tickets."""

from __future__ import annotations

import json
import secrets
import sqlite3
import string
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

ORDER_STATUSES = [
    "received",
    "confirmed",
    "preparing",
    "out_for_delivery",
    "ready_for_pickup",
    "delivered",
    "cancelled",
]

STATUS_LABELS = {
    "received": "📥 Received",
    "confirmed": "✅ Confirmed",
    "preparing": "👨‍🍳 Preparing",
    "out_for_delivery": "🛵 Out for delivery",
    "ready_for_pickup": "🛍️ Ready for pickup",
    "delivered": "🎉 Delivered",
    "cancelled": "❌ Cancelled",
}

PAYMENT_STATUSES = ("pending", "awaiting_confirmation", "paid", "pay_on_delivery", "failed")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _new_order_id() -> str:
    alphabet = string.ascii_uppercase + string.digits
    return "LL-" + "".join(secrets.choice(alphabet) for _ in range(6))


@dataclass
class Order:
    id: str
    restaurant_id: str
    user_id: int
    chat_id: int
    customer_name: str
    phone: str
    items: list[dict[str, Any]]
    subtotal: int
    delivery_fee: int
    total: int
    fulfilment: str  # "delivery" | "pickup"
    address: str
    latitude: float | None
    longitude: float | None
    payment_method: str
    payment_status: str
    payment_ref: str
    status: str
    eta_minutes: int
    notes: str
    created_at: str
    updated_at: str

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> "Order":
        data = dict(row)
        data["items"] = json.loads(data["items"])
        data.setdefault("restaurant_id", "ll")
        return cls(**data)


class Storage:
    def __init__(self, path: str = "laurence_lab.db") -> None:
        self.path = path
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self._init()

    def _init(self) -> None:
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS orders (
                id TEXT PRIMARY KEY,
                restaurant_id TEXT DEFAULT 'll',
                user_id INTEGER NOT NULL,
                chat_id INTEGER NOT NULL,
                customer_name TEXT DEFAULT '',
                phone TEXT DEFAULT '',
                items TEXT NOT NULL,
                subtotal INTEGER NOT NULL,
                delivery_fee INTEGER NOT NULL,
                total INTEGER NOT NULL,
                fulfilment TEXT NOT NULL,
                address TEXT DEFAULT '',
                latitude REAL,
                longitude REAL,
                payment_method TEXT DEFAULT '',
                payment_status TEXT DEFAULT 'pending',
                payment_ref TEXT DEFAULT '',
                status TEXT DEFAULT 'received',
                eta_minutes INTEGER DEFAULT 0,
                notes TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
            CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

            CREATE TABLE IF NOT EXISTS inquiries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                chat_id INTEGER NOT NULL,
                name TEXT,
                company TEXT,
                contact TEXT,
                message TEXT,
                status TEXT DEFAULT 'new',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS tickets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                chat_id INTEGER NOT NULL,
                username TEXT,
                message TEXT,
                status TEXT DEFAULT 'open',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS admins (
                user_id INTEGER PRIMARY KEY,
                username TEXT,
                chat_id INTEGER,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS vendors (
                user_id INTEGER PRIMARY KEY,
                restaurant_id TEXT NOT NULL,
                username TEXT,
                chat_id INTEGER,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS customers (
                user_id INTEGER PRIMARY KEY,
                name TEXT,
                phone TEXT,
                last_address TEXT,
                updated_at TEXT NOT NULL
            );
            """
        )
        self.conn.commit()
        cols = {r["name"] for r in self.conn.execute("PRAGMA table_info(orders)").fetchall()}
        if "restaurant_id" not in cols:  # migrate databases created before partner restaurants existed
            self.conn.execute("ALTER TABLE orders ADD COLUMN restaurant_id TEXT DEFAULT 'll'")
            self.conn.commit()

    # ------------------------------------------------------------------ orders
    def create_order(self, **fields: Any) -> Order:
        now = _now()
        order_id = _new_order_id()
        while self.get_order(order_id) is not None:
            order_id = _new_order_id()
        fields.setdefault("payment_status", "pending")
        fields.setdefault("status", "received")
        fields.setdefault("payment_ref", "")
        fields.setdefault("notes", "")
        fields.setdefault("eta_minutes", 0)
        fields.setdefault("latitude", None)
        fields.setdefault("longitude", None)
        fields.setdefault("restaurant_id", "ll")
        self.conn.execute(
            """
            INSERT INTO orders (id, restaurant_id, user_id, chat_id, customer_name, phone, items, subtotal, delivery_fee,
                total, fulfilment, address, latitude, longitude, payment_method, payment_status, payment_ref,
                status, eta_minutes, notes, created_at, updated_at)
            VALUES (:id, :restaurant_id, :user_id, :chat_id, :customer_name, :phone, :items, :subtotal, :delivery_fee,
                :total, :fulfilment, :address, :latitude, :longitude, :payment_method, :payment_status,
                :payment_ref, :status, :eta_minutes, :notes, :created_at, :updated_at)
            """,
            {
                **fields,
                "id": order_id,
                "items": json.dumps(fields["items"]),
                "created_at": now,
                "updated_at": now,
            },
        )
        self.conn.commit()
        order = self.get_order(order_id)
        assert order is not None
        return order

    def get_order(self, order_id: str) -> Order | None:
        row = self.conn.execute("SELECT * FROM orders WHERE id = ?", (order_id.upper().strip(),)).fetchone()
        return Order.from_row(row) if row else None

    def orders_for_user(self, user_id: int, limit: int = 5) -> list[Order]:
        rows = self.conn.execute(
            "SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ?", (user_id, limit)
        ).fetchall()
        return [Order.from_row(r) for r in rows]

    def list_orders(self, status: str | None = None, limit: int = 20) -> list[Order]:
        if status:
            rows = self.conn.execute(
                "SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC LIMIT ?", (status, limit)
            ).fetchall()
        else:
            rows = self.conn.execute("SELECT * FROM orders ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
        return [Order.from_row(r) for r in rows]

    def active_orders(self, limit: int = 50, restaurant_id: str | None = None) -> list[Order]:
        if restaurant_id:
            rows = self.conn.execute(
                "SELECT * FROM orders WHERE status NOT IN ('delivered', 'cancelled') AND restaurant_id = ? "
                "ORDER BY created_at ASC LIMIT ?", (restaurant_id, limit),
            ).fetchall()
        else:
            rows = self.conn.execute(
                "SELECT * FROM orders WHERE status NOT IN ('delivered', 'cancelled') ORDER BY created_at ASC LIMIT ?",
                (limit,),
            ).fetchall()
        return [Order.from_row(r) for r in rows]

    def order_by_payment_ref(self, reference: str) -> Order | None:
        row = self.conn.execute("SELECT * FROM orders WHERE payment_ref = ?", (reference,)).fetchone()
        return Order.from_row(row) if row else None

    def update_order(self, order_id: str, **fields: Any) -> Order | None:
        if not fields:
            return self.get_order(order_id)
        fields["updated_at"] = _now()
        assignments = ", ".join(f"{k} = :{k}" for k in fields)
        self.conn.execute(f"UPDATE orders SET {assignments} WHERE id = :id", {**fields, "id": order_id})
        self.conn.commit()
        return self.get_order(order_id)

    def set_status(self, order_id: str, status: str) -> Order | None:
        if status not in ORDER_STATUSES:
            raise ValueError(f"Unknown status {status!r}")
        return self.update_order(order_id, status=status)

    def stats(self) -> dict[str, Any]:
        total = self.conn.execute("SELECT COUNT(*), COALESCE(SUM(total), 0) FROM orders").fetchone()
        paid = self.conn.execute(
            "SELECT COUNT(*), COALESCE(SUM(total), 0) FROM orders WHERE payment_status = 'paid'"
        ).fetchone()
        by_status = self.conn.execute("SELECT status, COUNT(*) AS n FROM orders GROUP BY status").fetchall()
        return {
            "orders": total[0],
            "revenue": total[1],
            "paid_orders": paid[0],
            "paid_revenue": paid[1],
            "by_status": {r["status"]: r["n"] for r in by_status},
            "inquiries": self.conn.execute("SELECT COUNT(*) FROM inquiries").fetchone()[0],
            "open_tickets": self.conn.execute("SELECT COUNT(*) FROM tickets WHERE status = 'open'").fetchone()[0],
        }

    # ------------------------------------------------------------------ admins
    def register_admin(self, user_id: int, username: str = "", chat_id: int | None = None) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO admins (user_id, username, chat_id, created_at) VALUES (?,?,?,?)",
            (user_id, username, chat_id or user_id, _now()),
        )
        self.conn.commit()

    def admin_ids(self) -> set[int]:
        return {r["user_id"] for r in self.conn.execute("SELECT user_id FROM admins").fetchall()}

    # ----------------------------------------------------------------- vendors
    def register_vendor(self, user_id: int, restaurant_id: str, username: str = "", chat_id: int | None = None) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO vendors (user_id, restaurant_id, username, chat_id, created_at) VALUES (?,?,?,?,?)",
            (user_id, restaurant_id, username, chat_id or user_id, _now()),
        )
        self.conn.commit()

    def unregister_vendor(self, user_id: int) -> None:
        self.conn.execute("DELETE FROM vendors WHERE user_id = ?", (user_id,))
        self.conn.commit()

    def vendor_restaurant(self, user_id: int) -> str | None:
        row = self.conn.execute("SELECT restaurant_id FROM vendors WHERE user_id = ?", (user_id,)).fetchone()
        return row["restaurant_id"] if row else None

    def vendor_chat_ids(self, restaurant_id: str) -> list[int]:
        rows = self.conn.execute("SELECT chat_id FROM vendors WHERE restaurant_id = ?", (restaurant_id,)).fetchall()
        return [r["chat_id"] for r in rows]

    # --------------------------------------------------------------- customers
    def remember_customer(self, user_id: int, **fields: Any) -> None:
        existing = self.get_customer(user_id) or {}
        data = {
            "user_id": user_id,
            "name": fields.get("name", existing.get("name")),
            "phone": fields.get("phone", existing.get("phone")),
            "last_address": fields.get("last_address", existing.get("last_address")),
            "updated_at": _now(),
        }
        self.conn.execute(
            """
            INSERT INTO customers (user_id, name, phone, last_address, updated_at)
            VALUES (:user_id, :name, :phone, :last_address, :updated_at)
            ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, phone = excluded.phone,
                last_address = excluded.last_address, updated_at = excluded.updated_at
            """,
            data,
        )
        self.conn.commit()

    def get_customer(self, user_id: int) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT * FROM customers WHERE user_id = ?", (user_id,)).fetchone()
        return dict(row) if row else None

    # --------------------------------------------------------------- inquiries
    def create_inquiry(self, user_id: int, chat_id: int, name: str, company: str, contact: str, message: str) -> int:
        cur = self.conn.execute(
            "INSERT INTO inquiries (user_id, chat_id, name, company, contact, message, created_at) VALUES (?,?,?,?,?,?,?)",
            (user_id, chat_id, name, company, contact, message, _now()),
        )
        self.conn.commit()
        return int(cur.lastrowid)

    def list_inquiries(self, limit: int = 10) -> list[dict[str, Any]]:
        rows = self.conn.execute("SELECT * FROM inquiries ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in rows]

    # ----------------------------------------------------------------- tickets
    def create_ticket(self, user_id: int, chat_id: int, username: str, message: str) -> int:
        cur = self.conn.execute(
            "INSERT INTO tickets (user_id, chat_id, username, message, created_at) VALUES (?,?,?,?,?)",
            (user_id, chat_id, username, message, _now()),
        )
        self.conn.commit()
        return int(cur.lastrowid)

    def close_tickets_for_user(self, user_id: int) -> None:
        self.conn.execute("UPDATE tickets SET status = 'closed' WHERE user_id = ? AND status = 'open'", (user_id,))
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()
