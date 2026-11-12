"""End-to-end through the real python-telegram-bot application against a fake Bot API server.
Only the model, the search engine and the web are faked."""
import asyncio
import time

import httpx
import pytest

from conftest import JPEG, USER, FakeAI, FakeSearch, make_config, no_sleep, web_handler
from fake_telegram import FakeTelegram
from sextant.bot.app import SextantBot
from sextant.bot.formatting import md_to_html, split_message
from sextant.db import Database
from sextant.providers.ai import AIRouter
from sextant.providers.search import SearchRouter
from sextant.research.fetch import Fetcher

STRANGER = 666
Q = "Research the solar energy market in Nigeria"


class Harness:
    def __init__(self, tmp_path, monkeypatch, first_update_id=1000, **cfg_overrides):
        monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
        monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
        self.tmp_path = tmp_path
        self.tg = FakeTelegram(JPEG, first_update_id)
        self.cfg = make_config(tmp_path, telegram_base_url=self.tg.url, **cfg_overrides)
        self.fake_ai, self.fake_search = FakeAI(), FakeSearch()

    async def start(self):
        db = Database(self.cfg.db_path)
        self.bot = SextantBot(
            self.cfg, db=db,
            ai=AIRouter(self.cfg, db, [self.fake_ai], client=httpx.AsyncClient(), sleep=no_sleep),
            search=SearchRouter(self.cfg, db, [self.fake_search], {}, client=httpx.AsyncClient()),
            fetcher=Fetcher(self.cfg, db, client=httpx.AsyncClient(transport=httpx.MockTransport(web_handler))),
        )
        self.db = db
        self.app = self.bot.build()
        await self.app.initialize()
        await self.app.post_init(self.app)
        await self.app.start()
        await self.app.updater.start_polling(poll_interval=0.0, timeout=1)

    async def stop(self):
        await self.app.updater.stop()
        await self.app.stop()
        await self.app.post_stop(self.app)
        await self.app.shutdown()

    async def until(self, predicate, timeout=15.0, what="condition"):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            await asyncio.sleep(0.05)
        raise AssertionError(f"timed out waiting for {what}. Bot said: {self.tg.texts()[-6:]}")

    def said(self, fragment, chat_id=USER):
        return any(fragment in t for t in self.tg.texts(chat_id))

    async def settle(self):
        """Wait until every queued update is consumed and no research is running."""
        await self.until(lambda: not self.tg.updates, what="updates to be consumed")
        await asyncio.sleep(0.15)
        await self.bot.runner.wait_idle(15)


@pytest.fixture
async def h(tmp_path, monkeypatch):
    harness = Harness(tmp_path, monkeypatch)
    await harness.start()
    yield harness
    await harness.stop()
    harness.tg.close()


async def test_a_b_g_research_then_duplicate_then_history(h):
    # A: a question through Telegram produces a delivered report
    h.tg.send_text(USER, f"/search {Q}")
    await h.until(lambda: h.said("12. HOW YOUR CONTEXT INFLUENCED THIS RESEARCH"), what="the report")
    assert h.said("Research request received") and h.said("Research completed")
    assert h.said('<a href="https://rea.gov.ng/'), "sources are clickable links"
    last = h.tg.sent()[-1]
    assert "View sources" in last["reply_markup"] and "Save context" in last["reply_markup"] and "Related research" in last["reply_markup"]
    calls = len(h.fake_ai.calls)

    # B: the same request again returns the stored report
    h.tg.send_text(USER, f"/search {Q.lower()}?")
    await h.until(lambda: h.said("You already have a report for this request"), what="the duplicate notice")
    await h.settle()
    assert len(h.fake_ai.calls) == calls and len(h.db.list_tasks(USER)) == 1

    # G: /history, /recent, /view and the Sources button are database reads
    before = len(h.tg.texts(USER))
    h.tg.send_text(USER, "/history")
    h.tg.send_text(USER, "/recent")
    h.tg.send_text(USER, "/view R-00001")
    h.tg.press(USER, "s:1")
    await h.until(lambda: h.said("Sources for R-00001"), what="the sources list")
    await h.settle()
    new = "\n".join(h.tg.texts(USER)[before:])
    assert "Research history" in new and "Recently completed" in new and "EXECUTIVE SUMMARY" in new
    assert len(h.fake_ai.calls) == calls and len(h.fake_search.queries) == len(set(h.fake_search.queries))

    # explicit fresh research is honoured, once
    h.tg.press(USER, "x:1")
    await h.until(lambda: len(h.db.list_tasks(USER, status="COMPLETED")) == 2, what="the fresh run")
    assert len(h.fake_ai.calls) > calls


