"""Task lifecycle: duplicate-safe submission, single-worker execution, heartbeats, recovery.

State machine (persisted in research_tasks.status):

    PENDING -> PROCESSING -> COMPLETED
                         \\-> FAILED
       \\-----------------> CANCELLED

Guarantees:
* one in-flight task per (user, request fingerprint) - enforced by a unique index;
* an identical completed request returns the stored report unless `fresh=True`;
* only the worker that claimed a task may complete it; a report is inserted exactly once;
* a task whose worker dies is re-queued (or failed after MAX_TASK_ATTEMPTS) once its
  heartbeat is older than STALE_TASK_SECONDS, never while a worker may still be alive.
"""
from __future__ import annotations

import asyncio
import logging
import sqlite3
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from ..config import Config
from ..db import Database
from ..images import ImageProcessor
from ..providers.ai import AllProvidersExhausted, BudgetExceeded
from ..textutil import clip, fingerprint
from .pipeline import Cancelled, Pipeline, ResearchFailed

log = logging.getLogger(__name__)


class Notifier:
    """How the runner talks to the user. The Telegram bot provides the real one."""

    async def progress(self, task, text: str) -> None: ...
    async def completed(self, task) -> None: ...
    async def failed(self, task, message: str) -> None: ...


@dataclass
class Submission:
    kind: str  # created | running | existing | rate_limited
    task: sqlite3.Row | None = None


