"""Wires the components together. Used by the bot, the one-shot runner, the doctor and the tests."""
from __future__ import annotations

from dataclasses import dataclass

from .config import Config
from .db import Database
from .images import ImageProcessor
from .providers.ai import AIRouter, build_providers
from .providers.search import SearchRouter, build_search_providers
from .research.fetch import Fetcher
from .research.pipeline import Pipeline
from .research.runner import Notifier, Runner


@dataclass
class Services:
    cfg: Config
    db: Database
    ai: AIRouter
    search: SearchRouter
    fetcher: Fetcher
    images: ImageProcessor
    pipeline: Pipeline
    runner: Runner

    async def aclose(self) -> None:
        await self.runner.shutdown()
        await self.ai.aclose()
        await self.search.aclose()
        await self.fetcher.aclose()
        self.db.close()


def build_services(cfg: Config, notifier: Notifier, *, db: Database | None = None, ai: AIRouter | None = None,
                   search: SearchRouter | None = None, fetcher: Fetcher | None = None) -> Services:
    db = db or Database(cfg.db_path)
    ai = ai or AIRouter(cfg, db, build_providers(cfg))
    if search is None:
        web, reference = build_search_providers(cfg)
        search = SearchRouter(cfg, db, web, reference)
    fetcher = fetcher or Fetcher(cfg, db)
    images = ImageProcessor(cfg, db, ai)
    pipeline = Pipeline(cfg, db, ai, search, fetcher)
    runner = Runner(cfg, db, pipeline, images, notifier)
    return Services(cfg, db, ai, search, fetcher, images, pipeline, runner)
