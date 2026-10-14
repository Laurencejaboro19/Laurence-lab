"""Runs during the Vercel build: points Telegram at this deployment's webhook.

Standard library only (no pip packages are installed at this stage). Skips silently when
BOT_TOKEN is missing or when this is not a production deployment.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import urllib.parse
import urllib.request

COMMANDS = [
    ("start", "Main menu"), ("menu", "Browse the menu"), ("cart", "View your cart"),
    ("track", "Track an order"), ("orders", "Your recent orders"), ("support", "Speak to support"),
    ("about", "About the restaurant"), ("hours", "Opening hours"), ("help", "How to use this bot"),
    ("cancel", "Cancel the current action"),
]


def webhook_secret(bot_token: str) -> str:  # must match laurence_lab_bot.serverless.webhook_secret
    return hashlib.sha256(("laurence-lab:" + bot_token).encode()).hexdigest()[:48]


def call(token: str, method: str, **params):
    data = urllib.parse.urlencode({k: (json.dumps(v) if isinstance(v, (list, dict)) else v) for k, v in params.items()}).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/{method}", data=data)
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode())


def main() -> int:
    token = os.getenv("BOT_TOKEN", "").strip()
    env = os.getenv("VERCEL_ENV", "")
    if not token:
        print("register_webhook: BOT_TOKEN not set – skipping (set it in Vercel env vars and redeploy).")
        return 0
    if env and env != "production":
        print(f"register_webhook: VERCEL_ENV={env} – only production registers the webhook, skipping.")
        return 0
    base = os.getenv("PUBLIC_BASE_URL") or (
        "https://" + os.environ["VERCEL_PROJECT_PRODUCTION_URL"] if os.getenv("VERCEL_PROJECT_PRODUCTION_URL") else ""
    )
    if not base:
        print("register_webhook: no PUBLIC_BASE_URL / VERCEL_PROJECT_PRODUCTION_URL – skipping.")
        return 0
    url = base.rstrip("/") + "/api/webhook"
    try:
        me = call(token, "getMe")["result"]
        res = call(token, "setWebhook", url=url, secret_token=webhook_secret(token), drop_pending_updates=True,
                   max_connections=20, allowed_updates=["message", "edited_message", "callback_query",
                                                        "pre_checkout_query", "shipping_query"])
        call(token, "setMyCommands", commands=[{"command": c, "description": d} for c, d in COMMANDS])
        print(f"register_webhook: @{me['username']} -> {url} : {res.get('description')}")
        print(f"register_webhook: bot link https://t.me/{me['username']}")
    except Exception as exc:  # never fail the build because Telegram hiccupped
        print(f"register_webhook: WARNING could not register webhook: {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
