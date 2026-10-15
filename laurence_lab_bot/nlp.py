"""Plain-English order parser across all partner restaurants.

    "4 portions of jollof, 1 chicken, 1 chivita, 2 plantain and bottle water"
→ items + quantities from ONE restaurant (the one matching the most lines; the current cart's
restaurant wins ties), plus the parts we could not understand.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .restaurant import MENU, RESTAURANTS, MenuItem, Restaurant, get_restaurant

NUMBER_WORDS = {
    "a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "half": 1, "dozen": 12,
}

FILLER = re.compile(
    r"\b(i'?d|i would|i want|i'?ll|like to|want to|order|please|pls|get me|give me|can i|have|"
    r"portions?|plates?|packs?|bottles?|pieces?|pcs|servings?|wraps?|of|some|the|a|an|and|with|plus|also|"
    r"for me|to go|delivery|pickup|from)\b"
)
ORDER_HINT = re.compile(r"\b(order|want|like|get|buy|give me|send me|portions?|plates?|bottles?|pieces?)\b", re.IGNORECASE)


@dataclass
class ParsedOrder:
    restaurant: Restaurant | None = None
    lines: list[tuple[MenuItem, int]] = field(default_factory=list)
    unmatched: list[str] = field(default_factory=list)
    other_restaurants: list[str] = field(default_factory=list)  # names that also matched some lines

    @property
    def is_empty(self) -> bool:
        return not self.lines


def _split_chunks(text: str) -> list[str]:
    text = text.replace("\n", ",")
    parts = re.split(r",|;|\band\b|\bplus\b|&|\bwith\b", text)
    return [p.strip() for p in parts if p.strip()]


def _extract_quantity(chunk: str) -> int:
    m = re.search(r"\b(\d+)\s*(?:x|×)?\b", chunk)
    if m:
        return max(1, int(m.group(1)))
    m = re.search(r"\b(" + "|".join(NUMBER_WORDS) + r")\b", chunk)
    return max(1, NUMBER_WORDS[m.group(1)]) if m else 1


def _matches(chunk: str) -> dict[str, MenuItem]:
    """Best matching item per restaurant for this chunk."""
    best: dict[str, tuple[int, MenuItem]] = {}
    for item in MENU:
        for alias in item.all_names:
            if re.search(r"\b" + re.escape(alias) + r"\b", chunk):
                cur = best.get(item.restaurant_id)
                if cur is None or len(alias) > cur[0]:
                    best[item.restaurant_id] = (len(alias), item)
    return {rid: it for rid, (_, it) in best.items()}


def _restaurant_mentioned(text: str) -> Restaurant | None:
    for r in RESTAURANTS:
        if r.name.lower() in text or r.id == text.strip():
            return r
    return None


def looks_like_order(text: str) -> bool:
    if ORDER_HINT.search(text):
        return True
    return bool(_matches(text.lower()))


def parse_order(text: str, preferred_restaurant_id: str | None = None) -> ParsedOrder:
    cleaned = text.lower().replace("’", "'")
    mentioned = _restaurant_mentioned(cleaned)
    chunks = _split_chunks(cleaned)
    per_chunk = [(_matches(c), _extract_quantity(c), c) for c in chunks]

    # choose the restaurant that satisfies the most chunks
    scores: dict[str, int] = {}
    for matches, _, _ in per_chunk:
        for rid in matches:
            scores[rid] = scores.get(rid, 0) + 1
    result = ParsedOrder()
    if not scores:
        for _, _, c in per_chunk:
            leftover = re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", FILLER.sub(" ", c))).strip()
            if leftover and not leftover.isdigit():
                result.unmatched.append(leftover)
        return result

    def rank(rid: str) -> tuple:
        return (
            scores[rid],
            1 if mentioned and mentioned.id == rid else 0,
            1 if preferred_restaurant_id == rid else 0,
            -[r.id for r in RESTAURANTS].index(rid),
        )

    chosen = max(scores, key=rank)
    result.restaurant = get_restaurant(chosen)
    result.other_restaurants = [get_restaurant(r).name for r in scores if r != chosen]
    merged: dict[str, int] = {}
    order: list[MenuItem] = []
    for matches, qty, c in per_chunk:
        item = matches.get(chosen)
        if item is None:
            leftover = re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", FILLER.sub(" ", c))).strip()
            if leftover and not leftover.isdigit() and not (mentioned and mentioned.name.lower() in c):
                result.unmatched.append(leftover)
            continue
        if item.id not in merged:
            order.append(item)
            merged[item.id] = 0
        merged[item.id] += qty
    result.lines = [(item, merged[item.id]) for item in order]
    return result
