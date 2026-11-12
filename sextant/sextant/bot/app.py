"""Telegram interface: commands, images, inline keyboards and report delivery.

Handlers stay thin. They validate input, read/write SQLite and hand research to the Runner,
which works in the background, so the bot stays responsive while a task runs.
"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import time

from telegram import BotCommand, InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.constants import ChatAction, ParseMode
from telegram.error import BadRequest, TelegramError
from telegram.ext import (Application, ApplicationBuilder, ApplicationHandlerStop, CallbackQueryHandler, CommandHandler,
                          ContextTypes, MessageHandler, TypeHandler, filters)

from .. import context as ctx
from ..config import DEPTHS, Config
from ..images import ImageRejected, summarise_image
from ..research.runner import Notifier
from ..scheduler import scheduler_loop, valid_time, valid_timezone
from ..services import Services, build_services
from ..textutil import clip, parse_research_id, research_id
from .formatting import esc, md_to_html, split_message, strip_html

log = logging.getLogger(__name__)

MAX_QUESTION = 2000
MAX_CONTEXT = 1500
INLINE_CHUNKS = 5  # longer reports are delivered as a summary plus a file
STATUS_ICON = {"PENDING": "⏳", "PROCESSING": "⚙️", "COMPLETED": "✅", "FAILED": "❌", "CANCELLED": "🚫"}

HELP = """<b>Sextant — personal research &amp; intelligence</b>

<b>Research</b>
/search &lt;question&gt; — run a research task
/quick &lt;question&gt; · /deep &lt;question&gt; — lighter or deeper run
Send a photo with a caption — research using the image
Send photos first, then /search — they are attached automatically
/status — running tasks and today's usage
/cancel [R-id] — cancel a running task

<b>History</b> (read from the database, never regenerated)
/history — all previous tasks
/recent — latest completed reports
/view &lt;R-id&gt; — open a stored report

<b>Context</b>
/setcontext [category:] text — save persistent context
/context — list it · /editcontext C12 text · /delcontext C12
/clearcontext — wipe it (asks first)
/profile — how I understand your interests

<b>Automation</b> (optional)
/schedule — daily research, e.g. <code>/schedule 05:00 Nigeria solar market news</code>

