"""Turn stored Markdown reports into Telegram-safe HTML messages."""
from __future__ import annotations

import html
import re

TELEGRAM_LIMIT = 4096
CHUNK = 3800

_LINK = re.compile(r"\[([^\]\n]+)\]\((https?://[^\s)]+)\)")
_BOLD = re.compile(r"\*\*(.+?)\*\*")
_ITALIC_LINE = re.compile(r"^_(.+)_$")
_CODE = re.compile(r"`([^`\n]+)`")
_BULLET = re.compile(r"^[-*•]\s+")


def _inline(text: str) -> str:
    text = html.escape(text, quote=False)
    text = _LINK.sub(lambda m: f'<a href="{m.group(2).replace(chr(34), "%22")}">{m.group(1)}</a>', text)
    text = _BOLD.sub(r"<b>\1</b>", text)
    return _CODE.sub(r"<code>\1</code>", text)


def md_to_html(markdown: str) -> str:
    """Convert the small Markdown subset our reports use. Every output line is tag-balanced,
    so the result can be split on line boundaries safely."""
    out = []
    for raw in markdown.replace("\r\n", "\n").split("\n"):
        line = raw.rstrip()
        stripped = line.lstrip()
        indent = "  " * ((len(line) - len(stripped)) // 2)
        heading = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if heading:
            text = re.sub(r"\*\*", "", heading.group(2))
            out.append(f"<b>{html.escape(text.upper() if len(heading.group(1)) == 1 else text, quote=False)}</b>")
        elif _BULLET.match(stripped):
            out.append(f"{indent}• {_inline(_BULLET.sub('', stripped))}")
        elif re.match(r"^(-{3,}|\*{3,}|={3,})$", stripped):
            out.append("")
        elif _ITALIC_LINE.match(stripped) and "**" not in stripped:
            out.append(f"<i>{_inline(_ITALIC_LINE.match(stripped).group(1))}</i>")
        else:
            out.append(indent + _inline(stripped))
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()


def split_message(text: str, limit: int = CHUNK) -> list[str]:
    """Split on paragraph, then line boundaries. Preferring to break before a heading."""
    chunks, current = [], ""
    for line in text.split("\n"):
        while len(line) > limit:  # a single monster line: hard split as plain text
            head, line = line[:limit], line[limit:]
            if current:
                chunks.append(current)
                current = ""
            chunks.append(html.escape(strip_html(head), quote=False))
        candidate = f"{current}\n{line}" if current else line
        if len(candidate) > limit:
            cut = current.rfind("\n<b>")
            if cut > limit // 2:  # keep a heading together with the text under it
                chunks.append(current[:cut])
                current = current[cut + 1:] + "\n" + line
            else:
                chunks.append(current)
                current = line
        else:
            current = candidate
    if current.strip():
        chunks.append(current)
    return [c.strip("\n") for c in chunks if c.strip()]


def strip_html(text: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", text))


def esc(text) -> str:
    return html.escape(str(text if text is not None else ""), quote=False)
