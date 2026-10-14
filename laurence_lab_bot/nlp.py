"""Very small natural-language order parser.

Turns messages like
    "I'd like to order 4 portions of jollof, 1 chicken, 1 chivita, 2 portions of plantain and bottle water"
into a list of (MenuItem, quantity) pairs plus the parts we could not understand.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .restaurant import MENU, MenuItem

NUMBER_WORDS = {
    "a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    "half": 1, "dozen": 12,
}

FILLER = re.compile(
    r"\b(i'?d|i would|i want|i'?ll|like to|want to|order|please|pls|get me|give me|can i|have|"
    r"portions?|plates?|packs?|bottles?|pieces?|pcs|servings?|of|some|the|a|an|and|with|plus|also|"
    r"for me|to go|delivery|pickup)\b"
)

ORDER_HINT = re.compile(
    r"\b(order|want|like|get|buy|give me|send me|portions?|plates?|bottles?|pieces?)\b", re.IGNORECASE
)


@dataclass
class ParsedOrder:
    lines: list[tuple[MenuItem, int]] = field(default_factory=list)
    unmatched: list[str] = field(default_factory=list)

    @property
    def is_empty(self) -> bool:
        return not self.lines


def _split_chunks(text: str) -> list[str]:
    text = text.replace("\n", ",")
    parts = re.split(r",|;|\band\b|\bplus\b|&|\bwith\b", text)
    return [p.strip() for p in parts if p.strip()]


def _extract_quantity(chunk: str) -> tuple[int, str]:
    m = re.search(r"\b(\d+)\s*(?:x|×)?\b", chunk)
    if m:
        qty = int(m.group(1))
        rest = chunk[: m.start()] + " " + chunk[m.end():]
        return max(1, qty), rest
    m = re.search(r"\b(" + "|".join(NUMBER_WORDS) + r")\b", chunk)
    if m:
        qty = NUMBER_WORDS[m.group(1)]
        rest = chunk[: m.start()] + " " + chunk[m.end():]
        return max(1, qty), rest
    return 1, chunk


def _match_item(chunk: str) -> MenuItem | None:
    chunk = chunk.lower()
    best: tuple[int, MenuItem] | None = None
    for item in MENU:
        for alias in item.all_names:
            if re.search(r"\b" + re.escape(alias) + r"\b", chunk):
                score = len(alias)
                if best is None or score > best[0]:
                    best = (score, item)
    return best[1] if best else None


def looks_like_order(text: str) -> bool:
    """Cheap check so we only try to parse messages that mention food or ordering."""
    if ORDER_HINT.search(text):
        return True
    return _match_item(text) is not None


def parse_order(text: str) -> ParsedOrder:
    result = ParsedOrder()
    cleaned = text.lower().replace("’", "'")
    merged: dict[str, int] = {}
    order: list[MenuItem] = []
    for chunk in _split_chunks(cleaned):
        item = _match_item(chunk)
        qty, _ = _extract_quantity(chunk)
        if item is None:
            leftover = FILLER.sub(" ", chunk)
            leftover = re.sub(r"[^a-z0-9 ]", " ", leftover)
            leftover = re.sub(r"\s+", " ", leftover).strip()
            if leftover and not leftover.isdigit():
                result.unmatched.append(leftover)
            continue
        if item.id not in merged:
            order.append(item)
            merged[item.id] = 0
        merged[item.id] += qty
    result.lines = [(item, merged[item.id]) for item in order]
    return result
