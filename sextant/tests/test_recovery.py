import time
from datetime import datetime, timezone

from conftest import USER, Env, make_config
from sextant.db import Database
from sextant.scheduler import due_runs, fire_due, valid_time

Q = "Research the solar energy market in Nigeria"


def _abandon(db, tid, worker="dead-worker", age=10_000):
    assert db.claim_task(tid, worker)
    db._run("UPDATE research_tasks SET heartbeat_at=? WHERE id=?", (time.time() - age, tid))


def test_stale_processing_task_is_requeued_not_stuck(env):
    tid = env.db.create_task(user_id=USER, chat_id=USER, question="q", fingerprint="f")
    _abandon(env.db, tid)
    requeued, failed = env.db.recover_stale(stale_seconds=180, max_attempts=2)
    assert (requeued, failed) == ([tid], [])
    task = env.db.get_task(tid)
    assert task["status"] == "PENDING" and task["worker_id"] is None


def test_task_with_a_live_worker_is_left_alone(env):
    tid = env.db.create_task(user_id=USER, chat_id=USER, question="q", fingerprint="f")
    assert env.db.claim_task(tid, "busy-worker")  # heartbeat is fresh
    assert env.db.recover_stale(stale_seconds=180, max_attempts=2) == ([], [])
    assert env.db.get_task(tid)["status"] == "PROCESSING"
    assert env.db.claim_task(tid, "second-worker") is False, "no second generation while the first may be alive"


def test_recovered_task_cannot_be_completed_by_the_old_worker(env):
    tid = env.db.create_task(user_id=USER, chat_id=USER, question="q", fingerprint="f")
    _abandon(env.db, tid, "zombie")
    env.db.recover_stale(180, 2)
    assert env.db.claim_task(tid, "new-worker")
    payload = dict(title="T", summary="S", report_md="# T", meta={}, sources=[])
    assert env.db.heartbeat(tid, "zombie") is False
    assert env.db.complete_task(tid, "zombie", **payload) is False
    assert env.db.complete_task(tid, "new-worker", **payload) is True


def test_repeatedly_abandoned_task_fails_instead_of_looping(env):
    tid = env.db.create_task(user_id=USER, chat_id=USER, question="q", fingerprint="f")
    _abandon(env.db, tid)
    env.db.recover_stale(180, 2)
    _abandon(env.db, tid)  # second attempt also dies
    requeued, failed = env.db.recover_stale(180, 2)
    assert (requeued, failed) == ([], [tid])
    task = env.db.get_task(tid)
    assert task["status"] == "FAILED" and "Interrupted" in task["error"]


async def test_restart_resumes_an_interrupted_task_exactly_once(tmp_path):
    """A crash mid-research: after restart the task completes once and is reported once."""
    cfg = make_config(tmp_path)
    db = Database(cfg.db_path)
    db.upsert_user(USER, "tester", USER)
    tid = db.create_task(user_id=USER, chat_id=USER, question=Q, fingerprint="fp")
    _abandon(db, tid, "crashed-process")
    db.close()

    env = Env(tmp_path, cfg=cfg)  # the "restarted" application
    await env.runner.recover()
    await env.runner.recover()  # a second sweep must not start it again
    await env.runner.wait_idle(20)
    task = env.db.get_task(tid)
    assert task["status"] == "COMPLETED" and task["attempts"] == 2
    assert env.notifier.completed_ids == [tid]
    assert env.ai_fake.kinds().count("report") == 1
    await env.close()


async def test_graceful_shutdown_hands_task_back_and_next_start_finishes_it(tmp_path):
    import asyncio
    env = Env(tmp_path)
    gate = asyncio.Event()

    async def hang(*_a, **_k):
        gate.set()
        await asyncio.sleep(60)

    env.search_fake.search = hang
    tid = env.submit(Q).task["id"]
    await asyncio.wait_for(gate.wait(), 5)
    await env.close()
    assert env.db.get_task(tid)["status"] == "PENDING"
    assert env.db.get_report(tid) is None

    env2 = Env(tmp_path, cfg=env.cfg, db=env.db)
    await env2.runner.recover()
    await env2.runner.wait_idle(20)
    assert env2.db.get_task(tid)["status"] == "COMPLETED"
    await env2.close()


async def test_unexpected_crash_marks_task_failed(tmp_path):
    env = Env(tmp_path)

    async def boom(*_a, **_k):
        raise RuntimeError("disk on fire")

    env.svc.pipeline.run = boom
    task = await env.run(Q)
    assert task["status"] == "FAILED" and "disk on fire" in task["error"]
    assert "internal error" in env.notifier.failures[0][1]
    await env.close()


# ---------------------------------------------------------------- scheduling
def _schedule(env, run_time="05:00", zone="Africa/Lagos"):
    env.db.set_schedule(USER, objective="Key developments in Nigeria's solar market", run_time=run_time, timezone=zone)


def test_schedule_is_due_only_after_local_time_and_within_catchup(env):
    _schedule(env)  # Lagos is UTC+1 all year
    at = lambda h, m: datetime(2026, 11, 12, h, m, tzinfo=timezone.utc)
    assert due_runs(env.db, at(3, 59), 6) == []
    assert [d for _, d in due_runs(env.db, at(4, 0), 6)] == ["2026-11-12"]
    assert due_runs(env.db, at(9, 30), 6) != []  # bot was down at 05:00: catch up
    assert due_runs(env.db, at(11, 0), 6) == []  # too late: skip rather than deliver stale "morning" research


def test_schedule_follows_daylight_saving(env):
    _schedule(env, zone="Europe/London")
    summer = datetime(2026, 7, 1, 4, 0, tzinfo=timezone.utc)  # 05:00 BST
    winter = datetime(2026, 12, 1, 4, 0, tzinfo=timezone.utc)  # 04:00 GMT
    assert due_runs(env.db, summer, 6) and not due_runs(env.db, winter, 6)


async def test_scheduled_run_happens_once_per_day(env):
    _schedule(env)
    now = datetime(2026, 11, 12, 4, 5, tzinfo=timezone.utc)
    first = fire_due(env.cfg, env.db, env.runner, now)
    second = fire_due(env.cfg, env.db, env.runner, now)  # restart or repeated tick
    await env.runner.wait_idle(20)
    assert len(first) == 1 and second == []
    assert env.db.get_task(first[0])["origin"] == "schedule"

    tomorrow = fire_due(env.cfg, env.db, env.runner, datetime(2026, 11, 13, 4, 5, tzinfo=timezone.utc))
    await env.runner.wait_idle(20)
    assert len(tomorrow) == 1 and tomorrow != first, "a new day is a new run, not a duplicate of yesterday's report"
    assert env.db.get_task(tomorrow[0])["status"] == "COMPLETED"


def test_nothing_runs_without_an_objective(env):
    env.db.set_schedule(USER, objective="", run_time="05:00", timezone="Africa/Lagos")
    assert fire_due(env.cfg, env.db, env.runner, datetime(2026, 11, 12, 4, 5, tzinfo=timezone.utc)) == []
    assert valid_time("5:00") == "05:00" and valid_time("25:00") is None and valid_time("soon") is None
