import sqlite3

import pytest

from conftest import USER, Env
from sextant.db import Database


def test_schema_has_required_tables_and_foreign_keys(tmp_path):
    db = Database(tmp_path / "t.db")
    tables = {r["name"] for r in db._all("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"users", "user_context", "research_tasks", "research_reports", "research_sources", "research_images",
            "telegram_updates", "usage_logs", "research_context_links"} <= tables
    with pytest.raises(sqlite3.IntegrityError):  # no such user
        db.create_task(user_id=999, chat_id=1, question="q", fingerprint="f")
    with pytest.raises(sqlite3.IntegrityError):  # status is constrained to the state machine
        db.upsert_user(1, "a", 1)
        tid = db.create_task(user_id=1, chat_id=1, question="q", fingerprint="f")
        db._run("UPDATE research_tasks SET status='BOGUS' WHERE id=?", (tid,))


async def test_completed_report_survives_restart(tmp_path):
    """Acceptance test C: restart the application, the research is still there."""
    env = Env(tmp_path)
    task = await env.run()
    assert task["status"] == "COMPLETED"
    report_before = env.db.get_report(task["id"])["report_md"]
    await env.close()
    env.db.close()

    reopened = Database(env.cfg.db_path)
    again = reopened.get_task(task["id"], USER)
    assert again["status"] == "COMPLETED"
    assert reopened.get_report(task["id"])["report_md"] == report_before
    assert len(reopened.get_sources(task["id"])) >= 2
    assert reopened.list_tasks(USER)[0]["id"] == task["id"]
    reopened.close()


async def test_history_and_view_read_storage_without_ai(env):
    """Acceptance test G: retrieval is a database read; the model is never called."""
    task = await env.run()
    calls_after_research = len(env.ai_fake.calls)
    searches_after_research = len(env.search_fake.queries)

    history = env.db.list_tasks(USER, limit=10)
    recent = env.db.list_tasks(USER, limit=5, status="COMPLETED")
    report = env.db.get_report(task["id"])
    sources = env.db.get_sources(task["id"])

    assert history[0]["question"] == "Research the solar energy market in Nigeria"
    assert recent[0]["title"] == "Nigeria Solar Opportunities"
    assert "EXECUTIVE SUMMARY" in report["report_md"] and sources
    assert len(env.ai_fake.calls) == calls_after_research
    assert len(env.search_fake.queries) == searches_after_research


def test_users_cannot_read_each_others_tasks(tmp_path):
    db = Database(tmp_path / "t.db")
    db.upsert_user(1, "a", 1)
    db.upsert_user(2, "b", 2)
    tid = db.create_task(user_id=1, chat_id=1, question="secret", fingerprint="f")
    assert db.get_task(tid, 1) is not None
    assert db.get_task(tid, 2) is None


def test_image_metadata_persists(tmp_path):
    db = Database(tmp_path / "t.db")
    db.upsert_user(1, "a", 1)
    image_id = db.add_image(user_id=1, telegram_file_id="AgAC-file", file_unique_id="uniq", mime="image/jpeg", size_bytes=123)
    db.update_image(image_id, status="ANALYSED", extracted_text="SunVolt Energy", description={"organisations": ["SunVolt Energy"]},
                    sha256="abc", storage_path="/x/abc.jpg", provider="fake:model")
    tid = db.create_task(user_id=1, chat_id=1, question="q", fingerprint="f")
    db.link_image(tid, image_id)
    db.close()

    db = Database(tmp_path / "t.db")
    row = db.task_images(tid)[0]
    assert (row["telegram_file_id"], row["file_unique_id"], row["status"]) == ("AgAC-file", "uniq", "ANALYSED")
    assert row["extracted_text"] == "SunVolt Energy" and "SunVolt" in row["description"]
    assert row["uploaded_at"] and row["storage_path"] == "/x/abc.jpg"
    # the same Telegram file registers once
    assert db.add_image(user_id=1, telegram_file_id="other-id", file_unique_id="uniq") == image_id
