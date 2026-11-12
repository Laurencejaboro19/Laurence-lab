import asyncio
import sqlite3

import pytest

from conftest import USER, Env
from sextant.textutil import fingerprint, normalize_question

Q = "Research the solar energy market in Nigeria"


def test_telegram_update_is_claimed_exactly_once(env):
    assert env.db.claim_update(555) is True
    assert env.db.claim_update(555) is False  # webhook retry / repeated polling event
    assert env.db.claim_update(556) is True


def test_update_claims_survive_restart(tmp_path):
    env = Env(tmp_path)
    env.db.claim_update(900)
    env.db.close()
    from sextant.db import Database
    assert Database(env.cfg.db_path).claim_update(900) is False


def test_fingerprint_ignores_cosmetic_differences():
    assert normalize_question("  Research   the Solar market?? ") == "research the solar market"
    assert fingerprint("Research the solar market.") == fingerprint("research  the SOLAR market")
    assert fingerprint("Research the solar market") != fingerprint("Research the wind market")
    assert fingerprint("q", "ctx a") != fingerprint("q", "ctx b")
    assert fingerprint("q", "", ["img1"]) != fingerprint("q", "", ["img2"])
    assert fingerprint("q", "", ["a", "b"]) == fingerprint("q", "", ["b", "a"])


async def test_identical_request_while_running_does_not_start_second_task(env):
    first = env.submit(Q)
    second = env.submit(Q.upper() + "?")
    assert first.kind == "created" and second.kind == "running"
    assert second.task["id"] == first.task["id"]
    await env.runner.wait_idle(20)
    assert len(env.db.list_tasks(USER)) == 1
    assert env.ai_fake.kinds().count("report") == 1


async def test_completed_request_returns_existing_report_not_a_new_generation(env):
    """Acceptance test B."""
    done = await env.run(Q)
    calls = len(env.ai_fake.calls)

    again = env.submit(Q)
    assert again.kind == "existing" and again.task["id"] == done["id"]
    await env.runner.wait_idle(5)
    assert len(env.ai_fake.calls) == calls, "no model call may happen for a duplicate request"
    assert len(env.db.list_tasks(USER)) == 1


async def test_explicit_fresh_research_is_allowed_and_distinct(env):
    done = await env.run(Q)
    fresh = env.submit(Q, fresh=True)
    assert fresh.kind == "created" and fresh.task["id"] != done["id"]
    assert env.submit(Q, fresh=True).kind == "running", "double-tapping 'fresh' must not start two runs"
    await env.runner.wait_idle(20)
    assert [t["status"] for t in env.db.list_tasks(USER)] == ["COMPLETED", "COMPLETED"]
    assert env.db.get_task(fresh.task["id"])["origin"] == "fresh"


def test_database_refuses_second_active_task_with_same_fingerprint(env):
    env.db.create_task(user_id=USER, chat_id=USER, question="q", fingerprint="same")
    with pytest.raises(sqlite3.IntegrityError):
        env.db.create_task(user_id=USER, chat_id=USER, question="q", fingerprint="same")


def test_only_one_worker_can_claim_and_only_the_owner_can_complete(env):
    tid = env.db.create_task(user_id=USER, chat_id=USER, question="q", fingerprint="f")
    assert env.db.claim_task(tid, "worker-a") is True
    assert env.db.claim_task(tid, "worker-b") is False

    payload = dict(title="T", summary="S", report_md="# T", meta={}, sources=[])
    assert env.db.complete_task(tid, "worker-b", **payload) is False
    assert env.db.get_report(tid) is None
    assert env.db.complete_task(tid, "worker-a", **payload) is True
    assert env.db.complete_task(tid, "worker-a", **payload) is False, "a completed report is never regenerated"
    assert env.db.get_task(tid)["status"] == "COMPLETED"


async def test_cancel_stops_a_task_and_no_report_is_stored(tmp_path):
    env = Env(tmp_path)
    started = asyncio.Event()
    original = env.search_fake.search

    async def slow_search(client, query, max_results):
        started.set()
        await asyncio.sleep(5)
        return await original(client, query, max_results)

    env.search_fake.search = slow_search
    result = env.submit(Q)
    await asyncio.wait_for(started.wait(), 5)
    assert env.runner.cancel(result.task["id"], USER) is True
    await env.runner.wait_idle(5)
    task = env.db.get_task(result.task["id"])
    assert task["status"] == "CANCELLED" and env.db.get_report(task["id"]) is None
    assert env.notifier.completed_ids == []
    await env.close()


async def test_hourly_research_limit(tmp_path):
    from conftest import make_config
    env = Env(tmp_path, cfg=make_config(tmp_path, max_research_per_hour=2))
    assert (await env.run("question one"))["status"] == "COMPLETED"
    assert (await env.run("question two"))["status"] == "COMPLETED"
    assert env.submit("question three").kind == "rate_limited"
    await env.close()