async def test_c_report_survives_application_restart(tmp_path, monkeypatch):
    first = Harness(tmp_path, monkeypatch)
    await first.start()
    first.tg.send_text(USER, f"/search {Q}")
    await first.until(lambda: first.said("Research completed"), what="the first report")
    await first.settle()
    await first.stop()
    first.tg.close()

    second = Harness(tmp_path, monkeypatch, first_update_id=2000)  # same data directory, brand-new process state
    await second.start()
    second.tg.send_text(USER, "/view R-00001")
    await second.until(lambda: second.said("EXECUTIVE SUMMARY"), what="the stored report after restart")
    second.tg.send_text(USER, f"/search {Q}")
    await second.until(lambda: second.said("You already have a report"), what="duplicate detection after restart")
    assert second.fake_ai.calls == []
    await second.stop()
    second.tg.close()


async def test_duplicate_telegram_update_is_processed_once(h):
    update_id = h.tg.send_text(USER, f"/search {Q}")
    await h.until(lambda: h.said("Research completed"), what="the report")
    await h.settle()
    replies = len(h.tg.texts(USER))
    h.tg.send_text(USER, f"/search {Q}", update_id=update_id + 0)  # Telegram redelivers the very same update
    h.tg.updates[-1]["update_id"] = update_id
    with h.tg.lock:
        h.tg.updates[-1]["_sticky"] = True  # delivered regardless of the polling offset, like a webhook retry
    await asyncio.sleep(0.8)
    with h.tg.lock:
        h.tg.updates.clear()
    assert len(h.tg.texts(USER)) == replies, "a redelivered update produces no reply and no work"
    assert len(h.db.list_tasks(USER)) == 1


async def test_i_unauthorised_user_is_denied(h):
    h.tg.send_text(STRANGER, f"/search {Q}")
    h.tg.send_text(STRANGER, "/history")
    h.tg.send_photo(STRANGER, "strangerpic", caption="investigate this")
    await h.until(lambda: h.said("Access denied", STRANGER), what="the denial")
    await h.settle()
    assert len(h.tg.texts(STRANGER)) == 1, "one denial, then silence"
    assert h.fake_ai.calls == [] and h.fake_search.queries == []
    assert h.db.get_user(STRANGER) is None and h.db.list_tasks(STRANGER) == []
    assert h.tg.sent("getFile") == [], "an unauthorised image is never downloaded"


async def test_d_context_commands_and_context_aware_research(h):
    h.tg.send_text(USER, "/setcontext objectives: identify commercial partners and potential clients")
    h.tg.send_text(USER, "/setcontext I prefer primary sources")
    await h.until(lambda: h.said("File it under a more specific category?"), what="context saved")
    h.tg.press(USER, "cat:2:preferences")
    h.tg.send_text(USER, "/context")
    await h.until(lambda: h.said("Research preferences"), what="the context listing")
    assert [r["category"] for r in h.db.list_context(USER)] == ["objectives", "preferences"]

    h.tg.send_text(USER, f"/search {Q}")
    await h.until(lambda: h.said("Research completed"), what="the report")
    plan = next(c["prompt"] for c in h.fake_ai.calls if c["kind"] == "plan")
    assert "identify commercial partners and potential clients" in plan and "I prefer primary sources" in plan
    assert h.said("Saved context C1 (objectives)")

    h.tg.send_text(USER, "/profile")
    h.tg.send_text(USER, "/clearcontext")
    await h.until(lambda: h.said("Are you sure?"), what="the confirmation prompt")
    assert len(h.db.list_context(USER)) == 2, "nothing is deleted before confirmation"
    h.tg.press(USER, "cc:yes")
    await h.until(lambda: h.said("All saved context has been cleared"), what="the clear")
    assert h.db.list_context(USER) == []


async def test_e_photo_with_caption_drives_research(h):
    h.tg.send_photo(USER, "flyer1", caption="Investigate this company and identify partnership opportunities")
    await h.until(lambda: h.said("Research completed"), what="the image research")
    assert h.tg.sent("getFile")[0]["file_id"] == "big-flyer1", "the highest-resolution photo is fetched"
    assert h.fake_ai.kinds()[0] == "vision"
    assert any("SunVolt" in q for q in h.fake_search.queries)
    assert h.said("1 image(s) attached")
    image = h.db.task_images(1)[0]
    assert image["telegram_file_id"] == "big-flyer1" and image["status"] == "ANALYSED" and image["sha256"]


