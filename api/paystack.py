"""POST /api/paystack – Paystack webhook. Set this URL in Paystack Dashboard → Settings → API Keys & Webhooks."""

from __future__ import annotations

import json
import logging
import os
from http.server import BaseHTTPRequestHandler

_HERE = __import__("os").path.dirname(__import__("os").path.abspath(__file__))
for _p in (_HERE, __import__("os").path.dirname(_HERE)):
    if _p not in __import__("sys").path:
        __import__("sys").path.insert(0, _p)

from _common import error_payload, run, send_json  # noqa: E402

from laurence_lab_bot.payments import verify_paystack_signature  # noqa: E402
from laurence_lab_bot.serverless import handle_paystack_event  # noqa: E402

log = logging.getLogger("paystack")


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        send_json(self, 200, {"ok": True, "message": "Paystack webhook endpoint. Paystack POSTs events here."})

    def do_POST(self):
        secret = os.getenv("PAYSTACK_SECRET_KEY", "")
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        if not secret or not verify_paystack_signature(secret, raw, self.headers.get("x-paystack-signature", "")):
            send_json(self, 401, {"ok": False, "error": "invalid signature"})
            return
        try:
            event = json.loads(raw.decode("utf-8") or "{}")
            send_json(self, 200, run(handle_paystack_event(event)))
        except Exception as exc:
            log.exception("paystack event failed")
            send_json(self, 200, error_payload(exc))  # 200 so Paystack doesn't retry a bug forever
