import json

import httpx
import pytest

from conftest import Env, FakeAI, FakeSearch, make_config
from sextant.db import Database
from sextant.providers.ai import (AIRouter, AllProvidersExhausted, Budget, BudgetExceeded, GeminiProvider, ImageInput,
                                  OpenAICompatProvider, ProviderError, RateLimited, build_providers)
from sextant.providers.search import (BraveSearch, DuckDuckGoSearch, SearchError, SearchResult, SearchRouter, WikipediaSearch,
                                      dedupe_results)
from sextant.research.fetch import Fetcher, html_to_page

Q = "Research the solar energy market in Nigeria"


def router(tmp_path, providers, handler=None, **cfg_overrides):
    cfg = make_config(tmp_path, **cfg_overrides)
    db = Database(cfg.db_path)
    sleeps = []

    async def fake_sleep(seconds):
        sleeps.append(seconds)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler)) if handler else httpx.AsyncClient()
    return AIRouter(cfg, db, providers, client=client, sleep=fake_sleep), db, sleeps


# ------------------------------------------------------------- AI failures
async def test_failing_provider_falls_back_to_the_next_one(tmp_path):
    """Acceptance test H (fallback path)."""
    broken, healthy = FakeAI("broken", fail_with=ProviderError("broken: HTTP 500")), FakeAI("healthy")
    env = Env(tmp_path, providers=[broken, healthy])
    task = await env.run(Q)
    assert task["status"] == "COMPLETED"
    assert broken.calls and healthy.kinds()[-1] == "report"
    usage = {u["provider"]: u for u in env.db.usage_summary(0)}
    assert usage["healthy"]["ok"] > 0 and usage["broken"]["ok"] == 0, "both outcomes are tracked per provider"
    await env.close()


async def test_all_providers_exhausted_fails_safely_without_a_report(tmp_path):
    """Acceptance test H (quota path): no partial answer is passed off as research."""
    limited = FakeAI("limited", fail_with=RateLimited("limited: quota reached (HTTP 429)", retry_after=3600))
    env = Env(tmp_path, providers=[limited])
    task = await env.run(Q)
    assert task["status"] == "FAILED" and env.db.get_report(task["id"]) is None
    message = env.notifier.failures[0][1]
    assert "free limit" in message and "Nothing was generated" in message and "limits reset" in message
    assert len(limited.calls) == 1, "a long Retry-After parks the provider instead of hammering it"

    retry = await env.run(Q)  # the failed task does not block a retry, and the provider is still cooling down
    assert retry["id"] != task["id"] and retry["status"] == "FAILED"
    assert len(limited.calls) == 1
    await env.close()


async def test_no_provider_configured(tmp_path):
    env = Env(tmp_path, providers=[])
    task = await env.run(Q)
    assert task["status"] == "FAILED" and "No AI provider is configured" in env.notifier.failures[0][1]
    await env.close()


async def test_rate_limit_backs_off_then_succeeds(tmp_path):
    attempts = []

    def handler(request):
        attempts.append(1)
        if len(attempts) < 3:
            return httpx.Response(429, headers={"retry-after": "2"}, json={"error": "slow down"})
        return httpx.Response(200, json={"choices": [{"message": {"content": "hello"}}], "usage": {"prompt_tokens": 7, "completion_tokens": 2}})

    ai, db, sleeps = router(tmp_path, [OpenAICompatProvider("groq", "https://api.groq.test/v1", "k", "m")], handler)
    result = await ai.generate("hi")
    assert result.text == "hello" and len(attempts) == 3
    assert len(sleeps) == 2 and all(s >= 2 for s in sleeps) and sleeps[1] > sleeps[0], "exponential backoff honouring Retry-After"
    rows = db.usage_summary(0)
    assert rows[0]["requests"] == 3 and rows[0]["ok"] == 1 and rows[0]["prompt_tokens"] == 7


async def test_retries_are_bounded(tmp_path):
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(503, text="overloaded")

    ai, _, _ = router(tmp_path, [OpenAICompatProvider("x", "https://x.test/v1", "k", "m")], handler)
    with pytest.raises(AllProvidersExhausted):
        await ai.generate("hi")
    assert len(calls) == 3, "never an uncontrolled retry loop"


async def test_client_errors_are_not_retried(tmp_path):
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(401, text="bad key")

    ai, _, _ = router(tmp_path, [OpenAICompatProvider("x", "https://x.test/v1", "k", "m")], handler)
    with pytest.raises(AllProvidersExhausted, match="HTTP 401"):
        await ai.generate("hi")
    assert len(calls) == 1
    with pytest.raises(AllProvidersExhausted, match="cooling down"):
        await ai.generate("hi again")
    assert len(calls) == 1, "a provider with a bad key is parked, not called on every step"


async def test_local_daily_budget_stops_requests(tmp_path):
    fake = FakeAI()
    ai, db, _ = router(tmp_path, [fake], ai_daily_request_limit=2)
    await ai.generate("one")
    await ai.generate("two")
    with pytest.raises(AllProvidersExhausted, match="daily budget"):
        await ai.generate("three")
    assert len(fake.calls) == 2


