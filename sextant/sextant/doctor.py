"""Live self-check: `python -m sextant.doctor`.

Makes one tiny real request to every configured service and prints PASS/FAIL, so you know
exactly which keys and providers work from the machine the bot will run on.
"""
from __future__ import annotations

import asyncio
import sys

import httpx

from .config import load_config
from .db import Database
from .providers.ai import AIRouter, ProviderError, build_providers
from .providers.search import SearchError, build_search_providers
from .providers.search import USER_AGENT
from .research.fetch import Fetcher


async def main() -> int:
    cfg = load_config()
    failures = 0

    def report(ok: bool | None, name: str, detail: str = "") -> None:
        nonlocal failures
        failures += ok is False
        print(f"[{'PASS' if ok else 'SKIP' if ok is None else 'FAIL'}] {name}" + (f" - {detail}" if detail else ""))

    report(bool(cfg.bot_token), "TELEGRAM_BOT_TOKEN set")
    report(bool(cfg.allowed_user_ids), "ALLOWED_USER_IDS set", ", ".join(map(str, sorted(cfg.allowed_user_ids))))
    try:
        db = Database(cfg.db_path)
        db.claim_update(-1)
        report(True, "SQLite database", str(cfg.db_path))
    except Exception as exc:
        report(False, "SQLite database", str(exc))
        return 1

    async with httpx.AsyncClient(timeout=30, headers={"User-Agent": USER_AGENT}, follow_redirects=True) as client:
        if cfg.bot_token:
            try:
                base = cfg.telegram_base_url or "https://api.telegram.org"
                data = (await client.get(f"{base}/bot{cfg.bot_token}/getMe")).json()
                report(bool(data.get("ok")), "Telegram getMe", "@" + data["result"]["username"] if data.get("ok") else str(data.get("description")))
            except Exception as exc:
                report(False, "Telegram getMe", f"{type(exc).__name__}: {exc}")

        providers = build_providers(cfg)
        if not providers:
            report(False, "AI providers", "none configured: set GEMINI_API_KEY or another provider")
        for provider in providers:
            if not provider.supports_text:
                report(None, f"AI {provider.name}", "image text extraction only; not called by the doctor")
                continue
            try:
                result = await provider.generate(client, "Reply with the single word OK.", max_output_tokens=200)
                vision = f", vision via {getattr(provider, 'vision_model', '') or provider.model}" if provider.supports_vision else ", no vision"
                report(True, f"AI {provider.name}", f"model {result.model} replied {result.text.strip()[:20]!r}{vision}")
            except (ProviderError, httpx.HTTPError) as exc:
                report(False, f"AI {provider.name} (model {provider.model})", str(exc)[:220])
        router = AIRouter(cfg, db, providers, client=client)
        report(router.has_vision or None, "Vision capability", "available" if router.has_vision else "no vision-capable provider configured; images cannot be read")

        web, reference = build_search_providers(cfg)
        working_web = 0
        for provider in web + list(reference.values()):
            try:
                results = await provider.search(client, "solar energy companies Nigeria", 3)
                ok = bool(results)
                working_web += ok and provider in web
                report(ok, f"Search {provider.name}", f"{len(results)} results" + (f", first: {results[0].url}" if results else ""))
            except (SearchError, httpx.HTTPError, ValueError, KeyError) as exc:
                report(False, f"Search {provider.name}", str(exc)[:200] or type(exc).__name__)
        if not working_web:
            print("       No general web search provider works from this machine. Add TAVILY_API_KEY, BRAVE_API_KEY or SEARXNG_URL.")

        fetcher = Fetcher(cfg, db, client=client)
        page = await fetcher.fetch("https://en.wikipedia.org/wiki/Solar_power")
        report(page.ok, "Page fetch + text extraction", f"{len(page.text)} characters" if page.ok else page.error)

    db._run("DELETE FROM telegram_updates WHERE update_id=-1")
    db.close()
    print("\nAll checks passed." if not failures else f"\n{failures} check(s) failed. Fix those before relying on the bot.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
