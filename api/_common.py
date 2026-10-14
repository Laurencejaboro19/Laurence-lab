"""Shared HTTP plumbing for the Vercel functions."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import traceback
from http.server import BaseHTTPRequestHandler

# Make the project root importable when Vercel runs api/*.py
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

logging.basicConfig(level=logging.INFO)


def public_base_url(handler: BaseHTTPRequestHandler) -> str:
    explicit = os.getenv("PUBLIC_BASE_URL")
    if explicit:
        return explicit.rstrip("/")
    host = handler.headers.get("x-forwarded-host") or handler.headers.get("host") or os.getenv("VERCEL_URL", "")
    return f"https://{host}"


def send_json(handler: BaseHTTPRequestHandler, status: int, payload: dict) -> None:
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def send_html(handler: BaseHTTPRequestHandler, status: int, html: str) -> None:
    body = html.encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "text/html; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def run(coro):
    return asyncio.run(coro)


def error_payload(exc: BaseException) -> dict:
    return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "trace": traceback.format_exc()[-2000:]}
