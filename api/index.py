"""GET / – human-friendly status page with the bot link."""

from __future__ import annotations

import html
import os
from http.server import BaseHTTPRequestHandler

_HERE = __import__("os").path.dirname(__import__("os").path.abspath(__file__))
for _p in (_HERE, __import__("os").path.dirname(_HERE)):
    if _p not in __import__("sys").path:
        __import__("sys").path.insert(0, _p)

from _common import run, send_html  # noqa: E402

from laurence_lab_bot.serverless import status  # noqa: E402

PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Laurence Lab Bot</title>
<style>body{{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.5;color:#1a1a1a}}
a.btn{{display:inline-block;background:#2AABEE;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600}}
code{{background:#f3f3f3;padding:2px 6px;border-radius:4px}}.muted{{color:#666}}</style></head><body>
<h1>🍔 Laurence Lab – Telegram bot</h1>{body}</body></html>"""


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if not os.getenv("BOT_TOKEN"):
            body = ("<p><strong>Status:</strong> deployed, waiting for a Telegram bot token.</p>"
                    "<p class='muted'>Set <code>BOT_TOKEN</code> in the Vercel project settings, redeploy, "
                    "then open <code>/api/setup</code> once.</p>")
            send_html(self, 200, PAGE.format(body=body))
            return
        try:
            s = run(status())
            ok = bool(s.get("webhook_url"))
            body = (
                f"<p><strong>Status:</strong> {'live ✅' if ok else 'token set, webhook not registered yet'}</p>"
                f"<p><a class='btn' href='{html.escape(s['bot_link'])}'>Open @{html.escape(s['bot'])} in Telegram</a></p>"
                f"<p class='muted'>Webhook: <code>{html.escape(s.get('webhook_url') or '—')}</code><br>"
                f"Pending updates: {s.get('pending_updates')} · Last error: {html.escape(str(s.get('last_error') or 'none'))}<br>"
                f"Admins configured: {s.get('admins_configured')} · Storage: {'Vercel Blob' if s.get('blob_storage') else 'none'}</p>"
                + ("" if ok else "<p>Open <code>/api/setup</code> to register the webhook.</p>")
            )
            send_html(self, 200, PAGE.format(body=body))
        except Exception as exc:
            send_html(self, 500, PAGE.format(body=f"<p>Error: <code>{html.escape(str(exc))}</code></p>"))
