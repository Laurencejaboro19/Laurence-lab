"""Shared fakes. No test touches the network or needs a credential."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sextant.config import Config  # noqa: E402
from sextant.db import Database  # noqa: E402
from sextant.providers.ai import AIProvider, AIResult, AIRouter, ProviderError, RateLimited  # noqa: E402
from sextant.providers.search import SearchProvider, SearchResult, SearchRouter  # noqa: E402
from sextant.research.fetch import Fetcher  # noqa: E402
from sextant.research.runner import Notifier  # noqa: E402
from sextant.services import build_services  # noqa: E402

USER = 1001
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
PNG = b"\x89PNG\r\n\x1a\n" + b"\x01" * 64

VISION_REPLIES = {
    "default": {
        "image_type": "advertisement", "summary": "A flyer for SunVolt Energy, a solar installer in Lagos.",
        "visible_text": "SunVolt Energy\nSolar installation & inverters\nCall 0803 000 0000\nwww.sunvolt.example",
        "organisations": ["SunVolt Energy"], "people": [], "products": ["solar installation", "inverters"],
        "locations": ["Lagos"], "contacts": ["0803 000 0000", "www.sunvolt.example"], "figures": [],
        "research_leads": ["SunVolt Energy Lagos solar installer"],
    },
}


class FakeAI(AIProvider):
    """Scripted model: answers each pipeline prompt with well-formed output and records every call."""

    supports_vision = True

    def __init__(self, name="fake", fail_with: Exception | None = None, vision=True):
        self.name, self.model = name, f"{name}-model"
        self.fail_with = fail_with
        self.supports_vision = vision
        self.calls: list[dict] = []
        self.vision_reply = dict(VISION_REPLIES["default"])
        self.vision_by_size: dict[int, dict] = {}
        self.plan_queries = ["nigeria solar market size", "solar installers lagos", "solar partnership opportunities nigeria",
                             "nigeria solar import regulations", "solar financing nigeria", "off-grid solar competitors nigeria"]
        self.bad_json_for: set[str] = set()

    def kinds(self) -> list[str]:
        return [c["kind"] for c in self.calls]

    async def generate(self, client, prompt, *, system="", images=None, want_json=False, max_output_tokens=4096):
        if images:
            kind = "vision"
        elif prompt.startswith("Plan a research task"):
            kind = "plan"
        elif prompt.startswith("Extract evidence"):
            kind = "extract"
        elif prompt.startswith("Review research progress"):
            kind = "gaps"
        elif prompt.startswith("Write an intelligence report"):
            kind = "report"
        else:
            kind = "other"
        self.calls.append({"kind": kind, "prompt": prompt, "system": system, "images": images})
        if self.fail_with:
            raise self.fail_with
        if kind in self.bad_json_for:
            return AIResult("this is not json at all", self.name, self.model, 10, 5)
        if kind == "vision":
            reply = self.vision_by_size.get(len(images[0].data), self.vision_reply)
            return AIResult(json.dumps(reply), self.name, self.model, 300, 120)
        if kind == "plan":
            queries = list(self.plan_queries)
            if "SunVolt" in prompt:
                queries = ["SunVolt Energy Lagos company profile", "SunVolt Energy competitors solar Lagos"] + queries
            n = int(re.search(r"Exactly (\d+) queries", prompt).group(1))
            used = re.findall(r"^(C\d+) \[", prompt, flags=re.M)
            plan = {
                "title": "Nigeria Solar Opportunities", "objective": "Find actionable solar opportunities in Nigeria",
                "entities": ["Nigeria", "solar"], "geography": "Nigeria", "time_sensitivity": "last 2 years",
                "decision_focus": "whether and how to enter the market",
                "objectives": [{"id": "O1", "text": "Market size and growth"}, {"id": "O2", "text": "Key players and partners"}],
                "queries": [{"q": q, "objective": "O1", "kind": "web"} for q in queries[:n]],
                "official_domains": ["rea.gov.ng"], "context_used": used, "assumptions": ["Focus on commercial segment"],
            }
            return AIResult("```json\n" + json.dumps(plan) + "\n```", self.name, self.model, 800, 300)
        if kind == "extract":
            items = []
            for n, url in re.findall(r"--- SOURCE (\d+) ---\nURL: (\S+)", prompt):
                origin = "Big Agency Report" if "repost" in url else ""
                items.append({"n": int(n), "relevant": "irrelevant" not in url,
                              "source_type": "primary" if ".gov" in url else "secondary", "publisher": "Pub",
                              "published": "2026-03-01", "original_source": origin,
                              "facts": [] if "irrelevant" in url else [{"claim": f"Fact drawn from {url}", "quote": "installed capacity grew", "date": "2026"}]})
            return AIResult(json.dumps({"sources": items}), self.name, self.model, 2000, 400)
        if kind == "gaps":
            return AIResult(json.dumps({"coverage": [{"objective": "O1", "status": "covered"}, {"objective": "O2", "status": "partial", "note": "few partner names"}],
                                        "enough": False, "followup_queries": [{"q": "nigeria solar distributor list", "objective": "O2", "kind": "web"}]}),
                            self.name, self.model, 900, 150)
        if kind == "report":
            tags = re.findall(r"^\[S(\d+)\]", prompt, flags=re.M)
            first = tags[0] if tags else "1"
            body = (f"## 1. EXECUTIVE SUMMARY\nThe market is growing quickly [S{first}]. A made-up citation follows [S99].\n\n"
                    f"## 3. KEY FINDINGS\n- Capacity grew [S{first}][S{tags[-1] if tags else '1'}]\n\n"
                    "## 5. OPPORTUNITIES\n- Partner with installers. This suggests room for distributors.\n\n"
                    "## 9. RECOMMENDATIONS\n- Contact two installers.\n"
                    "=====CONFIDENCE=====\nModerate confidence; partner data is thin.\n"
                    "=====CONTEXT=====\nPartnership objectives steered the research towards installers.")
            return AIResult(body, self.name, self.model, 3000, 600)
        return AIResult("OK", self.name, self.model, 5, 1)


class FakeSearch(SearchProvider):
    def __init__(self, name="fakesearch", results=None, error: Exception | None = None):
        self.name, self.error = name, error
        self.queries: list[str] = []
        self.results = results

    async def search(self, client, query, max_results):
        self.queries.append(query)
        if self.error:
            raise self.error
        if self.results is not None:
            return list(self.results)
        slug = re.sub(r"[^a-z0-9]+", "-", query.lower()).strip("-")
        return [
            SearchResult(f"Result A for {query}", f"https://news.example.com/{slug}-a", "Snippet A about solar", self.name),
            SearchResult(f"Official data {query}", f"https://rea.gov.ng/{slug}", "Official statistics on solar", self.name),
            SearchResult(f"Repost {query}", f"https://blog.example.org/repost-{slug}?utm_source=x", "Reposted report", self.name),
        ]


class RecordingNotifier(Notifier):
    def __init__(self):
        self.progress_msgs, self.completed_ids, self.failures = [], [], []

    async def progress(self, task, text):
        self.progress_msgs.append((task["id"], text))

    async def completed(self, task):
        self.completed_ids.append(task["id"])

    async def failed(self, task, message):
        self.failures.append((task["id"], message))


def page_html(url: str) -> str:
    body = " ".join(f"Sentence {i} about the Nigerian solar market taken from {url}." for i in range(30))
    return (f"<html><head><title>Page {url}</title><meta property='article:published_time' content='2026-02-10T08:00:00Z'>"
            f"</head><body><nav>menu</nav><article><h1>Solar report</h1><p>{body}</p></article><script>x()</script></body></html>")


def web_handler(request: httpx.Request) -> httpx.Response:
    if request.url.path == "/robots.txt":
        if request.url.host == "blocked.example.com":
            return httpx.Response(200, text="User-agent: *\nDisallow: /")
        return httpx.Response(404)
    if request.url.path == "/moved":
        return httpx.Response(302, headers={"location": "/story-final"})
    if request.url.path == "/to-internal":
        return httpx.Response(302, headers={"location": "http://127.0.0.1:9/secret"})
    if "unreachable" in str(request.url):
        return httpx.Response(503)
    return httpx.Response(200, html=page_html(str(request.url)))


def make_config(tmp_path, **overrides) -> Config:
    values = dict(bot_token="123:TEST", allowed_user_ids=frozenset({USER}), data_dir=Path(tmp_path), ai_min_interval=0.0,
                  attach_window=0.0, heartbeat_seconds=0.05, allow_private_fetch=True, ai_max_retries=3)
    values.update(overrides)
    return Config(**values)


async def no_sleep(_seconds):
    return None


class Env:
    """A fully wired application with fake model, fake search and a mocked web."""

    def __init__(self, tmp_path, *, providers=None, web=None, cfg=None, db=None):
        self.cfg = cfg or make_config(tmp_path)
        self.db = db or Database(self.cfg.db_path)
        self.ai_fake = FakeAI()
        self.providers = providers if providers is not None else [self.ai_fake]
        self.search_fake = FakeSearch()
        self.web = web if web is not None else [self.search_fake]
        self.notifier = RecordingNotifier()
        self.ai = AIRouter(self.cfg, self.db, self.providers, client=httpx.AsyncClient(), sleep=no_sleep)
        self.search = SearchRouter(self.cfg, self.db, self.web, {}, client=httpx.AsyncClient())
        self.fetcher = Fetcher(self.cfg, self.db, client=httpx.AsyncClient(transport=httpx.MockTransport(web_handler), follow_redirects=True))
        self.svc = build_services(self.cfg, self.notifier, db=self.db, ai=self.ai, search=self.search, fetcher=self.fetcher)
        self.runner = self.svc.runner
        self.db.upsert_user(USER, "tester", USER)

    def submit(self, question="Research the solar energy market in Nigeria", **kw):
        return self.runner.submit(user_id=USER, chat_id=USER, question=question, **kw)

    async def run(self, question="Research the solar energy market in Nigeria", **kw):
        result = self.submit(question, **kw)
        await self.runner.wait_idle(20)
        return self.db.get_task(result.task["id"]) if result.task else None

    def add_image(self, data=JPEG, unique="uniq1"):
        image_id = self.svc.images.register(USER, f"file-{unique}", unique, "image/jpeg", len(data))
        self.svc.images.ingest(image_id, data)
        return image_id

    async def close(self):
        await self.runner.shutdown()
        await self.ai.aclose()
        await self.search.aclose()
        await self.fetcher.aclose()


@pytest.fixture
async def env(tmp_path):
    e = Env(tmp_path)
    yield e
    await e.close()
    e.db.close()


__all__ = ["Env", "FakeAI", "FakeSearch", "RecordingNotifier", "USER", "JPEG", "PNG", "make_config", "no_sleep",
           "web_handler", "ProviderError", "RateLimited"]
