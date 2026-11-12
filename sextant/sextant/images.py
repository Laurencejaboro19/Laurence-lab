"""Image understanding: validate, store once, analyse once, reuse forever.

An image is identified by Telegram's file_unique_id and by its SHA-256, so re-sending or
forwarding the same picture never triggers a second vision call or a second file on disk.
"""
from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path

from .config import Config
from .db import Database
from .providers.ai import AIRouter, AllProvidersExhausted, ImageInput
from .research import prompts
from .textutil import clip, extract_json

log = logging.getLogger(__name__)

_MAGIC = (
    (b"\xff\xd8\xff", "image/jpeg", "jpg"),
    (b"\x89PNG\r\n\x1a\n", "image/png", "png"),
    (b"GIF8", "image/gif", "gif"),
)
LIST_FIELDS = ("organisations", "people", "products", "locations", "contacts", "figures", "research_leads")


class ImageRejected(Exception):
    """The upload is not an acceptable image; the message is shown to the user."""


def sniff(data: bytes) -> tuple[str, str]:
    """Trust the bytes, not the filename or the declared MIME type."""
    for magic, mime, ext in _MAGIC:
        if data.startswith(magic):
            return mime, ext
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp", "webp"
    raise ImageRejected("That file is not a supported image. Please send a JPEG, PNG, WebP or GIF.")


class ImageProcessor:
    def __init__(self, cfg: Config, db: Database, ai: AIRouter):
        self.cfg, self.db, self.ai = cfg, db, ai

    def register(self, user_id: int, file_id: str, file_unique_id: str, mime: str = "", size: int = 0) -> int:
        if size and size > self.cfg.max_image_bytes:
            raise ImageRejected(f"That image is too large (limit {self.cfg.max_image_bytes // (1024 * 1024)} MB).")
        return self.db.add_image(user_id=user_id, telegram_file_id=file_id, file_unique_id=file_unique_id, mime=mime, size_bytes=size)

    def needs_download(self, image_id: int) -> bool:
        row = self.db.get_image(image_id)
        return not (row["storage_path"] and Path(row["storage_path"]).exists())

    def ingest(self, image_id: int, data: bytes) -> None:
        """Validate and store the bytes; reuse an earlier analysis of identical content."""
        if len(data) > self.cfg.max_image_bytes:
            raise ImageRejected(f"That image is too large (limit {self.cfg.max_image_bytes // (1024 * 1024)} MB).")
        mime, ext = sniff(data)
        digest = hashlib.sha256(data).hexdigest()
        row = self.db.get_image(image_id)
        self.cfg.image_dir.mkdir(parents=True, exist_ok=True)
        path = self.cfg.image_dir / f"{digest}.{ext}"
        if not path.exists():
            path.write_bytes(data)
        fields: dict = {"sha256": digest, "mime": mime, "size_bytes": len(data), "storage_path": str(path)}
        twin = self.db.find_image(row["user_id"], sha256=digest)
        if twin and twin["id"] != image_id and twin["status"] == "ANALYSED" and row["status"] != "ANALYSED":
            fields.update(status="ANALYSED", extracted_text=twin["extracted_text"], description=twin["description"],
                          provider=twin["provider"], error=None)
        self.db.update_image(image_id, **fields)

    async def analyse(self, image_id: int, task_id: int | None = None):
        """Run vision once per image. Returns the stored row (status ANALYSED or FAILED)."""
        row = self.db.get_image(image_id)
        if row["status"] == "ANALYSED":
            return row
        path = Path(row["storage_path"]) if row["storage_path"] else None
        if not path or not path.exists():
            self.db.update_image(image_id, status="FAILED", error="original image file is not available")
            return self.db.get_image(image_id)
        try:
            result = await self.ai.generate(prompts.VISION, images=[ImageInput(path.read_bytes(), row["mime"] or "image/jpeg")],
                                            want_json=True, max_output_tokens=2000, purpose="vision")
        except AllProvidersExhausted as exc:
            self.db.update_image(image_id, status="FAILED", error=clip(str(exc), 300))
            return self.db.get_image(image_id)

        if result.provider == "ocrspace":  # text only: be honest that nothing visual was interpreted
            description = {"image_type": "unknown (OCR only)", "summary": "Only the text could be read; no visual interpretation was available.",
                           "visible_text": result.text.strip()}
        else:
            try:
                parsed = extract_json(result.text)
                description = parsed if isinstance(parsed, dict) else {}
            except ValueError:
                description = {"summary": clip(result.text.strip(), 1200)}
        for key in LIST_FIELDS:
            value = description.get(key)
            description[key] = [str(v) for v in value if v][:15] if isinstance(value, list) else ([str(value)] if value else [])
        text = str(description.get("visible_text") or "").strip()
        if not text and not description.get("summary"):
            self.db.update_image(image_id, status="FAILED", error="the vision model returned nothing usable")
            return self.db.get_image(image_id)
        self.db.update_image(image_id, status="ANALYSED", extracted_text=text[:8000], description=description,
                             provider=f"{result.provider}:{result.model}", error=None)
        return self.db.get_image(image_id)


def summarise_image(row) -> str:
    """One short human-readable line about an analysed image (for chat replies and saved context)."""
    if row["status"] != "ANALYSED":
        return f"not analysed ({row['error'] or 'pending'})"
    try:
        d = json.loads(row["description"] or "{}")
    except ValueError:
        d = {}
    bits = [str(d.get("image_type") or "image")]
    if d.get("organisations"):
        bits.append("mentions " + ", ".join(d["organisations"][:4]))
    if d.get("summary"):
        bits.append(clip(str(d["summary"]), 220))
    return " — ".join(bits)