async def test_f_album_of_images_becomes_one_task(h):
    h.tg.send_photo(USER, "album-a", caption="Compare these companies", media_group_id="g1")
    h.tg.send_photo(USER, "album-b", media_group_id="g1")
    h.tg.send_photo(USER, "album-c", media_group_id="g1")
    await h.until(lambda: h.said("Research completed"), timeout=20, what="the album research")
    tasks = h.db.list_tasks(USER)
    assert len(tasks) == 1 and len(h.db.task_images(tasks[0]["id"])) == 3
    assert h.said("3 image(s) attached")


async def test_image_without_question_asks_instead_of_researching(h):
    h.tg.send_photo(USER, "lonely")
    await h.until(lambda: h.said("What should I investigate?"), what="the prompt")
    await h.settle()
    assert h.said("SunVolt Energy"), "the bot shows what it understood from the image"
    assert h.db.list_tasks(USER) == [] and h.fake_search.queries == [], "no research starts without instructions"

    h.tg.send_text(USER, "/search Is this company legitimate?")  # the staged image is attached automatically
    await h.until(lambda: h.said("Research completed"), what="research with the staged image")
    assert len(h.db.task_images(1)) == 1 and h.fake_ai.kinds().count("vision") == 1
    assert h.db.get_session(USER).get("staged") == []


async def test_plain_text_asks_before_spending_and_can_become_context(h):
    h.tg.send_text(USER, "We only operate in Lagos and Ogun")
    await h.until(lambda: h.said("What should I do with this?"), what="the choice")
    assert h.db.list_tasks(USER) == []
    h.tg.press(USER, "q:ctx")
    await h.until(lambda: h.said("Saved as"), what="context saved")
    assert h.db.list_context(USER)[0]["content"] == "We only operate in Lagos and Ogun"


async def test_attach_window_collects_image_and_text(tmp_path, monkeypatch):
    h = Harness(tmp_path, monkeypatch, attach_window=2.0)
    await h.start()
    h.tg.send_text(USER, f"/search {Q}")
    await h.until(lambda: h.said("Send images or extra context now"), what="the attach window notice")
    h.tg.send_photo(USER, "late-photo")
    h.tg.send_text(USER, "Focus on commercial rooftop installations")
    await h.until(lambda: h.said("Image received and attached to"), what="image attachment")
    await h.until(lambda: h.said("as context for this task only"), what="context attachment")
    await h.until(lambda: h.said("Research completed"), timeout=20, what="the report")
    task = h.db.list_tasks(USER)[0]
    assert task["task_context"] == "Focus on commercial rooftop installations" and len(h.db.task_images(task["id"])) == 1
    assert h.db.list_context(USER) == []
    await h.stop()
    h.tg.close()


async def test_status_cancel_schedule_and_unknown_input(h):
    h.tg.send_text(USER, "/status")
    h.tg.send_text(USER, "/cancel")
    h.tg.send_text(USER, "/schedule")
    h.tg.send_text(USER, "/schedule 05:00 Key developments in Nigeria's solar market")
    h.tg.send_text(USER, "/view R-99")
    h.tg.send_text(USER, "/nonsense")
    h.tg.send_text(USER, "/search")
    await h.until(lambda: h.said("Tell me what to research"), what="all replies")
    for fragment in ("No research is running", "Nothing is running", "It never runs without an objective",
                     "Daily research set for 05:00 (Africa/Lagos)", "SCHEDULER_ENABLED is false", "no research with the ID R-00099",
                     "I do not know that command"):
        assert h.said(fragment), fragment
    assert h.db.get_schedule(USER)["run_time"] == "05:00"


def test_long_reports_split_into_valid_telegram_messages():
    report = "# Title\n\n" + "\n\n".join(f"## {i}. SECTION\n" + "\n".join(f"- point {j} with **bold** and [a link](https://example.com/{i}/{j}?a=1&b=2) <tag>" for j in range(40)) for i in range(8))
    chunks = split_message(md_to_html(report))
    assert len(chunks) > 2 and all(len(c) <= 4096 for c in chunks)
    for chunk in chunks:
        assert chunk.count("<b>") == chunk.count("</b>") and chunk.count("<a ") == chunk.count("</a>")
        assert "<tag>" not in chunk and "&lt;tag&gt;" in chunk
    assert '<a href="https://example.com/0/0?a=1&amp;b=2">a link</a>' in chunks[0]
