"""Payment helpers: Paystack online payment, bank transfer details, Telegram native payments."""

from __future__ import annotations

from dataclasses import dataclass

import httpx

from .config import Settings

PAYSTACK_BASE = "https://api.paystack.co"


@dataclass(frozen=True)
class PaymentOption:
    key: str
    label: str
    description: str


def available_payment_options(settings: Settings) -> list[PaymentOption]:
    options: list[PaymentOption] = []
    if settings.paystack_enabled:
        options.append(PaymentOption("paystack", "💳 Pay online (card / transfer / USSD)", "Secure Paystack checkout"))
    if settings.telegram_payments_enabled:
        options.append(PaymentOption("telegram", "💳 Pay in Telegram", "Telegram native payment"))
    options.append(PaymentOption("transfer", "🏦 Bank transfer", "Transfer to our account and confirm"))
    options.append(PaymentOption("cod", "💵 Pay on delivery / pickup", "Cash or POS when your order arrives"))
    return options


def bank_transfer_text(settings: Settings, amount: int, order_id: str) -> str:
    return (
        f"🏦 *Bank transfer*\n\n"
        f"Bank: *{settings.bank_name}*\n"
        f"Account name: *{settings.bank_account_name}*\n"
        f"Account number: `{settings.bank_account_number}`\n"
        f"Amount: *{settings.currency}{amount:,}*\n"
        f"Reference / narration: `{order_id}`\n\n"
        "After transferring, tap *I have paid* below. We confirm transfers within a few minutes "
        "and start cooking immediately."
    )


class PaystackClient:
    def __init__(self, secret_key: str) -> None:
        self._headers = {"Authorization": f"Bearer {secret_key}", "Content-Type": "application/json"}

    async def initialize(self, *, email: str, amount_naira: int, reference: str, metadata: dict | None = None) -> str:
        """Create a Paystack transaction and return the hosted checkout URL."""
        payload = {
            "email": email,
            "amount": int(amount_naira) * 100,  # kobo
            "reference": reference,
            "currency": "NGN",
            "metadata": metadata or {},
        }
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(f"{PAYSTACK_BASE}/transaction/initialize", json=payload, headers=self._headers)
        data = resp.json()
        if resp.status_code >= 400 or not data.get("status"):
            raise RuntimeError(data.get("message", "Paystack initialisation failed"))
        return data["data"]["authorization_url"]

    async def verify(self, reference: str) -> bool:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.get(f"{PAYSTACK_BASE}/transaction/verify/{reference}", headers=self._headers)
        data = resp.json()
        return bool(data.get("status")) and data.get("data", {}).get("status") == "success"


def paystack_reference(order_id: str, attempt: int) -> str:
    return f"{order_id}-{attempt}".replace("-", "_")