Categories for /setcontext: general, interests, objectives, projects, geography, industries, preferences, constraints."""


def kb(*rows) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[InlineKeyboardButton(text, callback_data=data) for text, data in row] for row in rows])


class SextantBot(Notifier):
    def __init__(self, cfg: Config, **overrides):
        self.cfg = cfg
        self.svc: Services = build_services(cfg, self, **overrides)  # overrides: db/ai/search/fetcher (tests)
        self.db, self.runner = self.svc.db, self.svc.runner
        self.app: Application | None = None
        self._denied: dict[int, float] = {}
        self._albums: dict[int, asyncio.Task] = {}
        self._album_deadline: dict[int, float] = {}
        self._background: list[asyncio.Task] = []

    # ------------------------------------------------------------ plumbing
    def build(self) -> Application:
        builder = ApplicationBuilder().token(self.cfg.bot_token).post_init(self._post_init).post_stop(self._post_stop)
        if self.cfg.telegram_base_url:
            builder = builder.base_url(f"{self.cfg.telegram_base_url}/bot").base_file_url(f"{self.cfg.telegram_base_url}/file/bot")
        app = builder.build()
        app.add_handler(TypeHandler(Update, self.gate), group=-1)
        commands = {
            "start": self.cmd_start, "help": self.cmd_start, "search": self.cmd_search, "quick": self.cmd_search,
            "deep": self.cmd_search, "history": self.cmd_history, "recent": self.cmd_recent, "view": self.cmd_view,
            "context": self.cmd_context, "setcontext": self.cmd_setcontext, "editcontext": self.cmd_editcontext,
            "delcontext": self.cmd_delcontext, "clearcontext": self.cmd_clearcontext, "profile": self.cmd_profile,
            "cancel": self.cmd_cancel, "status": self.cmd_status, "schedule": self.cmd_schedule,
        }
        for name, handler in commands.items():
            app.add_handler(CommandHandler(name, handler))
        app.add_handler(MessageHandler(filters.PHOTO | filters.Document.IMAGE, self.on_image))
        app.add_handler(MessageHandler(filters.Document.ALL, self.on_other_file))
        app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, self.on_text))
        app.add_handler(MessageHandler(filters.COMMAND, self.on_unknown_command))
        app.add_handler(CallbackQueryHandler(self.on_callback))
        app.add_error_handler(self.on_error)
        self.app = app
        return app

    async def _post_init(self, app: Application) -> None:
        log.info("AI providers: %s | search: %s", self.svc.ai.describe(), self.svc.search.describe())
        if not self.svc.ai.has_text:
            log.warning("No AI provider configured: research will be refused until one is set in .env")
        self.db.prune_caches()
        self.runner.start_sweeper()
        if self.cfg.scheduler_enabled:
            self._background.append(asyncio.create_task(scheduler_loop(self.cfg, self.db, self.runner), name="scheduler"))
        try:
            await app.bot.set_my_commands([
                BotCommand("search", "Research a question"), BotCommand("status", "Running tasks and usage"),
                BotCommand("history", "Previous research"), BotCommand("recent", "Recent reports"),
                BotCommand("view", "Open a stored report"), BotCommand("context", "Show saved context"),
                BotCommand("setcontext", "Save context"), BotCommand("clearcontext", "Clear context"),
                BotCommand("profile", "How I understand you"), BotCommand("cancel", "Cancel research"),
                BotCommand("schedule", "Daily research (optional)"), BotCommand("help", "Commands"),
            ])
        except TelegramError:
            log.warning("could not register the command menu", exc_info=True)

    async def _post_stop(self, app: Application) -> None:
        for job in self._background + list(self._albums.values()):
            job.cancel()
        await self.svc.aclose()

    async def gate(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        """Runs before every handler: authorise, then drop updates we have already processed."""
        user = update.effective_user
        if user is None:
            raise ApplicationHandlerStop
        if user.id not in self.cfg.allowed_user_ids:
            log.warning("denied access to user %s (@%s)", user.id, user.username)
            if time.monotonic() - self._denied.get(user.id, -1e9) > 600:  # do not let strangers make us spam
                self._denied[user.id] = time.monotonic()
                try:
                    if update.callback_query:
                        await update.callback_query.answer("Access denied.", show_alert=True)
                    elif update.effective_chat:
                        await context.bot.send_message(update.effective_chat.id,
                                                       f"⛔ Access denied. This is a private bot.\nYour Telegram ID: {user.id}")
                except TelegramError:
                    pass
            raise ApplicationHandlerStop
        if not self.db.claim_update(update.update_id):
            log.info("ignoring duplicate update %s", update.update_id)
            raise ApplicationHandlerStop
        self.db.upsert_user(user.id, user.username, update.effective_chat.id if update.effective_chat else None)

    async def on_error(self, update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
        log.error("handler error", exc_info=context.error)
        if isinstance(update, Update) and update.effective_chat:
            try:
                await context.bot.send_message(update.effective_chat.id, "Something went wrong handling that. It has been logged.")
            except TelegramError:
                pass

    async def send(self, chat_id: int, text: str, markup: InlineKeyboardMarkup | None = None, html: bool = True):
        """Send one message, falling back to plain text if Telegram rejects the markup."""
        bot = self.app.bot
        try:
            return await bot.send_message(chat_id, text, parse_mode=ParseMode.HTML if html else None, reply_markup=markup,
                                          disable_web_page_preview=True)
        except BadRequest as exc:
            if not html:
                raise
            log.warning("HTML rejected by Telegram (%s); sending as plain text", exc)
            return await bot.send_message(chat_id, strip_html(text)[:4096], reply_markup=markup, disable_web_page_preview=True)

    def session(self, user_id: int) -> dict:
        return self.db.get_session(user_id)

    # ------------------------------------------------- Notifier (runner -> user)
    async def progress(self, task, text: str) -> None:
        row = self.db.get_task(task["id"])
        line = f"{text}\n<i>{research_id(task['id'])} · {esc(clip(task['question'], 120))}</i>"
        markup = kb([("✖ Cancel", f"c:{task['id']}")])
        if row and row["status_msg_id"]:
            try:
                await self.app.bot.edit_message_text(line, chat_id=task["chat_id"], message_id=row["status_msg_id"],
                                                     parse_mode=ParseMode.HTML, reply_markup=markup)
                return
            except BadRequest as exc:
                if "not modified" in str(exc).lower():
                    return
        message = await self.send(task["chat_id"], line, markup)
        self.db.set_status_message(task["id"], message.message_id)

    async def _finish_status(self, task, text: str) -> None:
        if task["status_msg_id"]:
            try:
                await self.app.bot.edit_message_text(text, chat_id=task["chat_id"], message_id=task["status_msg_id"], parse_mode=ParseMode.HTML)
                return
            except TelegramError:
                pass
        await self.send(task["chat_id"], text)

    async def completed(self, task) -> None:
        note = " (scheduled)" if task["origin"] == "schedule" else ""
        await self._finish_status(task, f"✅ Research completed{note}: <b>{research_id(task['id'])}</b>")
        await self.send_report(task["chat_id"], task["id"])

    async def failed(self, task, message: str) -> None:
        await self._finish_status(task, f"❌ <b>{research_id(task['id'])}</b> did not complete.")
        await self.send(task["chat_id"], f"❌ {esc(message)}\n\n<i>{esc(clip(task['question'], 200))}</i>")

    # -------------------------------------------------------------- reports
    def report_keyboard(self, task_id: int) -> InlineKeyboardMarkup:
        return kb([("🔗 View sources", f"s:{task_id}"), ("📎 Download", f"f:{task_id}")],
                  [("💾 Save context", f"k:{task_id}"), ("🧭 Related research", f"r:{task_id}")],
                  [("🔄 Run fresh research", f"x:{task_id}")])

    async def send_report(self, chat_id: int, task_id: int) -> None:
        """Deliver a stored report. Pure database read: no AI, no search."""
        report = self.db.get_report(task_id)
        if not report:
            await self.send(chat_id, "That report is not available.")
            return
        chunks = split_message(md_to_html(report["report_md"]))
        markup = self.report_keyboard(task_id)
        if len(chunks) <= INLINE_CHUNKS:
            for index, chunk in enumerate(chunks):
                await self.send(chat_id, chunk, markup if index == len(chunks) - 1 else None)
            return
        await self.send(chat_id, f"<b>{esc(report['title'])}</b>\n<i>{research_id(task_id)}</i>\n\n<b>Executive summary</b>\n"
                                 f"{esc(report['summary'])}\n\nThe full report is long, so it is attached as a file.")
        await self.send_file(chat_id, task_id, markup)

    async def send_file(self, chat_id: int, task_id: int, markup: InlineKeyboardMarkup | None = None) -> None:
        report = self.db.get_report(task_id)
        data = io.BytesIO(report["report_md"].encode("utf-8"))
        await self.app.bot.send_document(chat_id, document=data, filename=f"{research_id(task_id)}.md",
                                         caption=clip(report["title"], 200), reply_markup=markup)

    async def send_sources(self, chat_id: int, task_id: int) -> None:
        sources = self.db.get_sources(task_id)
        if not sources:
            await self.send(chat_id, "No sources are stored for that report.")
            return
        lines = [f"<b>Sources for {research_id(task_id)}</b>"]
        for s in sources:
            facts = json.loads(s["evidence"] or "[]")
            detail = " · ".join(x for x in (s["source_type"], s["published"], f"{len(facts)} facts used") if x and x != "unknown")
            lines.append(f'[S{s["num"]}] <a href="{esc(s["url"])}">{esc(clip(s["title"] or s["domain"], 90))}</a>\n     {esc(s["domain"])} · {esc(detail)}')
        for chunk in split_message("\n".join(lines)):
            await self.send(chat_id, chunk)

    # ------------------------------------------------------------- commands
    async def cmd_start(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        intro = ""
        if update.message.text.startswith("/start"):
            intro = ("👋 I research questions for you on the open web, weigh the evidence and report what it means for "
                     "your decisions. I remember the context you give me and can read images you send.\n\n")
        await self.send(update.effective_chat.id, intro + HELP)

    async def cmd_search(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        command = update.message.text.split()[0].lstrip("/").split("@")[0].lower()
        depth = command if command in DEPTHS else None
        await self.launch(update.effective_user.id, update.effective_chat.id, " ".join(context.args), update.update_id, depth=depth)

    async def launch(self, user_id: int, chat_id: int, question: str, update_id: int | None = None, *, fresh: bool = False,
                     depth: str | None = None, task_context: str = "", image_ids: list[int] | None = None) -> None:
        """Common entry point for every way of starting research."""
        question = question.strip()
        session = self.session(user_id)
        staged = image_ids if image_ids is not None else list(session.get("staged", []))
        if not question:
            hint = f" ({len(staged)} image(s) are waiting to be attached.)" if staged else ""
            await self.send(chat_id, "Tell me what to research, e.g.\n<code>/search Who are the main solar installers in Lagos and "
                                     f"who could I partner with?</code>{hint}")
            return
        if len(question) > MAX_QUESTION:
            await self.send(chat_id, f"That question is too long ({len(question)} characters; the limit is {MAX_QUESTION}).")
            return
        if not self.svc.ai.has_text:
            await self.send(chat_id, "No AI provider is configured, so I cannot research yet. Add GEMINI_API_KEY (or another "
                                     "provider) to .env and restart. See the README.")
            return
        result = self.runner.submit(user_id=user_id, chat_id=chat_id, question=question, task_context=task_context,
                                    image_ids=staged, fresh=fresh, update_id=update_id, depth=depth)
        if result.kind == "rate_limited":
            await self.send(chat_id, f"You have started {self.cfg.max_research_per_hour} research tasks in the last hour, which is the "
                                     "configured limit. Try again a little later.")
            return
        task = result.task
        rid = research_id(task["id"])
        if result.kind == "running":
            await self.send(chat_id, f"⚙️ I am already working on this exact request as <b>{rid}</b> "
                                     f"({esc(task['stage'] or task['status'].lower())}). I will not start it twice.",
                            kb([("✖ Cancel it", f"c:{task['id']}")]))
            return
        if result.kind == "existing":
            report = self.db.get_report(task["id"])
            await self.send(chat_id, f"📁 You already have a report for this request:\n<b>{rid}</b> — {esc(report['title'] if report else '')}\n"
                                     f"Completed {esc((task['finished_at'] or '')[:10])}.\n\nOpen it, or run it again from scratch?",
                            kb([("📄 View report", f"v:{task['id']}")], [("🔄 Run fresh research", f"x:{task['id']}")]))
            return
        if image_ids is None:
            session["staged"] = []
        session.pop("pending_text", None)
        self.db.set_session(user_id, session)
        window = int(self.cfg.attach_window)
        extra = f"\n🖼 {len(staged)} image(s) attached." if staged else ""
        wait = (f"\n\nStarting in {window}s. Send images or extra context now to attach them." if window >= 1 else "")
        message = await self.send(chat_id, f"🔎 Research request received: <b>{rid}</b>\n<i>{esc(clip(question, 300))}</i>{extra}{wait}",
                                  kb([("▶ Start now", f"go:{task['id']}"), ("✖ Cancel", f"c:{task['id']}")]))
        self.db.set_status_message(task["id"], message.message_id)

    async def cmd_history(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        await self.show_history(update.effective_chat.id, update.effective_user.id, 0)

    async def show_history(self, chat_id: int, user_id: int, offset: int) -> None:
        tasks = self.db.list_tasks(user_id, limit=11, offset=offset)
        if not tasks:
            await self.send(chat_id, "No research yet. Start with /search." if offset == 0 else "No older research.")
            return
        page, more = tasks[:10], len(tasks) > 10
        lines = ["<b>Research history</b>"]
        buttons = []
        for t in page:
            label = t["title"] or t["question"]
            lines.append(f"{STATUS_ICON[t['status']]} <b>{research_id(t['id'])}</b> · {esc(t['created_at'][:10])} · {esc(clip(label, 80))}")
            if t["status"] == "COMPLETED":
                buttons.append((research_id(t["id"]), f"v:{t['id']}"))
        rows = [buttons[i:i + 5] for i in range(0, len(buttons), 5)]
        if more:
            rows.append([("Older ▸", f"h:{offset + 10}")])
        lines.append("\nOpen one with /view R-00001 or the buttons below.")
        await self.send(chat_id, "\n".join(lines), kb(*rows) if rows else None)

    async def cmd_recent(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        tasks = self.db.list_tasks(update.effective_user.id, limit=5, status="COMPLETED")
        if not tasks:
            await self.send(update.effective_chat.id, "No completed research yet.")
            return
        lines = ["<b>Recently completed</b>"]
        for t in tasks:
            report = self.db.get_report(t["id"])
            lines.append(f"\n<b>{research_id(t['id'])}</b> · {esc((t['finished_at'] or '')[:10])}\n<b>{esc(t['title'] or t['question'])}</b>\n"
                         f"{esc(clip(report['summary'] if report else '', 260))}")
        await self.send(update.effective_chat.id, "\n".join(lines), kb([(research_id(t["id"]), f"v:{t['id']}") for t in tasks]))

    async def cmd_view(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        task_id = parse_research_id(" ".join(context.args))
        if task_id is None:
            await self.send(update.effective_chat.id, "Usage: <code>/view R-00012</code> (see /history for IDs)")
            return
        await self.view(update.effective_chat.id, update.effective_user.id, task_id)

    async def view(self, chat_id: int, user_id: int, task_id: int) -> None:
        task = self.db.get_task(task_id, user_id)
        if not task:
            await self.send(chat_id, f"I have no research with the ID {research_id(task_id)}.")
        elif task["status"] == "COMPLETED":
            await self.send_report(chat_id, task_id)
        elif task["status"] in ("PENDING", "PROCESSING"):
            await self.send(chat_id, f"{research_id(task_id)} is still running ({esc(task['stage'] or 'queued')}).")
        else:
            await self.send(chat_id, f"{research_id(task_id)} has no report: it was {task['status'].lower()}."
                                     + (f"\nReason: {esc(clip(task['error'], 300))}" if task["error"] else ""))

    async def cmd_context(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        await self.send(update.effective_chat.id, ctx.format_context(self.db, update.effective_user.id), html=False)

    async def cmd_setcontext(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        text = update.message.text.partition(" ")[2].strip()
        if not text:
            await self.send(update.effective_chat.id, "Usage: <code>/setcontext objectives: find distribution partners in West Africa</code>\n"
                                                      "Categories: " + ", ".join(k for k in ctx.CATEGORIES if k != "image"))
            return
        await self.save_context(update.effective_chat.id, update.effective_user.id, text)

    async def save_context(self, chat_id: int, user_id: int, text: str) -> None:
        category, content = ctx.parse_category(text)
        if len(content) > MAX_CONTEXT:
            await self.send(chat_id, f"That is too long for one context entry ({len(content)} characters; limit {MAX_CONTEXT}). Split it up.")
            return
        context_id = self.db.add_context(user_id, category, content)
        markup = None
        if category == "general":  # let the user file it properly with one tap
            options = [(label.split()[-1].capitalize(), f"cat:{context_id}:{key}") for key, label in ctx.CATEGORIES.items()
                       if key not in ("general", "image")]
            markup = kb(options[:4], options[4:])
        await self.send(chat_id, f"💾 Saved as <b>C{context_id}</b> under <b>{esc(ctx.CATEGORIES[category])}</b>.\n<i>{esc(clip(content, 300))}</i>"
                                 + ("\n\nFile it under a more specific category?" if markup else ""), markup)

    async def cmd_editcontext(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        args = context.args
        context_id = int(args[0].lstrip("Cc")) if args and args[0].lstrip("Cc").isdigit() else None
        text = update.message.text.partition(" ")[2].partition(" ")[2].strip()
        if context_id is None or not text:
            await self.send(update.effective_chat.id, "Usage: <code>/editcontext C12 the corrected text</code>")
            return
        ok = len(text) <= MAX_CONTEXT and self.db.update_context(update.effective_user.id, context_id, content=text)
        await self.send(update.effective_chat.id, f"✏️ C{context_id} updated." if ok else f"I could not update C{context_id} (not found, or text too long).")

    async def cmd_delcontext(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        args = context.args
        if not args or not args[0].lstrip("Cc").isdigit():
            await self.send(update.effective_chat.id, "Usage: <code>/delcontext C12</code>")
            return
        context_id = int(args[0].lstrip("Cc"))
        ok = self.db.delete_context(update.effective_user.id, context_id)
        await self.send(update.effective_chat.id, f"🗑 C{context_id} removed." if ok else f"There is no context entry C{context_id}.")

    async def cmd_clearcontext(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        count = len(self.db.list_context(update.effective_user.id))
        if not count:
            await self.send(update.effective_chat.id, "There is no saved context to clear.")
            return
        await self.send(update.effective_chat.id, f"This will permanently delete all {count} saved context entries. Research history is kept. Are you sure?",
                        kb([("🗑 Yes, delete all", "cc:yes"), ("Keep it", "cc:no")]))

    async def cmd_profile(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        await self.send(update.effective_chat.id, ctx.format_profile(self.db, update.effective_user.id), html=False)

    async def cmd_cancel(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        user_id, chat_id = update.effective_user.id, update.effective_chat.id
        active = self.db.active_tasks(user_id)
        if not active:
            await self.send(chat_id, "Nothing is running.")
            return
        wanted = parse_research_id(" ".join(context.args)) if context.args else active[-1]["id"]
        if wanted is None or wanted not in [t["id"] for t in active]:
            await self.send(chat_id, "That is not a running task. Running: " + ", ".join(research_id(t["id"]) for t in active))
            return
        self.runner.cancel(wanted, user_id)
        others = [research_id(t["id"]) for t in active if t["id"] != wanted]
        await self.send(chat_id, f"🚫 {research_id(wanted)} cancelled." + (f" Still running: {', '.join(others)}" if others else ""))

    async def cmd_status(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        user_id = update.effective_user.id
        lines = ["<b>Status</b>"]
        active = self.db.active_tasks(user_id)
        if active:
            for t in active:
                lines.append(f"{STATUS_ICON[t['status']]} <b>{research_id(t['id'])}</b> · {esc(t['stage'] or 'queued')} · {esc(clip(t['question'], 70))}")
        else:
            lines.append("No research is running.")
        staged = self.session(user_id).get("staged", [])
        if staged:
            lines.append(f"🖼 {len(staged)} image(s) staged for your next question.")
        lines.append(f"\n<b>Providers</b>\nAI: {esc(self.svc.ai.describe())}\nSearch: {esc(self.svc.search.describe())}\n"
                     f"Depth: {self.cfg.default_depth} · Vision: {'yes' if self.svc.ai.has_vision else 'not configured'}")
        usage = self.db.usage_summary(time.time() - 86400)
        if usage:
            lines.append("\n<b>Last 24h usage</b>")
            for u in usage:
                tokens_used = (u["prompt_tokens"] or 0) + (u["completion_tokens"] or 0)
                lines.append(f"{esc(u['provider'])} {u['kind']}: {u['requests']} requests ({u['requests'] - (u['ok'] or 0)} failed)"
                             + (f", ~{tokens_used:,} tokens" if tokens_used else ""))
            lines.append(f"Local ceiling: {self.cfg.ai_daily_request_limit} AI requests per provider per 24h.")
        await self.send(update.effective_chat.id, "\n".join(lines), kb(*[[(f"✖ Cancel {research_id(t['id'])}", f"c:{t['id']}")] for t in active]) if active else None)

    async def cmd_schedule(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        user_id, chat_id, args = update.effective_user.id, update.effective_chat.id, context.args
        current = self.db.get_schedule(user_id)
        off_note = "" if self.cfg.scheduler_enabled else "\n\n⚠️ SCHEDULER_ENABLED is false, so nothing will run automatically until it is switched on (see README)."
        if not args:
            if current and current["objective"]:
                state = "on" if current["enabled"] else "off"
                await self.send(chat_id, f"<b>Daily research is {state}</b>\nTime: {current['run_time']} ({esc(current['timezone'])})\n"
                                         f"Objective: <i>{esc(current['objective'])}</i>\n\nChange: <code>/schedule 05:00 objective</code> · "
                                         f"<code>/schedule tz Africa/Lagos</code> · <code>/schedule off</code>{off_note}")
            else:
                await self.send(chat_id, "No daily research is set. It never runs without an objective.\n\n"
                                         f"Set one: <code>/schedule 05:00 Key developments in Nigeria's solar market</code>{off_note}")
            return
        timezone_name = current["timezone"] if current else self.cfg.default_timezone
        if args[0].lower() in ("off", "on"):
            if not current or not current["objective"]:
                await self.send(chat_id, "There is no schedule to switch. Set one first.")
                return
            enabled = args[0].lower() == "on"
            self.db.set_schedule(user_id, objective=current["objective"], run_time=current["run_time"], timezone=timezone_name, enabled=enabled)
            await self.send(chat_id, f"Daily research switched {'on' if enabled else 'off'}.{off_note if enabled else ''}")
            return
        if args[0].lower() == "tz":
            if len(args) < 2 or not valid_timezone(args[1]):
                await self.send(chat_id, "Give an IANA timezone, e.g. <code>/schedule tz Africa/Lagos</code>")
                return
            self.db.set_schedule(user_id, objective=current["objective"] if current else "", run_time=current["run_time"] if current else "05:00",
                                 timezone=args[1], enabled=bool(current["enabled"]) if current else False)
            await self.send(chat_id, f"Timezone set to {esc(args[1])}.")
            return
        run_time = valid_time(args[0])
        objective = " ".join(args[1:]).strip()
        if not run_time or len(objective) < 8:
            await self.send(chat_id, "Usage: <code>/schedule 05:00 what to research every day</code>")
            return
        self.db.set_schedule(user_id, objective=objective[:MAX_QUESTION], run_time=run_time, timezone=timezone_name, enabled=True)
        await self.send(chat_id, f"⏰ Daily research set for {run_time} ({esc(timezone_name)}):\n<i>{esc(objective)}</i>{off_note}")

    async def on_unknown_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        await self.send(update.effective_chat.id, "I do not know that command. /help lists what I can do.")

    # ------------------------------------------------------ text and images
    async def on_text(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        user_id, chat_id = update.effective_user.id, update.effective_chat.id
        text = (update.message.text or "").strip()
        if not text:
            return
        collecting = self.runner.collecting(user_id)
        if collecting and len(text) <= MAX_CONTEXT and self.runner.attach(collecting["id"], extra_context=text):
            await self.send(chat_id, f"➕ Added to <b>{research_id(collecting['id'])}</b> as context for this task only.")
            return
        if len(text) > MAX_QUESTION:
            await self.send(chat_id, "That message is too long for me to use.")
            return
        session = self.session(user_id)
        session["pending_text"] = text
        self.db.set_session(user_id, session)
        staged = len(session.get("staged", []))
        with_images = f" with your {staged} staged image(s)" if staged else ""
        await self.send(chat_id, f"What should I do with this?\n<i>{esc(clip(text, 300))}</i>",
                        kb([(f"🔎 Research it{with_images}", "q:go")], [("💾 Save as context", "q:ctx"), ("✖ Ignore", "q:no")]))

    async def on_other_file(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        await self.send(update.effective_chat.id, "I can only read images (JPEG, PNG, WebP, GIF) for now, not other files.")

    async def on_image(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        user_id, chat_id, message = update.effective_user.id, update.effective_chat.id, update.message
        media = message.photo[-1] if message.photo else message.document
        try:
            image_id = self.svc.images.register(user_id, media.file_id, media.file_unique_id, getattr(media, "mime_type", "") or "image/jpeg",
                                                media.file_size or 0)
            if self.svc.images.needs_download(image_id):
                telegram_file = await context.bot.get_file(media.file_id)
                self.svc.images.ingest(image_id, bytes(await telegram_file.download_as_bytearray()))
        except ImageRejected as exc:
            await self.send(chat_id, f"🖼 {esc(exc)}")
            return
        except TelegramError as exc:
            await self.send(chat_id, f"🖼 I could not download that image from Telegram ({esc(exc)}). Please send it again.")
            return

        caption = (message.caption or "").strip()
        if caption.lower().startswith("/search"):
            caption = caption[7:].strip()
        collecting = self.runner.collecting(user_id)
        if collecting and not caption:
            if self.runner.attach(collecting["id"], image_id=image_id):
                await self.send(chat_id, f"🖼 Image received and attached to <b>{research_id(collecting['id'])}</b>.")
            else:
                await self.send(chat_id, f"🖼 {research_id(collecting['id'])} already has the maximum of {self.cfg.max_images_per_task} images.")
            return

        session = self.session(user_id)
        staged = [i for i in session.get("staged", []) if i != image_id] + [image_id]
        session["staged"] = staged[-self.cfg.max_images_per_task:]
        if caption:
            session["album_question"] = caption
        self.db.set_session(user_id, session)

        if caption or (message.media_group_id and session.get("album_question") and user_id in self._albums):
            # A captioned photo is a research request. Albums arrive as separate updates, so wait briefly for the rest.
            self._album_deadline[user_id] = time.monotonic() + (2.0 if message.media_group_id else 0.0)
            if user_id not in self._albums or self._albums[user_id].done():
                self._albums[user_id] = asyncio.create_task(self._launch_album(user_id, chat_id, update.update_id))
            return

        await context.bot.send_chat_action(chat_id, ChatAction.TYPING)
        row = await self.svc.images.analyse(image_id)
        if row["status"] == "ANALYSED":
            seen = f"I can see: <i>{esc(summarise_image(row))}</i>"
        elif not self.svc.ai.has_vision:
            seen = "No vision-capable provider is configured, so I cannot read it yet (see README)."
        else:
            seen = f"I could not analyse it right now ({esc(clip(row['error'] or '', 150))}); I will retry when research starts."
        await self.send(chat_id, f"🖼 Image saved ({len(session['staged'])} staged). {seen}\n\nWhat should I investigate? Send your question "
                                 "and I will use the staged image(s), or choose:",
                        kb([("💾 Save as context", "im:ctx"), ("🗑 Discard", "im:drop")]))

    async def _launch_album(self, user_id: int, chat_id: int, update_id: int) -> None:
        while time.monotonic() < self._album_deadline.get(user_id, 0.0):
            await asyncio.sleep(0.2)
        self._albums.pop(user_id, None)
        session = self.session(user_id)
        question = session.pop("album_question", "")
        self.db.set_session(user_id, session)
        if question:
            await self.launch(user_id, chat_id, question, update_id)

    # ------------------------------------------------------------ callbacks
    async def on_callback(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        query = update.callback_query
        user_id, chat_id = update.effective_user.id, update.effective_chat.id
        action, _, arg = (query.data or "").partition(":")
        notice = None

        async def clear_buttons() -> None:
            try:
                await query.edit_message_reply_markup(None)
            except TelegramError:
                pass

        if action in ("v", "s", "f", "k", "r", "x", "go", "c"):
            task = self.db.get_task(int(arg), user_id) if arg.isdigit() else None
            if not task:
                await query.answer("That research no longer exists.", show_alert=True)
                return
            task_id = task["id"]
            await query.answer()
            if action == "v":
                await self.view(chat_id, user_id, task_id)
            elif action == "s":
                await self.send_sources(chat_id, task_id)
            elif action == "f" and task["status"] == "COMPLETED":
                await self.send_file(chat_id, task_id)
            elif action == "r":
                related = ctx.related_research(self.db, user_id, task["question"], exclude_task=task_id, limit=5)
                if related:
                    await self.send(chat_id, "<b>Related research</b>\n" + "\n".join(f"<b>{r['rid']}</b> · {esc(clip(r['title'], 90))}" for r in related),
                                    kb([(r["rid"], f"v:{r['id']}") for r in related]))
                else:
                    await self.send(chat_id, "No earlier research overlaps with this topic yet.")
            elif action == "k":
                await self.save_task_context(chat_id, user_id, task)
            elif action == "x":
                await clear_buttons()
                images = [row["id"] for row in self.db.task_images(task_id)]
                await self.launch(user_id, chat_id, task["question"], update.update_id, fresh=True, depth=task["depth"],
                                  task_context=task["task_context"], image_ids=images)
            elif action == "go":
                self.runner.start_now(task_id)
            elif action == "c":
                done = self.runner.cancel(task_id, user_id)
                await clear_buttons()
                await self.send(chat_id, f"🚫 {research_id(task_id)} cancelled." if done else f"{research_id(task_id)} is not running.")
            return

        session = self.session(user_id)
        if action == "q":
            text = session.pop("pending_text", "")
            self.db.set_session(user_id, session)
            await clear_buttons()
            if not text:
                notice = "That message has expired. Please send it again."
            elif arg == "go":
                await query.answer()
                await self.launch(user_id, chat_id, text, update.update_id)
                return
            elif arg == "ctx":
                await query.answer()
                await self.save_context(chat_id, user_id, text)
                return
            else:
                notice = "Ignored."
        elif action == "im":
            staged = session.pop("staged", [])
            self.db.set_session(user_id, session)
            await clear_buttons()
            if arg == "ctx" and staged:
                await query.answer()
                saved = 0
                for image_id in staged:
                    row = await self.svc.images.analyse(image_id)
                    if row["status"] == "ANALYSED":
                        self.db.add_context(user_id, "image", clip(f"From an image you sent: {summarise_image(row)}", MAX_CONTEXT), source="image")
                        saved += 1
                await self.send(chat_id, f"💾 Saved {saved} image summary(ies) as context." if saved else
                                "I could not analyse the image(s), so nothing was saved as context.")
                return
            notice = "Image(s) discarded." if staged else "Nothing staged."
        elif action == "cc":
            await clear_buttons()
            if arg == "yes":
                notice = f"Deleted {self.db.clear_context(user_id)} context entries."
                await self.send(chat_id, "🗑 All saved context has been cleared.")
            else:
                notice = "Context kept."
        elif action == "cat":
            context_id, _, category = arg.partition(":")
            if context_id.isdigit() and category in ctx.CATEGORIES and self.db.update_context(user_id, int(context_id), category=category):
                await clear_buttons()
                notice = f"Filed under {ctx.CATEGORIES[category]}."
            else:
                notice = "Could not update that entry."
        elif action == "h" and arg.isdigit():
            await query.answer()
            await self.show_history(chat_id, user_id, int(arg))
            return
        await query.answer(notice or "")

    async def save_task_context(self, chat_id: int, user_id: int, task) -> None:
        """Promote what was temporary for one task into persistent context, only on request."""
        saved = []
        if task["task_context"]:
            saved.append(self.db.add_context(user_id, "general", clip(task["task_context"], MAX_CONTEXT)))
        for row in self.db.task_images(task["id"]):
            if row["status"] == "ANALYSED":
                saved.append(self.db.add_context(user_id, "image", clip(f"From an image you sent: {summarise_image(row)}", MAX_CONTEXT), source="image"))
        if not saved:
            report = self.db.get_report(task["id"])
            title = report["title"] if report else task["question"]
            saved.append(self.db.add_context(user_id, "projects", clip(f"Researched ({(task['finished_at'] or '')[:10]}): {title}", MAX_CONTEXT), source="research"))
        await self.send(chat_id, "💾 Saved to your persistent context: " + ", ".join(f"C{i}" for i in saved) + ". Review with /context.")


def run(cfg: Config) -> None:
    bot = SextantBot(cfg)
    app = bot.build()
    log.info("Sextant starting (long polling). Authorised users: %s", sorted(cfg.allowed_user_ids))
    app.run_polling(allowed_updates=Update.ALL_TYPES, drop_pending_updates=False)