async def test_task_budget_is_enforced(tmp_path):
    ai, _, _ = router(tmp_path, [FakeAI()])
    budget = Budget(max_calls=2, max_tokens=10_000)
    await ai.generate("a", budget=budget)
    await ai.generate("b", budget=budget)
    with pytest.raises(BudgetExceeded):
        await ai.generate("c", budget=budget)
    with pytest.raises(BudgetExceeded):
        await ai.generate("d", budget=Budget(max_calls=5, max_tokens=10, tokens=10))


async def test_vision_requests_skip_text_only_providers(tmp_path):
    text_only, sighted = FakeAI("textonly", vision=False), FakeAI("sighted")
    ai, _, _ = router(tmp_path, [text_only, sighted])
    result = await ai.generate("describe", images=[ImageInput(b"\xff\xd8\xff", "image/jpeg")])
    assert result.provider == "sighted" and not text_only.calls
    ai2, _, _ = router(tmp_path / "b", [text_only])
    with pytest.raises(AllProvidersExhausted, match="vision"):
        await ai2.generate("describe", images=[ImageInput(b"x")])


# ------------------------------------------------- provider wire formats
async def test_gemini_request_and_response_shape(tmp_path):
    seen = {}

    def handler(request):
        seen["url"], seen["key"], seen["body"] = str(request.url), request.headers.get("x-goog-api-key"), json.loads(request.content)
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": '{"ok": true}'}]}, "finishReason": "STOP"}],
                                         "usageMetadata": {"promptTokenCount": 11, "candidatesTokenCount": 4}})

    provider = GeminiProvider("secret", "gemini-test", "https://gen.test/v1beta")
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await provider.generate(client, "look", system="sys", images=[ImageInput(b"\xff\xd8\xffabc", "image/jpeg")], want_json=True)
    assert seen["url"] == "https://gen.test/v1beta/models/gemini-test:generateContent" and seen["key"] == "secret"
    assert "secret" not in seen["url"], "the key travels in a header, never in the URL"
    parts = seen["body"]["contents"][0]["parts"]
    assert parts[0]["inline_data"]["mime_type"] == "image/jpeg" and parts[1]["text"] == "look"
    assert seen["body"]["generationConfig"]["responseMimeType"] == "application/json"
    assert (result.text, result.prompt_tokens, result.completion_tokens) == ('{"ok": true}', 11, 4)


async def test_gemini_blocked_or_empty_reply_is_an_error(tmp_path):
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"promptFeedback": {"blockReason": "SAFETY"}}))) as client:
        with pytest.raises(ProviderError, match="no candidates"):
            await GeminiProvider("k", "m", "https://gen.test").generate(client, "x")


async def test_openai_compatible_vision_payload(tmp_path):
    seen = {}

    def handler(request):
        seen["body"], seen["auth"] = json.loads(request.content), request.headers.get("authorization")
        return httpx.Response(200, json={"choices": [{"message": {"content": "a flyer"}}]})

    provider = OpenAICompatProvider("openrouter", "https://or.test/api/v1", "key", "text-model", "vision-model")
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await provider.generate(client, "what is this", images=[ImageInput(b"\x89PNG", "image/png")])
    assert seen["auth"] == "Bearer key" and seen["body"]["model"] == "vision-model"
    content = seen["body"]["messages"][-1]["content"]
    assert content[0]["type"] == "text" and content[1]["image_url"]["url"].startswith("data:image/png;base64,")


def test_only_configured_providers_are_built_in_order(tmp_path):
    cfg = make_config(tmp_path, gemini_api_key="g", groq_api_key="q", ai_provider_order=["groq", "gemini"])
    names = [p.name for p in build_providers(cfg)]
    assert names == ["groq", "gemini"]
    groq = build_providers(cfg)[0]
    assert groq.supports_text and not groq.supports_vision, "a text model is never assumed to accept images"
    assert build_providers(make_config(tmp_path)) == []


# ------------------------------------------------------------------ search
async def test_search_falls_back_caches_and_normalises(tmp_path):
    cfg = make_config(tmp_path)
    db = Database(cfg.db_path)
    down = FakeSearch("down", error=SearchError("down: HTTP 500"))
    up = FakeSearch("up", results=[
        SearchResult("A", "https://example.com/a?utm_source=news", "s", "up"),
        SearchResult("A again", "http://www.example.com/a/", "s", "up"),
        SearchResult("Not a link", "javascript:alert(1)", "", "up"),
        SearchResult("B", "https://example.com/b", "s", "up"),
    ])
    search = SearchRouter(cfg, db, [down, up], {})
    results, errors = await search.search("Solar Nigeria")
    assert [r.title for r in results] == ["A", "B"], "duplicate and non-http URLs are dropped"
    assert errors == ["down: HTTP 500"]

    again, errors2 = await search.search("  solar   NIGERIA ")
    assert [r.url for r in again] == [r.url for r in results] and errors2 == []
    assert len(up.queries) == 1 and len(down.queries) == 1, "the second identical query is served from cache"
    await search.aclose()


