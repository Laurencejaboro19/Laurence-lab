"""Telegram sends every update here (POST). Set up with GET /api/setup."""

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

from laurence_lab_bot.serverless import process_update, webhook_secret  # noqa: E402

log = logging.getLogger("webhook")


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        send_json(self, 200, {"ok": True, "message": "Laurence Lab bot webhook. Telegram POSTs updates here."})

    def do_POST(self):
        token = os.getenv("BOT_TOKEN", "")
        expected = webhook_secret(token) if token else ""
        got = self.headers.get("X-Telegram-Bot-Api-Secret-Token", "")
        if not token or got != expected:
            send_json(self, 403, {"ok": False, "error": "bad secret"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            update = json.loads(raw.decode("utf-8") or "{}")
            run(process_update(update))
            send_json(self, 200, {"ok": True})
        except Exception as exc:  # never let Telegram retry forever on our bugs
            log.exception("update failed")
            send_json(self, 200, error_payload(exc))