class Runner:
    def __init__(self, cfg: Config, db: Database, pipeline: Pipeline, images: ImageProcessor, notifier: Notifier):
        self.cfg, self.db, self.pipeline, self.images, self.notifier = cfg, db, pipeline, images, notifier
        self.worker_id = uuid.uuid4().hex[:12]
        self._jobs: dict[int, asyncio.Task] = {}
        self._start_at: dict[int, float] = {}
        self._gate = asyncio.Semaphore(1)  # one research at a time keeps free-tier quotas sane
        self._sweeper: asyncio.Task | None = None
        self._closing = False

    # ----------------------------------------------------------- submission
    def image_keys(self, image_ids: list[int]) -> list[str]:
        keys = []
        for image_id in image_ids:
            row = self.db.get_image(image_id)
            if row:
                keys.append(row["sha256"] or row["file_unique_id"])
        return keys

    def submit(self, *, user_id: int, chat_id: int, question: str, task_context: str = "", image_ids: list[int] | None = None,
               fresh: bool = False, origin: str = "telegram", update_id: int | None = None, salt: str = "",
               depth: str | None = None, delay: float | None = None) -> Submission:
        image_ids = list(dict.fromkeys(image_ids or []))[: self.cfg.max_images_per_task]
        fp = fingerprint(question, task_context, self.image_keys(image_ids), salt)
        running = self.db.find_active(user_id, fp)
        if running:
            return Submission("running", running)
        if not fresh:
            done = self.db.find_completed(user_id, fp)
            if done:
                return Submission("existing", done)
        if origin != "schedule":
            since = (datetime.now(timezone.utc) - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
            if self.db.count_tasks_since(user_id, since) >= self.cfg.max_research_per_hour:
                return Submission("rate_limited")
        try:
            task_id = self.db.create_task(user_id=user_id, chat_id=chat_id, question=question, fingerprint=fp,
                                          task_context=task_context, depth=depth or self.cfg.default_depth,
                                          origin="fresh" if fresh and origin == "telegram" else origin, update_id=update_id)
        except sqlite3.IntegrityError:  # lost a race with an identical request: that one wins
            return Submission("running", self.db.find_active(user_id, fp))
        for image_id in image_ids:
            self.db.link_image(task_id, image_id)
        self.start(task_id, self.cfg.attach_window if delay is None else delay)
        return Submission("created", self.db.get_task(task_id))

    def attach(self, task_id: int, *, image_id: int | None = None, extra_context: str | None = None) -> bool:
        """Add an image or extra text to a task still inside its attach window."""
        task = self.db.get_task(task_id)
        if not task or task["status"] != "PENDING":
            return False
        if image_id is not None:
            if len(self.db.task_images(task_id)) >= self.cfg.max_images_per_task:
                return False
            self.db.link_image(task_id, image_id)
        context = task["task_context"]
        if extra_context:
            context = (context + "\n" + extra_context.strip()).strip()
        keys = self.image_keys([row["id"] for row in self.db.task_images(task_id)])
        if not self.db.amend_pending_task(task_id, fingerprint=fingerprint(task["question"], context, keys), task_context=context):
            return False
        if task_id in self._start_at:  # give the user time to send the next piece
            self._start_at[task_id] = time.monotonic() + self.cfg.attach_window
        return True

    def start_now(self, task_id: int) -> None:
        if task_id in self._start_at:
            self._start_at[task_id] = 0.0

    def collecting(self, user_id: int):
        """The user's newest task that is still waiting for attachments, if any."""
        for task in reversed(self.db.active_tasks(user_id)):
            if task["status"] == "PENDING" and task["id"] in self._start_at:
                return task
        return None

    # ------------------------------------------------------------ execution
    def start(self, task_id: int, delay: float = 0.0) -> None:
        if self._closing or (task_id in self._jobs and not self._jobs[task_id].done()):
            return
        self._start_at[task_id] = time.monotonic() + max(0.0, delay)
        job = asyncio.get_running_loop().create_task(self._run(task_id), name=f"research-{task_id}")
        self._jobs[task_id] = job
        job.add_done_callback(lambda _: (self._jobs.pop(task_id, None), self._start_at.pop(task_id, None)))

    async def _run(self, task_id: int) -> None:
        while time.monotonic() < self._start_at.get(task_id, 0.0):
            await asyncio.sleep(0.2)
        self._start_at.pop(task_id, None)
        async with self._gate:
            task = self.db.get_task(task_id)
            if not task or task["status"] != "PENDING":
                return
            if task["attempts"] >= self.cfg.max_attempts:
                if self.db.fail_task(task_id, "Retry limit reached after repeated interruptions."):
                    await self._notify_failed(task, "This research was interrupted repeatedly and has been stopped. Send it again to retry.")
                return
            if not self.db.claim_task(task_id, self.worker_id):
                return
            beat = asyncio.create_task(self._heartbeat(task_id))
            try:
                await self._execute(task_id)
            finally:
                beat.cancel()

    async def _heartbeat(self, task_id: int) -> None:
        while True:
            await asyncio.sleep(self.cfg.heartbeat_seconds)
            if not self.db.heartbeat(task_id, self.worker_id):
                return

    async def _execute(self, task_id: int) -> None:
        task = self.db.get_task(task_id)

        async def tick(stage: str, message: str | None) -> None:
            if self.db.is_cancel_requested(task_id) or not self.db.heartbeat(task_id, self.worker_id, stage):
                raise Cancelled()
            if message:
                try:
                    await self.notifier.progress(task, message)
                except Exception:  # progress messages are cosmetic; never let them kill research
                    log.debug("progress notification failed", exc_info=True)

        try:
            pending = [row for row in self.db.task_images(task_id) if row["status"] != "ANALYSED"]
            if pending:
                await tick("images", f"🖼 Analysing {len(pending)} image(s)…")
                for row in pending:
                    await self.images.analyse(row["id"], task_id=task_id)
            outcome = await self.pipeline.run(task, self.db.task_images(task_id), tick)
            if self.db.complete_task(task_id, self.worker_id, title=outcome.title, summary=outcome.summary,
                                     report_md=outcome.report_md, meta=outcome.meta, sources=outcome.sources):
                await self.notifier.completed(self.db.get_task(task_id))
            else:
                log.warning("task %s finished but this worker no longer owned it; result discarded", task_id)
        except Cancelled:
            log.info("task %s cancelled", task_id)
        except asyncio.CancelledError:
            # Shutdown or /cancel. On shutdown the row is handed back in shutdown(); nothing is half-written.
            raise
        except ResearchFailed as exc:
            await self._fail(task, str(exc), str(exc))
        except AllProvidersExhausted as exc:
            await self._fail(task, f"AI providers unavailable: {exc}",
                             "Research could not continue: every configured AI provider is unavailable or has reached its "
                             f"free limit ({clip(str(exc), 350)}). Nothing was generated. Try again after the limits reset, "
                             "or configure another provider.")
        except BudgetExceeded as exc:
            await self._fail(task, f"budget: {exc}", f"Research stopped: {exc}. Nothing was generated. Try a shallower depth or raise the budget.")
        except Exception as exc:  # last resort: never leave a task stuck in PROCESSING
            log.exception("task %s crashed", task_id)
            await self._fail(task, f"internal error: {type(exc).__name__}: {exc}", "Research failed because of an internal error. It has been logged; nothing was generated.")

    async def _fail(self, task, error: str, user_message: str) -> None:
        if self.db.fail_task(task["id"], error, self.worker_id):
            await self._notify_failed(task, user_message)

    async def _notify_failed(self, task, message: str) -> None:
        try:
            await self.notifier.failed(task, message)
        except Exception:
            log.exception("could not deliver failure notice for task %s", task["id"])

    # ------------------------------------------------------- cancel/recover
    def cancel(self, task_id: int, user_id: int) -> bool:
        if not self.db.cancel_task(task_id, user_id):
            return False
        job = self._jobs.get(task_id)
        if job and not job.done():
            job.cancel()
        return True

    async def recover(self) -> None:
        """Re-queue abandoned tasks and (re)start anything PENDING that has no job."""
        requeued, failed = self.db.recover_stale(self.cfg.stale_seconds, self.cfg.max_attempts)
        for task_id in failed:
            task = self.db.get_task(task_id)
            await self._notify_failed(task, "This research was interrupted (the bot stopped while it was running) and could not be resumed. Send it again to retry.")
        for task_id in self.db.pending_task_ids():
            if task_id not in self._jobs:
                if task_id in requeued:
                    log.info("recovering abandoned task %s", task_id)
                self.start(task_id, 0.0)

    async def run_sweeper(self, interval: float = 30.0) -> None:
        while not self._closing:
            try:
                await self.recover()
            except Exception:
                log.exception("recovery sweep failed")
            await asyncio.sleep(interval)

    def start_sweeper(self, interval: float = 30.0) -> None:
        self._sweeper = asyncio.get_running_loop().create_task(self.run_sweeper(interval), name="sweeper")

    async def wait_idle(self, timeout: float = 600.0) -> None:
        """Block until no jobs are running (used by tests and the one-shot runner)."""
        deadline = time.monotonic() + timeout
        while self._jobs and time.monotonic() < deadline:
            await asyncio.sleep(0.05)

    async def shutdown(self) -> None:
        """Stop work and hand our in-flight tasks back to PENDING so the next start resumes them."""
        self._closing = True
        jobs = list(self._jobs.values()) + ([self._sweeper] if self._sweeper else [])
        for job in jobs:
            job.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)
        self.db._run("UPDATE research_tasks SET status='PENDING', worker_id=NULL, stage='interrupted' "
                     "WHERE worker_id=? AND status='PROCESSING'", (self.worker_id,))
