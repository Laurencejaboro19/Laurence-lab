"""Run today's scheduled research once and exit: `python -m sextant.oneshot`.

Made for schedulers that start a fresh process (GitHub Actions, cron, Task Scheduler).
No polling happens. The objective comes from the user's /schedule entry in the database,
or from SCHEDULE_OBJECTIVE when the database has none. Idempotent per local calendar day:
a second run on the same date exits without doing anything unless --force is given.
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

from .bot.app import SextantBot
from .config import load_config, require_runtime

log = logging.getLogger("sextant.oneshot")


async def main(force: bool = False) -> int:
    cfg = load_config()
    require_runtime(cfg)
    user_id = int(os.getenv("SCHEDULE_USER_ID") or sorted(cfg.allowed_user_ids)[0])
    bot = SextantBot(cfg)
    app = bot.build()
    db = bot.db
    try:
        db.upsert_user(user_id, None, user_id)  # a private chat's ID equals the user's ID
        schedule = db.get_schedule(user_id)
        objective = (schedule["objective"] if schedule and schedule["enabled"] else "") or os.getenv("SCHEDULE_OBJECTIVE", "").strip()
        zone = (schedule["timezone"] if schedule else "") or cfg.default_timezone
        if not objective:
            log.error("No research objective configured (set SCHEDULE_OBJECTIVE or use /schedule). Nothing was run.")
            return 2
        run_date = datetime.now(ZoneInfo(zone)).strftime("%Y-%m-%d")
        if not db.claim_scheduled_run(user_id, run_date) and not force:
            log.info("Scheduled research for %s has already run. Nothing to do.", run_date)
            return 0
        async with app.bot:
            result = bot.runner.submit(user_id=user_id, chat_id=user_id, question=objective, origin="schedule",
                                       task_context=os.getenv("SCHEDULE_CONTEXT", "").strip(),
                                       salt=f"schedule:{run_date}" + (":forced" if force else ""), delay=0.0)
            if result.kind != "created":
                log.info("Not started (%s).", result.kind)
                return 0
            db.set_scheduled_run_task(user_id, run_date, result.task["id"])
            await bot.runner.wait_idle(timeout=float(os.getenv("ONESHOT_TIMEOUT_SECONDS", "1500")))
            status = db.get_task(result.task["id"])["status"]
            log.info("Scheduled research finished with status %s", status)
            return 0 if status == "COMPLETED" else 1
    finally:
        await bot.svc.aclose()


if __name__ == "__main__":
    logging.basicConfig(level="INFO", format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    sys.exit(asyncio.run(main(force="--force" in sys.argv)))
