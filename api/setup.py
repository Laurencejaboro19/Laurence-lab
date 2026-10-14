"""GET /api/setup – registers this deployment as the bot's webhook. Safe to call repeatedly."""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler

_HERE = __import__("os").path.dirname(__import__("os").path.abspath(__file__))
for _p in (_HERE, __import__("os").path.dirname(_HERE)):
    if _p not in __import__("sys").path:
        __import__("sys").path.insert(0, _p)

from _common import error_payload, public_base_url, run, send_json  # noqa: E402

from laurence_lab_bot.serverless import setup_webhook  # noqa: E402


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            result = run(setup_webhook(public_base_url(self)))
            send_json(self, 200, result)
        except SystemExit as exc:  # missing BOT_TOKEN
            send_json(self, 500, {"ok": False, "error": str(exc)})
        except Exception as exc:
            send_json(self, 500, error_payload(exc))
