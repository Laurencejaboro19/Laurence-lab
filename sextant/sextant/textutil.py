"""Small pure helpers: normalisation, fingerprints, tokens, URLs, JSON salvage."""
from __future__ import annotations

import hashlib
import json
import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

STOPWORDS = frozenset(
    """a an and are as at be been but by can could do does for from had has have how i if in into is it its
    me my of on or our should so than that the their them then there these they this to up was we were what
    when where which who why will with would you your about research investigate identify find analyse analyze
    look report please tell give show information details company market industry business""".split()
)

_TRACKING = re.compile(r"^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|ref_src$|igshid$)")


def normalize_question(text: str) -> str:
    """Case, spacing and trailing punctuation must not make a request 'new'."""
    text = re.sub(r"\s+", " ", (text or "").strip().lower())
    return text.strip(" .?!")


def fingerprint(question: str, task_context: str = "", image_keys: list[str] | None = None, salt: str = "") -> str:
    parts = [normalize_question(question), normalize_question(task_context), ",".join(sorted(image_keys or [])), salt]
    return hashlib.sha256("\x1f".join(parts).encode()).hexdigest()


def tokens(text: str) -> set[str]:
    """Meaningful lower-case words, lightly stemmed so 'partners' matches 'partnership'."""
    out = set()
    for word in re.findall(r"[a-z0-9][a-z0-9\-]{2,}", (text or "").lower()):
        if word in STOPWORDS:
            continue
        out.add(word[:6] if len(word) > 6 else word.rstrip("s") or word)
    return out


def normalize_url(url: str) -> str:
    """Canonical form for duplicate detection (not for display)."""
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return url.strip()
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return url.strip()
    host = parts.netloc.lower()
    if host.startswith("www."):
        host = host[4:]
    query = urlencode([(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if not _TRACKING.match(k.lower())])
    path = re.sub(r"/+$", "", parts.path) or "/"
    return urlunsplit(("https", host, path, query, ""))


def domain_of(url: str) -> str:
    try:
        host = urlsplit(url).netloc.lower().split("@")[-1].split(":")[0]
    except ValueError:
        return ""
    return host[4:] if host.startswith("www.") else host


def registered_domain(url_or_host: str) -> str:
    """Approximate eTLD+1 without a public-suffix list (good enough for grouping)."""
    host = domain_of(url_or_host) if "//" in url_or_host else url_or_host.lower()
    labels = host.split(".")
    if len(labels) <= 2:
        return host
    two_level = {"co", "com", "org", "gov", "edu", "ac", "net"}
    return ".".join(labels[-3:]) if labels[-2] in two_level and len(labels[-1]) == 2 else ".".join(labels[-2:])


def extract_json(text: str):
    """Parse the first JSON object/array in a model reply, tolerating code fences and chatter."""
    if not text:
        raise ValueError("empty model reply")
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.I | re.M)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass
    decoder = json.JSONDecoder()
    for match in re.finditer(r"[\{\[]", cleaned):
        try:
            value, _ = decoder.raw_decode(cleaned[match.start():])
            return value
        except json.JSONDecodeError:
            continue
    raise ValueError("no JSON found in model reply")


def clip(text: str, limit: int) -> str:
    text = text or ""
    return text if len(text) <= limit else text[: max(0, limit - 1)].rstrip() + "…"


def research_id(task_id: int) -> str:
    return f"R-{task_id:05d}"


def parse_research_id(raw: str) -> int | None:
    match = re.fullmatch(r"\s*(?:R-?)?0*(\d{1,9})\s*", raw or "", flags=re.I)
    return int(match.group(1)) if match else None
