"""A tiny in-process stand-in for the Telegram Bot API, so the real python-telegram-bot
application (polling, handlers, file download, keyboards) is exercised end to end."""
from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote

TOKEN = "123:TEST"


class FakeTelegram:
    def __init__(self, image_bytes: bytes, first_update_id: int = 1000):
        self.image_bytes = image_bytes
        self.updates: list[dict] = []
        self.calls: list[tuple[str, dict]] = []
        self.lock = threading.Lock()
        self._update_id = first_update_id
        self._message_id = 5000
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    # ---- test-side helpers -------------------------------------------
    def _push(self, body: dict, update_id: int | None = None) -> int:
        with self.lock:
            if update_id is None:
                self._update_id += 1
                update_id = self._update_id
            self.updates.append({"update_id": update_id, **body})
        return update_id

    def _message(self, user_id: int, **fields) -> dict:
        self._message_id += 1
        return {"message_id": self._message_id, "date": int(time.time()), "chat": {"id": user_id, "type": "private"},
                "from": {"id": user_id, "is_bot": False, "first_name": "User", "username": f"user{user_id}"}, **fields}

    def send_text(self, user_id: int, text: str, update_id: int | None = None) -> int:
        entities = [{"type": "bot_command", "offset": 0, "length": len(text.split()[0])}] if text.startswith("/") else []
        return self._push({"message": self._message(user_id, text=text, entities=entities)}, update_id)

    def send_photo(self, user_id: int, unique: str, caption: str | None = None, media_group_id: str | None = None) -> int:
        fields = {"photo": [{"file_id": f"small-{unique}", "file_unique_id": f"s{unique}", "width": 90, "height": 90, "file_size": 100},
                            {"file_id": f"big-{unique}", "file_unique_id": unique, "width": 800, "height": 800, "file_size": len(self.image_bytes)}]}
        if caption:
            fields["caption"] = caption
        if media_group_id:
            fields["media_group_id"] = media_group_id
        return self._push({"message": self._message(user_id, **fields)})

    def press(self, user_id: int, data: str, message_id: int = 1) -> int:
        return self._push({"callback_query": {
            "id": str(time.time_ns()), "chat_instance": "ci", "data": data,
            "from": {"id": user_id, "is_bot": False, "first_name": "User"},
            "message": {"message_id": message_id, "date": int(time.time()), "chat": {"id": user_id, "type": "private"}, "text": "x"}}})

    def sent(self, method: str = "sendMessage") -> list[dict]:
        with self.lock:
            return [params for name, params in self.calls if name == method]

    def texts(self, chat_id: int | None = None) -> list[str]:
        with self.lock:
            return [p.get("text", "") for name, p in self.calls if name in ("sendMessage", "editMessageText")
                    and (chat_id is None or str(p.get("chat_id")) == str(chat_id))]

    # ---- server side -------------------------------------------------
    def _handler(outer):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _json(self, result, ok=True):
                body = json.dumps({"ok": ok, "result": result}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # the bot stopped polling mid-request

            def do_GET(self):
                if unquote(self.path).startswith(f"/file/bot{TOKEN}/"):
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Content-Length", str(len(outer.image_bytes)))
                    self.end_headers()
                    self.wfile.write(outer.image_bytes)
                else:
                    self.do_POST()

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                method = self.path.rsplit("/", 1)[-1]
                ctype = self.headers.get("Content-Type", "")
                if "json" in ctype:
                    params = json.loads(raw or b"{}")
                elif "multipart" in ctype:
                    params = {"_multipart": True, "_size": len(raw), "chat_id": _field(raw, b"chat_id")}
                else:
                    params = {k: v[0] for k, v in parse_qs(raw.decode()).items()}
                if method != "getUpdates":
                    with outer.lock:
                        outer.calls.append((method, params))
                if method == "getMe":
                    return self._json({"id": 123, "is_bot": True, "first_name": "Sextant", "username": "sextant_test_bot",
                                       "can_join_groups": False, "can_read_all_group_messages": False, "supports_inline_queries": False})
                if method == "getUpdates":
                    offset = int(params.get("offset") or 0)
                    deadline = time.time() + 0.3
                    while True:
                        with outer.lock:
                            outer.updates = [u for u in outer.updates if u["update_id"] >= offset or u.get("_sticky")]
                            ready = [{k: v for k, v in u.items() if k != "_sticky"} for u in outer.updates if u["update_id"] >= offset]
                        if ready or time.time() > deadline:
                            return self._json(ready)
                        time.sleep(0.02)
                if method in ("sendMessage", "editMessageText", "editMessageReplyMarkup", "sendDocument"):
                    with outer.lock:
                        outer._message_id += 1
                        message_id = outer._message_id
                    message = {"message_id": message_id, "date": int(time.time()),
                               "chat": {"id": int(params.get("chat_id") or 0), "type": "private"}, "text": params.get("text", "")}
                    if method == "sendDocument":
                        message.pop("text")
                        message["document"] = {"file_id": "doc", "file_unique_id": "docu"}
                    return self._json(message)
                if method == "getFile":
                    return self._json({"file_id": params.get("file_id"), "file_unique_id": "x", "file_size": len(outer.image_bytes),
                                       "file_path": "photos/file.jpg"})
                return self._json(True)

        return Handler


def _field(raw: bytes, name: bytes) -> str:
    marker = b'name="' + name + b'"'
    index = raw.find(marker)
    if index < 0:
        return ""
    start = raw.find(b"\r\n\r\n", index) + 4
    return raw[start:raw.find(b"\r\n", start)].decode(errors="replace")
