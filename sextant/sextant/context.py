"""Persistent user context: categories, relevance retrieval and the /profile view.

Retrieval is deliberately simple (SQLite rows + keyword overlap). Two kinds of record:

* framing records (objectives, preferences, constraints, business interests, general)
  describe *why* the user researches, so they shape every task even with no shared words;
* topical records (projects, geography, industries, image-derived) are only pulled in
  when they share meaningful words with the request.

Nothing here calls an AI model.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

from .db import Database
from .textutil import clip, research_id, tokens

CATEGORIES = {
    "general": "General context",
    "interests": "Business interests",
    "objectives": "Strategic objectives",
    "projects": "Current projects",
    "geography": "Geographic interests",
    "industries": "Industry interests",
    "preferences": "Research preferences",
    "constraints": "Operational constraints",
    "image": "Image-derived context",
}
ALIASES = {
    "interest": "interests", "business": "interests", "business interests": "interests",
    "objective": "objectives", "goal": "objectives", "goals": "objectives", "strategy": "objectives",
    "project": "projects", "geo": "geography", "location": "geography", "locations": "geography",
    "region": "geography", "regions": "geography", "industry": "industries", "sector": "industries",
    "sectors": "industries", "preference": "preferences", "prefs": "preferences", "style": "preferences",
    "constraint": "constraints", "limits": "constraints", "budget": "constraints", "images": "image",
}
FRAMING = ("objectives", "preferences", "constraints", "interests", "general")
MAX_RECORD_CHARS = 1500


@dataclass
class ContextHit:
    id: int
    category: str
    content: str
    updated_at: str
    reason: str

    def as_link(self) -> dict:
        return {"id": self.id, "category": self.category, "content": self.content, "reason": self.reason}


def parse_category(text: str) -> tuple[str, str]:
    """'projects: build a solar distributor' -> ('projects', 'build a solar distributor')."""
    head, sep, rest = text.partition(":")
    key = head.strip().lower()
    if sep and rest.strip() and len(key) <= 20:
        key = ALIASES.get(key, key)
        if key in CATEGORIES:
            return key, rest.strip()
    return "general", text.strip()


def retrieve(db: Database, user_id: int, request_text: str, *, char_budget: int = 1800) -> list[ContextHit]:
    """Pick the context records relevant to this request, newest first within each tier."""
    want = tokens(request_text)
    framing: list[ContextHit] = []
    topical: list[tuple[int, ContextHit]] = []
    for row in db.list_context(user_id):
        overlap = want & tokens(row["content"])
        if row["category"] in FRAMING:
            reason = "standing objective/preference" + (f"; shares: {', '.join(sorted(overlap)[:4])}" if overlap else "")
            framing.append(ContextHit(row["id"], row["category"], row["content"], row["updated_at"], reason))
        elif overlap:
            hit = ContextHit(row["id"], row["category"], row["content"], row["updated_at"],
                             f"matches request on: {', '.join(sorted(overlap)[:4])}")
            topical.append((len(overlap), hit))
    framing.sort(key=lambda h: h.id, reverse=True)
    topical.sort(key=lambda pair: (pair[0], pair[1].id), reverse=True)

    chosen, used = [], 0
    for hit in [h for _, h in topical[:4]] + framing:
        cost = min(len(hit.content), 400)
        if used + cost > char_budget:
            continue
        chosen.append(hit)
        used += cost
    return sorted(chosen, key=lambda h: h.id)


def related_research(db: Database, user_id: int, text: str, *, exclude_task: int | None = None, limit: int = 3) -> list[dict]:
    """Earlier completed reports that overlap this topic (keyword match, no AI)."""
    want = tokens(text)
    scored = []
    for row in db.completed_with_reports(user_id):
        if row["id"] == exclude_task:
            continue
        overlap = want & tokens(f"{row['question']} {row['title']}")
        if len(overlap) >= 2:
            scored.append((len(overlap), row["id"], row))
    scored.sort(reverse=True)
    return [
        {"id": r["id"], "rid": research_id(r["id"]), "title": r["title"], "question": r["question"],
         "summary": r["summary"], "finished_at": r["finished_at"]}
        for _, _, r in scored[:limit]
    ]


def format_context(db: Database, user_id: int) -> str:
    rows = db.list_context(user_id)
    if not rows:
        return ("No saved context yet.\n\nAdd some with /setcontext, for example:\n"
                "/setcontext objectives: find commercial partners and clients in West Africa\n\n"
                "Categories: " + ", ".join(k for k in CATEGORIES if k != "image"))
    lines = ["Your saved context (used only when relevant):"]
    for key, label in CATEGORIES.items():
        group = [r for r in rows if r["category"] == key]
        if group:
            lines.append(f"\n{label}")
            lines += [f"  C{r['id']}  {clip(r['content'], 300)}" for r in group]
    lines.append("\nEdit: /editcontext C12 new text   Remove: /delcontext C12   Wipe: /clearcontext")
    return "\n".join(lines)


def format_profile(db: Database, user_id: int) -> str:
    """What the bot knows, split into what was stated and what is merely observed."""
    rows = db.list_context(user_id)
    lines = ["PROFILE — how I currently understand you", "", "Stated by you (drives research priorities):"]
    stated = [r for r in rows if r["source"] == "user"]
    if stated:
        for key, label in CATEGORIES.items():
            group = [r for r in stated if r["category"] == key]
            if group:
                lines.append(f"• {label}: " + "; ".join(clip(r["content"], 160) for r in group))
    else:
        lines.append("• Nothing yet. Use /setcontext to tell me your objectives and interests.")

    derived = [r for r in rows if r["source"] != "user"]
    if derived:
        lines += ["", "Saved from images or past research (you chose to keep these):"]
        lines += [f"• {clip(r['content'], 160)}" for r in derived]

    history = db.completed_with_reports(user_id, limit=50)
    lines += ["", "Observed from your research history (not treated as a preference):"]
    if history:
        counts: Counter[str] = Counter()
        for row in history:
            counts.update(tokens(row["question"]))
        common = [word for word, n in counts.most_common(8) if n >= 2]
        lines.append(f"• {len(history)} completed report(s).")
        if common:
            lines.append("• Recurring topics: " + ", ".join(common))
        lines.append("• Most recent: " + "; ".join(clip(r["title"] or r["question"], 70) for r in history[:3]))
    else:
        lines.append("• No completed research yet.")
    lines += ["", "I never add to the 'stated' list on my own. Correct anything with /setcontext, /editcontext or /delcontext."]
    return "\n".join(lines)
