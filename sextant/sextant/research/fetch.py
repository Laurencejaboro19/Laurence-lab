"""Fetch a web page politely and reduce it to readable text.

Safety: http/https only, no private or loopback addresses (search results are untrusted
input), a byte ceiling, HTML/plain text only, and robots.txt is honoured.
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import socket
import urllib.robotparser
from dataclasses import asdict, dataclass
from urllib.parse import urlsplit

import httpx
from bs4 import BeautifulSoup

from ..config import Config
from ..db import Database
from ..providers.search import USER_AGENT
from ..textutil import normalize_url

log = logging.getLogger(__name__)
PAGE_CACHE_SECONDS = 24 * 3600


@dataclass
class Page:
    url: str
    title: str = ""
    text: str = ""
    published: str = ""
    error: str = ""

    @property
    def ok(self) -> bool:
        return not self.error and len(self.text) >= 200


def html_to_page(url: str, html: str) -> Page:
    soup = BeautifulSoup(html, "html.parser")
    published = ""
    for attrs in ({"property": "article:published_time"}, {"name": "date"}, {"name": "pubdate"},
                  {"itemprop": "datePublished"}, {"property": "og:updated_time"}, {"name": "last-modified"}):
        tag = soup.find("meta", attrs=attrs)
        if tag and tag.get("content"):
            published = tag["content"].strip()[:10]
            break
    if not published:
        time_tag = soup.find("time", attrs={"datetime": True})
        if time_tag:
            published = time_tag["datetime"].strip()[:10]
    title = soup.title.get_text(" ", strip=True) if soup.title else ""
    for tag in soup(["script", "style", "noscript", "svg", "nav", "footer", "header", "aside", "form", "iframe", "button"]):
        tag.decompose()
    root = soup.find("article") or soup.find("main") or soup.body or soup
    blocks, seen = [], set()
    for el in root.find_all(["h1", "h2", "h3", "p", "li", "td", "th", "blockquote"]):
        text = el.get_text(" ", strip=True)
        if len(text) < 25 and el.name not in ("h1", "h2", "h3", "td", "th"):
            continue
        if text and text not in seen:
            seen.add(text)
            blocks.append(text)
    text = "\n".join(blocks) or root.get_text("\n", strip=True)
    return Page(url=url, title=title[:300], text=text, published=published)


class Fetcher:
    def __init__(self, cfg: Config, db: Database, client: httpx.AsyncClient | None = None):
        self.cfg, self.db = cfg, db
        self.client = client or httpx.AsyncClient(
            timeout=cfg.http_timeout, headers={"User-Agent": USER_AGENT, "Accept": "text/html,text/plain;q=0.9"},
            follow_redirects=True, max_redirects=4,
        )
        self._robots: dict[str, urllib.robotparser.RobotFileParser | None] = {}
        self._sem = asyncio.Semaphore(4)

    async def aclose(self) -> None:
        await self.client.aclose()

    async def _is_public(self, host: str) -> bool:
        if self.cfg.allow_private_fetch:
            return True
        try:
            infos = await asyncio.get_running_loop().getaddrinfo(host, None, type=socket.SOCK_STREAM)
        except OSError:
            return False
        return bool(infos) and all(ipaddress.ip_address(info[4][0]).is_global for info in infos)

    async def _allowed_by_robots(self, url: str) -> bool:
        if not self.cfg.respect_robots:
            return True
        parts = urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        if origin not in self._robots:
            parser: urllib.robotparser.RobotFileParser | None = urllib.robotparser.RobotFileParser()
            try:
                response = await self.client.get(origin + "/robots.txt", timeout=8)
                if response.status_code in (401, 403):
                    parser.parse(["User-agent: *", "Disallow: /"])
                elif response.status_code >= 400:
                    parser = None  # no robots.txt: everything allowed
                else:
                    parser.parse(response.text.splitlines())
            except httpx.HTTPError:
                parser = None
            self._robots[origin] = parser
        parser = self._robots[origin]
        return True if parser is None else parser.can_fetch(USER_AGENT, url)

    async def fetch(self, url: str) -> Page:
        key = normalize_url(url)
        cached = self.db.cache_get("page_cache", key, PAGE_CACHE_SECONDS)
        if cached is not None:
            return Page(**json.loads(cached))
        async with self._sem:
            page = await self._fetch(url)
        if page.ok:
            self.db.cache_put("page_cache", key, json.dumps(asdict(page)))
        return page

    async def _fetch(self, url: str) -> Page:
        current = url
        try:
            for _hop in range(5):  # follow redirects by hand so every hop is checked before it is contacted
                parts = urlsplit(current)
                if parts.scheme not in ("http", "https") or not parts.hostname:
                    return Page(url, error="unsupported URL")
                if not await self._is_public(parts.hostname):
                    return Page(url, error="non-public address refused")
                if not await self._allowed_by_robots(current):
                    return Page(url, error="disallowed by robots.txt")
                async with self.client.stream("GET", current, follow_redirects=False) as response:
                    if response.is_redirect and response.headers.get("location"):
                        current = str(response.url.join(response.headers["location"]))
                        continue
                    if response.status_code >= 400:
                        return Page(url, error=f"HTTP {response.status_code}")
                    ctype = response.headers.get("content-type", "").lower()
                    if not any(t in ctype for t in ("text/html", "text/plain", "application/xhtml")):
                        return Page(url, error=f"unsupported content type ({ctype.split(';')[0] or 'unknown'})")
                    chunks, size = [], 0
                    async for chunk in response.aiter_bytes():
                        chunks.append(chunk)
                        size += len(chunk)
                        if size >= self.cfg.max_page_bytes:
                            break
                    raw = b"".join(chunks)[: self.cfg.max_page_bytes]
                    body = raw.decode(response.encoding or "utf-8", errors="replace")
                break
            else:
                return Page(url, error="too many redirects")
        except httpx.HTTPError as exc:
            return Page(url, error=f"{type(exc).__name__}")
        page = html_to_page(url, body) if "html" in ctype else Page(url, text=body)
        if len(page.text) < 200:
            page.error = "page had no readable text (may require JavaScript or a login)"
        return page