async def test_all_search_providers_failing_returns_errors_not_exceptions(tmp_path):
    cfg = make_config(tmp_path)
    search = SearchRouter(cfg, Database(cfg.db_path), [FakeSearch("a", error=SearchError("a: rate limited (HTTP 429)"))], {})
    results, errors = await search.search("anything")
    assert results == [] and "429" in errors[0]
    await search.aclose()


DDG_HTML = """<html><body>
<div class="result results_links"><h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fsunvolt.example%2Fabout&rut=x">SunVolt <b>Energy</b></a></h2>
<a class="result__snippet">Solar installer in Lagos.</a></div>
<div class="result result--ad"><a class="result__a" href="https://ads.example/x">Ad</a></div>
<div class="result"><a class="result__a" href="https://direct.example/page">Direct</a><a class="result__snippet">Plain link.</a></div>
</body></html>"""


async def test_duckduckgo_html_parsing_and_block_detection():
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, html=DDG_HTML))) as client:
        results = await DuckDuckGoSearch().search(client, "sunvolt", 5)
    assert [(r.title, r.url) for r in results] == [("SunVolt Energy", "https://sunvolt.example/about"), ("Direct", "https://direct.example/page")]
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(202, html="challenge"))) as client:
        with pytest.raises(SearchError, match="challenge"):
            await DuckDuckGoSearch().search(client, "sunvolt", 5)


async def test_brave_and_wikipedia_parsing():
    def handler(request):
        if "brave" in request.url.host:
            assert request.headers["x-subscription-token"] == "bk"
            return httpx.Response(200, json={"web": {"results": [{"title": "T", "url": "https://t.example", "description": "<strong>d</strong>esc", "age": "2 days ago"}]}})
        return httpx.Response(200, json={"query": {"search": [{"title": "Solar power in Nigeria", "snippet": "<span>solar</span> text", "timestamp": "2026-05-01T00:00:00Z"}]}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        brave = await BraveSearch("bk").search(client, "q", 3)
        wiki = await WikipediaSearch().search(client, "q", 3)
    assert (brave[0].url, brave[0].snippet) == ("https://t.example", "desc")
    assert wiki[0].url == "https://en.wikipedia.org/wiki/Solar_power_in_Nigeria" and wiki[0].snippet == "solar text"
    assert dedupe_results(brave + brave) == brave


# ---------------------------------------------------------------- fetching
def test_html_extraction_keeps_content_and_drops_chrome():
    page = html_to_page("https://x.example", "<html><head><title>T</title><meta name='date' content='2026-01-05'></head><body>"
                        "<nav>Home About Contact us today</nav><main><h2>Results</h2><p>Revenue rose 40% to NGN 4.2bn in 2025, the company said.</p></main>"
                        "<script>evil()</script><footer>Copyright notice and other boilerplate</footer></body></html>")
    assert page.title == "T" and page.published == "2026-01-05"
    assert "Revenue rose 40%" in page.text and "evil" not in page.text and "Copyright" not in page.text and "Contact us" not in page.text


async def test_fetcher_refuses_private_addresses_and_respects_robots(tmp_path):
    from conftest import web_handler
    cfg = make_config(tmp_path, allow_private_fetch=False)
    db = Database(cfg.db_path)
    fetcher = Fetcher(cfg, db, client=httpx.AsyncClient(transport=httpx.MockTransport(web_handler)))
    for url in ("http://127.0.0.1:8080/admin", "http://localhost/x", "http://169.254.169.254/latest/meta-data", "file:///etc/passwd", "ftp://x.example/a"):
        page = await fetcher.fetch(url)
        assert not page.ok and page.error, url
    await fetcher.aclose()

    open_cfg = make_config(tmp_path)
    fetcher = Fetcher(open_cfg, db, client=httpx.AsyncClient(transport=httpx.MockTransport(web_handler)))
    assert (await fetcher.fetch("https://blocked.example.com/page")).error == "disallowed by robots.txt"
    ok = await fetcher.fetch("https://news.example.com/story")
    assert ok.ok and ok.published == "2026-02-10" and "menu" not in ok.text
    assert (await fetcher.fetch("https://news.example.com/unreachable")).error == "HTTP 503"
    moved = await fetcher.fetch("https://news.example.com/moved")
    assert moved.ok and "story-final" in moved.text, "ordinary redirects are followed"
    await fetcher.aclose()


async def test_redirect_to_a_private_address_is_refused_before_it_is_contacted(tmp_path):
    from conftest import web_handler
    contacted = []

    def handler(request):
        contacted.append(request.url.host)
        return web_handler(request)

    cfg = make_config(tmp_path, allow_private_fetch=False)
    fetcher = Fetcher(cfg, Database(cfg.db_path), client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))

    async def public_unless_loopback(host):
        return host != "127.0.0.1"

    fetcher._is_public = public_unless_loopback
    page = await fetcher.fetch("https://news.example.com/to-internal")
    assert page.error == "non-public address refused" and "127.0.0.1" not in contacted
    await fetcher.aclose()
