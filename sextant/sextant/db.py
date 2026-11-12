"""SQLite persistence. One connection, WAL mode, every multi-step change in a transaction.

All SQL lives here; nothing else in the application builds queries.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = Path(__file__).with_name("schema.sql")
ACTIVE = ("PENDING", "PROCESSING")


def utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Database:
    def __init__(self, path: str | Path):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None, timeout=30)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._conn.execute("PRAGMA journal_mode = WAL")
        self._conn.execute("PRAGMA synchronous = NORMAL")
        self._conn.executescript(SCHEMA.read_text(encoding="utf-8"))

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    @contextmanager
    def tx(self):
        """BEGIN IMMEDIATE ... COMMIT, rolled back on any exception."""
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield self._conn
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise
            else:
                self._conn.execute("COMMIT")

    def _all(self, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(sql, args).fetchall()

    def _one(self, sql: str, args: tuple = ()) -> sqlite3.Row | None:
        with self._lock:
            return self._conn.execute(sql, args).fetchone()

    def _run(self, sql: str, args: tuple = ()) -> sqlite3.Cursor:
        with self._lock:
            return self._conn.execute(sql, args)

    # ---------------------------------------------------------------- users
    def upsert_user(self, user_id: int, username: str | None, chat_id: int | None) -> None:
        now = utcnow()
        self._run(
            """INSERT INTO users (telegram_id, username, chat_id, first_seen, last_seen) VALUES (?,?,?,?,?)
               ON CONFLICT(telegram_id) DO UPDATE SET username=excluded.username,
                   chat_id=COALESCE(excluded.chat_id, users.chat_id), last_seen=excluded.last_seen""",
            (user_id, username, chat_id, now, now),
        )

    def get_user(self, user_id: int) -> sqlite3.Row | None:
        return self._one("SELECT * FROM users WHERE telegram_id=?", (user_id,))

    def get_session(self, user_id: int) -> dict:
        row = self._one("SELECT session FROM users WHERE telegram_id=?", (user_id,))
        try:
            return json.loads(row["session"]) if row else {}
        except (TypeError, ValueError):
            return {}

    def set_session(self, user_id: int, session: dict) -> None:
        self._run("UPDATE users SET session=? WHERE telegram_id=?", (json.dumps(session), user_id))

    # ---------------------------------------------------- telegram updates
    def claim_update(self, update_id: int) -> bool:
        """True exactly once per update_id; the primary key makes retries harmless."""
        cur = self._run("INSERT OR IGNORE INTO telegram_updates (update_id, received_at) VALUES (?,?)", (update_id, utcnow()))
        if cur.rowcount and update_id % 500 == 0:
            self._run("DELETE FROM telegram_updates WHERE update_id < ?", (update_id - 20_000,))
        return bool(cur.rowcount)

    # -------------------------------------------------------------- context
    def add_context(self, user_id: int, category: str, content: str, source: str = "user") -> int:
        now = utcnow()
        cur = self._run(
            "INSERT INTO user_context (user_id, category, content, source, created_at, updated_at) VALUES (?,?,?,?,?,?)",
            (user_id, category, content.strip(), source, now, now),
        )
        return int(cur.lastrowid)

    def list_context(self, user_id: int) -> list[sqlite3.Row]:
        return self._all("SELECT * FROM user_context WHERE user_id=? AND active=1 ORDER BY id", (user_id,))

    def get_context(self, user_id: int, context_id: int) -> sqlite3.Row | None:
        return self._one("SELECT * FROM user_context WHERE id=? AND user_id=? AND active=1", (context_id, user_id))

    def update_context(self, user_id: int, context_id: int, *, content: str | None = None, category: str | None = None) -> bool:
        cur = self._run(
            """UPDATE user_context SET content=COALESCE(?, content), category=COALESCE(?, category), updated_at=?
               WHERE id=? AND user_id=? AND active=1""",
            (content.strip() if content else None, category, utcnow(), context_id, user_id),
        )
        return bool(cur.rowcount)

    def delete_context(self, user_id: int, context_id: int) -> bool:
        return bool(self._run("DELETE FROM user_context WHERE id=? AND user_id=?", (context_id, user_id)).rowcount)

    def clear_context(self, user_id: int) -> int:
        return self._run("DELETE FROM user_context WHERE user_id=?", (user_id,)).rowcount

    # ---------------------------------------------------------------- tasks
    def create_task(self, *, user_id: int, chat_id: int, question: str, fingerprint: str, task_context: str = "",
                    depth: str = "standard", origin: str = "telegram", update_id: int | None = None) -> int:
        """Raises sqlite3.IntegrityError if an identical task is already PENDING/PROCESSING."""
        cur = self._run(
            """INSERT INTO research_tasks (user_id, chat_id, question, task_context, fingerprint, depth, origin, update_id, created_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (user_id, chat_id, question.strip(), task_context.strip(), fingerprint, depth, origin, update_id, utcnow()),
        )
        return int(cur.lastrowid)

    def get_task(self, task_id: int, user_id: int | None = None) -> sqlite3.Row | None:
        if user_id is None:
            return self._one("SELECT * FROM research_tasks WHERE id=?", (task_id,))
        return self._one("SELECT * FROM research_tasks WHERE id=? AND user_id=?", (task_id, user_id))

    def find_active(self, user_id: int, fingerprint: str) -> sqlite3.Row | None:
        return self._one(
            "SELECT * FROM research_tasks WHERE user_id=? AND fingerprint=? AND status IN ('PENDING','PROCESSING')",
            (user_id, fingerprint),
        )

    def find_completed(self, user_id: int, fingerprint: str) -> sqlite3.Row | None:
        return self._one(
            "SELECT * FROM research_tasks WHERE user_id=? AND fingerprint=? AND status='COMPLETED' ORDER BY id DESC LIMIT 1",
            (user_id, fingerprint),
        )

    def list_tasks(self, user_id: int, limit: int = 10, status: str | None = None, offset: int = 0) -> list[sqlite3.Row]:
        if status:
            return self._all(
                """SELECT t.*, r.title FROM research_tasks t LEFT JOIN research_reports r ON r.task_id=t.id
                   WHERE t.user_id=? AND t.status=? ORDER BY t.id DESC LIMIT ? OFFSET ?""",
                (user_id, status, limit, offset),
            )
        return self._all(
            """SELECT t.*, r.title FROM research_tasks t LEFT JOIN research_reports r ON r.task_id=t.id
               WHERE t.user_id=? ORDER BY t.id DESC LIMIT ? OFFSET ?""",
            (user_id, limit, offset),
        )

    def active_tasks(self, user_id: int | None = None) -> list[sqlite3.Row]:
        if user_id is None:
            return self._all("SELECT * FROM research_tasks WHERE status IN ('PENDING','PROCESSING') ORDER BY id")
        return self._all(
            "SELECT * FROM research_tasks WHERE user_id=? AND status IN ('PENDING','PROCESSING') ORDER BY id", (user_id,)
        )

    def count_tasks_since(self, user_id: int, since_iso: str) -> int:
        row = self._one(
            "SELECT COUNT(*) AS n FROM research_tasks WHERE user_id=? AND created_at>=? AND origin!='schedule'",
            (user_id, since_iso),
        )
        return int(row["n"])

    def amend_pending_task(self, task_id: int, *, fingerprint: str, task_context: str | None = None) -> bool:
        """Attach extra context/images to a task that has not started yet."""
        try:
            cur = self._run(
                "UPDATE research_tasks SET fingerprint=?, task_context=COALESCE(?, task_context) WHERE id=? AND status='PENDING'",
                (fingerprint, task_context, task_id),
            )
            return bool(cur.rowcount)
        except sqlite3.IntegrityError:  # would collide with another in-flight task: keep the old fingerprint
            cur = self._run(
                "UPDATE research_tasks SET task_context=COALESCE(?, task_context) WHERE id=? AND status='PENDING'",
                (task_context, task_id),
            )
            return bool(cur.rowcount)

    def set_status_message(self, task_id: int, message_id: int | None) -> None:
        self._run("UPDATE research_tasks SET status_msg_id=? WHERE id=?", (message_id, task_id))

    # -- state machine: PENDING -> PROCESSING -> COMPLETED | FAILED | CANCELLED
    def claim_task(self, task_id: int, worker_id: str) -> bool:
        """Atomic PENDING -> PROCESSING. Only one caller can ever win."""
        cur = self._run(
            """UPDATE research_tasks SET status='PROCESSING', worker_id=?, heartbeat_at=?, attempts=attempts+1,
                   started_at=COALESCE(started_at, ?), stage='starting', error=NULL
               WHERE id=? AND status='PENDING' AND cancel_requested=0""",
            (worker_id, time.time(), utcnow(), task_id),
        )
        return bool(cur.rowcount)

    def heartbeat(self, task_id: int, worker_id: str, stage: str | None = None) -> bool:
        """False means this worker no longer owns the task and must stop."""
        cur = self._run(
            """UPDATE research_tasks SET heartbeat_at=?, stage=COALESCE(?, stage)
               WHERE id=? AND worker_id=? AND status='PROCESSING'""",
            (time.time(), stage, task_id, worker_id),
        )
        return bool(cur.rowcount)

    def is_cancel_requested(self, task_id: int) -> bool:
        row = self._one("SELECT cancel_requested, status FROM research_tasks WHERE id=?", (task_id,))
        return bool(row and (row["cancel_requested"] or row["status"] == "CANCELLED"))

    def complete_task(self, task_id: int, worker_id: str, *, title: str, summary: str, report_md: str,
                      meta: dict, sources: list[dict]) -> bool:
        """Store report + sources and flip to COMPLETED in one transaction.

        Returns False (and stores nothing) if this worker lost ownership, so a zombie
        worker can never overwrite or duplicate a report.
        """
        with self.tx() as conn:
            cur = conn.execute(
                """UPDATE research_tasks SET status='COMPLETED', stage='done', finished_at=?, error=NULL
                   WHERE id=? AND worker_id=? AND status='PROCESSING' AND cancel_requested=0""",
                (utcnow(), task_id, worker_id),
            )
            if not cur.rowcount:
                return False
            conn.execute(
                "INSERT INTO research_reports (task_id, title, summary, report_md, meta, created_at) VALUES (?,?,?,?,?,?)",
                (task_id, title, summary, report_md, json.dumps(meta), utcnow()),
            )
            conn.execute("DELETE FROM research_sources WHERE task_id=?", (task_id,))
            conn.executemany(
                """INSERT OR IGNORE INTO research_sources
                   (task_id, num, url, title, domain, provider, source_type, credibility, published, origin_group, evidence)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                [
                    (task_id, s["num"], s["url"], s.get("title", ""), s.get("domain", ""), s.get("provider", ""),
                     s.get("source_type", "unknown"), float(s.get("credibility", 0)), s.get("published", ""),
                     s.get("origin_group", ""), json.dumps(s.get("evidence", [])))
                    for s in sources
                ],
            )
        return True

    def fail_task(self, task_id: int, error: str, worker_id: str | None = None) -> bool:
        sql = "UPDATE research_tasks SET status='FAILED', finished_at=?, error=? WHERE id=? AND status IN ('PENDING','PROCESSING')"
        args: tuple = (utcnow(), error[:1000], task_id)
        if worker_id:
            sql += " AND worker_id=?"
            args += (worker_id,)
        return bool(self._run(sql, args).rowcount)

    def cancel_task(self, task_id: int, user_id: int) -> bool:
        cur = self._run(
            """UPDATE research_tasks SET status='CANCELLED', cancel_requested=1, finished_at=?
               WHERE id=? AND user_id=? AND status IN ('PENDING','PROCESSING')""",
            (utcnow(), task_id, user_id),
        )
        return bool(cur.rowcount)

    def recover_stale(self, stale_seconds: float, max_attempts: int) -> tuple[list[int], list[int]]:
        """Handle PROCESSING tasks whose worker stopped heart-beating.

        A task is only touched once its heartbeat is older than `stale_seconds`, so a
        worker that is merely slow (or a second process still running) is left alone.
        Returns (requeued_ids, failed_ids).
        """
        cutoff = time.time() - stale_seconds
        requeued, failed = [], []
        with self.tx() as conn:
            rows = conn.execute(
                "SELECT id, attempts FROM research_tasks WHERE status='PROCESSING' AND COALESCE(heartbeat_at, 0) < ?", (cutoff,)
            ).fetchall()
            for row in rows:
                if row["attempts"] >= max_attempts:
                    conn.execute(
                        "UPDATE research_tasks SET status='FAILED', worker_id=NULL, finished_at=?, error=? WHERE id=?",
                        (utcnow(), "Interrupted (worker stopped responding) and retry limit reached.", row["id"]),
                    )
                    failed.append(row["id"])
                else:
                    conn.execute("UPDATE research_tasks SET status='PENDING', worker_id=NULL, stage='recovered' WHERE id=?", (row["id"],))
                    requeued.append(row["id"])
        return requeued, failed

    def pending_task_ids(self) -> list[int]:
        return [r["id"] for r in self._all("SELECT id FROM research_tasks WHERE status='PENDING' ORDER BY id")]

    # ------------------------------------------------------ reports/sources
    def get_report(self, task_id: int) -> sqlite3.Row | None:
        return self._one("SELECT * FROM research_reports WHERE task_id=?", (task_id,))

    def get_sources(self, task_id: int) -> list[sqlite3.Row]:
        return self._all("SELECT * FROM research_sources WHERE task_id=? ORDER BY num", (task_id,))

    def completed_with_reports(self, user_id: int, limit: int = 200) -> list[sqlite3.Row]:
        return self._all(
            """SELECT t.id, t.question, t.finished_at, r.title, r.summary FROM research_tasks t
               JOIN research_reports r ON r.task_id=t.id WHERE t.user_id=? ORDER BY t.id DESC LIMIT ?""",
            (user_id, limit),
        )

    # --------------------------------------------------------------- images
    def find_image(self, user_id: int, *, file_unique_id: str | None = None, sha256: str | None = None) -> sqlite3.Row | None:
        if file_unique_id:
            row = self._one("SELECT * FROM research_images WHERE user_id=? AND file_unique_id=?", (user_id, file_unique_id))
            if row:
                return row
        if sha256:
            return self._one("SELECT * FROM research_images WHERE user_id=? AND sha256=? ORDER BY id LIMIT 1", (user_id, sha256))
        return None

    def get_image(self, image_id: int, user_id: int | None = None) -> sqlite3.Row | None:
        if user_id is None:
            return self._one("SELECT * FROM research_images WHERE id=?", (image_id,))
        return self._one("SELECT * FROM research_images WHERE id=? AND user_id=?", (image_id, user_id))

    def add_image(self, *, user_id: int, telegram_file_id: str, file_unique_id: str, mime: str = "", size_bytes: int = 0) -> int:
        self._run(
            """INSERT OR IGNORE INTO research_images (user_id, telegram_file_id, file_unique_id, mime, size_bytes, uploaded_at)
               VALUES (?,?,?,?,?,?)""",
            (user_id, telegram_file_id, file_unique_id, mime, size_bytes, utcnow()),
        )
        row = self._one("SELECT id FROM research_images WHERE user_id=? AND file_unique_id=?", (user_id, file_unique_id))
        return int(row["id"])

    def update_image(self, image_id: int, **fields) -> None:
        allowed = {"sha256", "mime", "size_bytes", "storage_path", "status", "extracted_text", "description", "provider", "error"}
        fields = {k: v for k, v in fields.items() if k in allowed}
        if not fields:
            return
        if isinstance(fields.get("description"), (dict, list)):
            fields["description"] = json.dumps(fields["description"])
        sets = ", ".join(f"{k}=?" for k in fields)
        self._run(f"UPDATE research_images SET {sets} WHERE id=?", (*fields.values(), image_id))

    def link_image(self, task_id: int, image_id: int) -> None:
        self._run("INSERT OR IGNORE INTO research_task_images (task_id, image_id) VALUES (?,?)", (task_id, image_id))

    def task_images(self, task_id: int) -> list[sqlite3.Row]:
        return self._all(
            """SELECT i.* FROM research_images i JOIN research_task_images l ON l.image_id=i.id
               WHERE l.task_id=? ORDER BY i.id""",
            (task_id,),
        )

    # -------------------------------------------------------- context links
    def set_context_links(self, task_id: int, links: list[dict]) -> None:
        with self.tx() as conn:
            conn.execute("DELETE FROM research_context_links WHERE task_id=?", (task_id,))
            conn.executemany(
                "INSERT OR IGNORE INTO research_context_links (task_id, context_id, category, content, reason) VALUES (?,?,?,?,?)",
                [(task_id, l["id"], l["category"], l["content"], l.get("reason", "")) for l in links],
            )

    def get_context_links(self, task_id: int) -> list[sqlite3.Row]:
        return self._all("SELECT * FROM research_context_links WHERE task_id=? ORDER BY context_id", (task_id,))

    # ---------------------------------------------------------------- usage
    def log_usage(self, provider: str, kind: str, *, model: str = "", task_id: int | None = None,
                  prompt_tokens: int = 0, completion_tokens: int = 0, ok: bool = True, error: str | None = None) -> None:
        self._run(
            """INSERT INTO usage_logs (ts, provider, kind, model, task_id, prompt_tokens, completion_tokens, ok, error)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (time.time(), provider, kind, model, task_id, prompt_tokens, completion_tokens, int(ok), (error or "")[:300] or None),
        )

    def usage_count(self, provider: str, since_ts: float, kinds: tuple[str, ...] = ("text", "vision")) -> int:
        marks = ",".join("?" * len(kinds))
        row = self._one(
            f"SELECT COUNT(*) AS n FROM usage_logs WHERE provider=? AND ts>=? AND kind IN ({marks})", (provider, since_ts, *kinds)
        )
        return int(row["n"])

    def usage_summary(self, since_ts: float) -> list[sqlite3.Row]:
        return self._all(
            """SELECT provider, kind, COUNT(*) AS requests, SUM(ok) AS ok, SUM(prompt_tokens) AS prompt_tokens,
                      SUM(completion_tokens) AS completion_tokens
               FROM usage_logs WHERE ts>=? GROUP BY provider, kind ORDER BY provider, kind""",
            (since_ts,),
        )

    # --------------------------------------------------------------- caches
    def cache_get(self, table: str, key: str, max_age_seconds: float) -> str | None:
        col, val, ts = ("cache_key", "results", "created_at") if table == "search_cache" else ("url", "page", "fetched_at")
        row = self._one(f"SELECT {val} AS v, {ts} AS ts FROM {table} WHERE {col}=?", (key,))
        return row["v"] if row and time.time() - row["ts"] <= max_age_seconds else None

    def cache_put(self, table: str, key: str, value: str) -> None:
        col, val, ts = ("cache_key", "results", "created_at") if table == "search_cache" else ("url", "page", "fetched_at")
        self._run(f"INSERT OR REPLACE INTO {table} ({col}, {val}, {ts}) VALUES (?,?,?)", (key, value, time.time()))

    def prune_caches(self, max_age_seconds: float = 7 * 86400) -> None:
        cutoff = time.time() - max_age_seconds
        self._run("DELETE FROM search_cache WHERE created_at<?", (cutoff,))
        self._run("DELETE FROM page_cache WHERE fetched_at<?", (cutoff,))

    # ------------------------------------------------------------- schedule
    def get_schedule(self, user_id: int) -> sqlite3.Row | None:
        return self._one("SELECT * FROM schedules WHERE user_id=?", (user_id,))

    def set_schedule(self, user_id: int, *, objective: str, run_time: str, timezone: str, enabled: bool = True) -> None:
        self._run(
            """INSERT INTO schedules (user_id, objective, run_time, timezone, enabled) VALUES (?,?,?,?,?)
               ON CONFLICT(user_id) DO UPDATE SET objective=excluded.objective, run_time=excluded.run_time,
                   timezone=excluded.timezone, enabled=excluded.enabled""",
            (user_id, objective.strip(), run_time, timezone, int(enabled)),
        )

    def enabled_schedules(self) -> list[sqlite3.Row]:
        return self._all("SELECT * FROM schedules WHERE enabled=1 AND TRIM(objective)!=''")

    def claim_scheduled_run(self, user_id: int, run_date: str) -> bool:
        """True exactly once per user per local date, across restarts and processes."""
        cur = self._run(
            "INSERT OR IGNORE INTO scheduled_runs (user_id, run_date, created_at) VALUES (?,?,?)", (user_id, run_date, utcnow())
        )
        return bool(cur.rowcount)

    def set_scheduled_run_task(self, user_id: int, run_date: str, task_id: int) -> None:
        self._run("UPDATE scheduled_runs SET task_id=? WHERE user_id=? AND run_date=?", (task_id, user_id, run_date))
