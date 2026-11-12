"""Optional daily research. Off unless SCHEDULER_ENABLED=true and the user set /schedule.

No cron service and no extra dependency: a loop wakes every 30 seconds and asks "is a run
due today that has not been recorded yet?". The scheduled_runs table (one row per user per
local date) is the idempotency record, so restarts, slow wake-ups and double processes can
never produce two runs for the same day. If the bot was down at the scheduled minute the
run happens when it comes back, as long as that is within SCHEDULE_CATCHUP_HOURS.
"""
from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .config import Config
from .db import Database

log = logging.getLogger(__name__)


def valid_time(text: str) -> str | None:
    match = re.fullmatch(r"\s*(\d{1,2})[:.](\d{2})\s*", text or "")
    if not match or int(match.group(1)) > 23 or int(match.group(2)) > 59:
        return None
    return f"{int(match.group(1)):02d}:{match.group(2)}"


def valid_timezone(name: str) -> bool:
    try:
        ZoneInfo(name)
        return True
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        return False


def due_runs(db: Database, now_utc: datetime, catchup_hours: float) -> list[tuple]:
    """(schedule_row, local_date) for every schedule whose time has passed today, within the catch-up window."""
    due = []
    for schedule in db.enabled_schedules():
        try:
            zone = ZoneInfo(schedule["timezone"])
        except (ZoneInfoNotFoundError, ValueError, KeyError):
            log.warning("schedule for user %s has an invalid timezone %r", schedule["user_id"], schedule["timezone"])
            continue
        local = now_utc.astimezone(zone)  # zoneinfo applies daylight-saving rules for us
        hour, minute = (int(p) for p in schedule["run_time"].split(":"))
        target = local.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if target <= local <= target + timedelta(hours=catchup_hours):
            due.append((schedule, local.strftime("%Y-%m-%d")))
    return due


def fire_due(cfg: Config, db: Database, runner, now_utc: datetime | None = None) -> list[int]:
    """Create today's scheduled task(s). Safe to call as often as you like."""
    started = []
    for schedule, run_date in due_runs(db, now_utc or datetime.now(timezone.utc), cfg.schedule_catchup_hours):
        user = db.get_user(schedule["user_id"])
        if not user or not user["chat_id"] or schedule["user_id"] not in cfg.allowed_user_ids:
            continue
        if not db.claim_scheduled_run(schedule["user_id"], run_date):
            continue  # already ran (or is running) for this date
        result = runner.submit(user_id=schedule["user_id"], chat_id=user["chat_id"], question=schedule["objective"],
                               origin="schedule", salt=f"schedule:{run_date}", delay=0.0)
        if result.task:
            db.set_scheduled_run_task(schedule["user_id"], run_date, result.task["id"])
            started.append(result.task["id"])
            log.info("scheduled research %s started for %s", result.task["id"], run_date)
    return started


async def scheduler_loop(cfg: Config, db: Database, runner, interval: float = 30.0) -> None:
    log.info("scheduler enabled (default timezone %s)", cfg.default_timezone)
    while True:
        try:
            fire_due(cfg, db, runner)
        except Exception:
            log.exception("scheduler tick failed")
        await asyncio.sleep(interval)
