"""Search provider abstraction with caching, fallback and result normalisation.

Web providers (tried in SEARCH_PROVIDER_ORDER until one returns results):
  brave, tavily, searxng, duckduckgo
Reference providers (always available, no key): wikipedia, openalex (academic papers)
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import asdict, dataclass
from urllib.parse import parse_qs, urlsplit

import httpx
from bs4 import BeautifulSoup

from ..config import Config
from ..db import Database
from ..textutil import normalize_question, normalize_url

log = logging.getLogger(__name__)
USER_AGENT = "SextantResearchBot/1.0 (personal research assistant)"


class SearchError(Exception):
    pass


@dataclass
class SearchResult:
    title: str
    url: str
    snippet: str = ""
    provider: str = ""
    published: str = ""


class SearchProvider:
    name = "base"

    async def search(self, client: httpx.AsyncClient, query: str, max_results: int) -> list[SearchResult]:
        raise NotImplementedError

    def _check(self, response: httpx.Response) -> None:
        if response.status_code == 429:
            raise SearchError(f"{self.name}: rate limited (HTTP 429)")
        if response.status_code >= 400:
            raise SearchError(f"{self.name}: HTTP {response.status_code}")


class BraveSearch(SearchProvider):
    name = "brave"

    def __init__(self, api_key: str):
        self.api_key = api_key

    async def search(self, client, query, max_results):
        response = await client.get(
            "https://api.search.brave.com/res/v1/web/search",
            params={"q": query, "count": max_results},
            headers={"X-Subscription-Token": self.api_key, "Accept": "application/json"},
        )
        self._check(response)
        items = (response.json().get("web") or {}).get("results") or []
        return [SearchResult(i.get("title", ""), i.get("url", ""), _strip_html(i.get("description", "")), self.name,
                             i.get("page_age") or i.get("age") or "") for i in items]


class TavilySearch(SearchProvider):
    name = "tavily"

    def __init__(self, api_key: str):
        self.api_key = api_key

    async def search(self, client, query, max_results):
        response = await client.post(
            "https://api.tavily.com/search",
            json={"query": query, "max_results": max_results, "search_depth": "basic"},
            headers={"Authorization": f"Bearer {self.api_key}"},
        )
        self._check(response)
        return [SearchResult(i.get("title", ""), i.get("url", ""), i.get("content", ""), self.name, i.get("published_date") or "")
                for i in response.json().get("results") or []]


class SearxngSearch(SearchProvider):
    """A SearXNG instance you run yourself (JSON output must be enabled in its settings)."""

    name = "searxng"

    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")

    async def search(self, client, query, max_results):
        response = await client.get(f"{self.base_url}/search", params={"q": query, "format": "json"})
        self._check(response)
        return [SearchResult(i.get("title", ""), i.get("url", ""), i.get("content", ""), self.name, i.get("publishedDate") or "")
                for i in (response.json().get("results") or [])[:max_results]]


class DuckDuckGoSearch(SearchProvider):
    """Keyless fallback using DuckDuckGo's HTML endpoint. Unofficial and best-effort:
    DuckDuckGo has no search API and may answer datacentre IPs with a challenge page."""

    name = "duckduckgo"
    endpoint = "https://html.duckduckgo.com/html/"

    async def search(self, client, query, max_results):
        response = await client.post(self.endpoint, data={"q": query}, headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Sextant/1.0"})
        if response.status_code == 202:
            raise SearchError("duckduckgo: blocked with a challenge page (HTTP 202)")
        self._check(response)
        soup = BeautifulSoup(response.text, "html.parser")
        results = []
        for block in soup.select("div.result"):
            link = block.select_one("a.result__a")
            if not link or not link.get("href") or "result--ad" in (block.get("class") or []):
                continue
            url = _unwrap_ddg(link["href"])
            if not url.startswith("http"):
                continue
            snippet = block.select_one(".result__snippet")
            results.append(SearchResult(link.get_text(" ", strip=True), url, snippet.get_text(" ", strip=True) if snippet else "", self.name))
            if len(results) >= max_results:
                break
        if not results and "anomaly" in response.text.lower():
            raise SearchError("duckduckgo: blocked with a challenge page")
        return results


class WikipediaSearch(SearchProvider):
    name = "wikipedia"

    async def search(self, client, query, max_results):
        response = await client.get(
            "https://en.wikipedia.org/w/api.php",
            params={"action": "query", "list": "search", "srsearch": query, "srlimit": min(max_results, 3), "format": "json"},
        )
        self._check(response)
        return [
            SearchResult(i["title"], "https://en.wikipedia.org/wiki/" + i["title"].replace(" ", "_"), _strip_html(i.get("snippet", "")),
                         self.name, (i.get("timestamp") or "")[:10])
            for i in (response.json().get("query") or {}).get("search") or []
        ]


class OpenAlexSearch(SearchProvider):
    """Scholarly works (papers, reports) from the free OpenAlex index."""

    name = "openalex"

    async def search(self, client, query, max_results):
        response = await client.get("https://api.openalex.org/works", params={"search": query, "per-page": min(max_results, 5)})
        self._check(response)
        results = []
        for work in response.json().get("results") or []:
            location = work.get("primary_location") or {}
            url = (work.get("open_access") or {}).get("oa_url") or location.get("landing_page_url") or work.get("doi") or ""
            if not url:
                continue
            venue = (location.get("source") or {}).get("display_name") or ""
            results.append(SearchResult(work.get("title") or "", url, _abstract(work.get("abstract_inverted_index")) or venue, self.name,
                                        work.get("publication_date") or ""))
        return results


def _strip_html(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", text or "")).strip()


def _unwrap_ddg(href: str) -> str:
    if href.startswith("//"):
        href = "https:" + href
    parts = urlsplit(href)
    if "duckduckgo.com" in parts.netloc and parts.path.startswith("/l/"):
        return parse_qs(parts.query).get("uddg", [""])[0]
    return href


def _abstract(inverted: dict | None, limit: int = 600) -> str:
    if not inverted:
        return ""
    positions = sorted((pos, word) for word, places in inverted.items() for pos in places)
    return " ".join(word for _, word in positions)[:limit]


def build_search_providers(cfg: Config) -> tuple[list[SearchProvider], dict[str, SearchProvider]]:
    available: dict[str, SearchProvider] = {"duckduckgo": DuckDuckGoSearch()}
    if cfg.brave_api_key:
        available["brave"] = BraveSearch(cfg.brave_api_key)
    if cfg.tavily_api_key:
        available["tavily"] = TavilySearch(cfg.tavily_api_key)
    if cfg.searxng_url:
        available["searxng"] = SearxngSearch(cfg.searxng_url)
    web = [available[name] for name in cfg.search_provider_order if name in available]
    reference = {"encyclopedia": WikipediaSearch(), "academic": OpenAlexSearch()}
    return web, reference


class SearchRouter:
    def __init__(self, cfg: Config, db: Database, web: list[SearchProvider], reference: dict[str, SearchProvider] | None = None,
                 client: httpx.AsyncClient | None = None):
        self.cfg, self.db, self.web, self.reference = cfg, db, web, reference or {}
        self.client = client or httpx.AsyncClient(timeout=cfg.http_timeout, headers={"User-Agent": USER_AGENT}, follow_redirects=True)

    async def aclose(self) -> None:
        await self.client.aclose()

    def describe(self) -> str:
        return ", ".join([p.name for p in self.web] + [p.name for p in self.reference.values()]) or "none"

    async def search(self, query: str, kind: str = "web", task_id: int | None = None) -> tuple[list[SearchResult], list[str]]:
        """Returns (normalised de-duplicated results, error notes). Never raises."""
        kind = kind if kind in ("web", "encyclopedia", "academic") else "web"
        key = f"{kind}|{normalize_question(query)}"
        cached = self.db.cache_get("search_cache", key, self.cfg.search_cache_hours * 3600)
        if cached is not None:
            return [SearchResult(**item) for item in json.loads(cached)], []

        providers = [self.reference[kind]] if kind in self.reference else list(self.web)
        errors: list[str] = []
        results: list[SearchResult] = []
        for provider in providers:
            try:
                found = await provider.search(self.client, query, self.cfg.search_results_per_query)
            except (SearchError, httpx.HTTPError, ValueError, KeyError) as exc:
                message = str(exc) or type(exc).__name__
                errors.append(message if message.startswith(provider.name) else f"{provider.name}: {message}")
                self.db.log_usage(provider.name, "search", task_id=task_id, ok=False, error=message)
                continue
            self.db.log_usage(provider.name, "search", task_id=task_id)
            results = dedupe_results(found)
            if results:
                break
        if results:
            self.db.cache_put("search_cache", key, json.dumps([asdict(r) for r in results]))
        return results, errors


def dedupe_results(results: list[SearchResult], seen: set[str] | None = None) -> list[SearchResult]:
    """Drop repeated URLs (after normalisation) and non-http links. `seen` carries state across queries."""
    seen = seen if seen is not None else set()
    unique = []
    for result in results:
        if not result.url.startswith(("http://", "https://")):
            continue
        key = normalize_url(result.url)
        if key in seen:
            continue
        seen.add(key)
        unique.append(result)
    return unique
