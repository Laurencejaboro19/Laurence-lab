"""The deep-research pipeline: understand -> plan -> search -> read -> evaluate -> iterate -> report.

Every loop is bounded by the task's Depth preset and Budget. The pipeline either returns a
report built only from fetched evidence, or raises ResearchFailed with a message the user
can act on. It never produces a report when it has no evidence.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone

from ..config import Config, Depth
from ..context import ContextHit, related_research, retrieve
from ..db import Database
from ..providers.ai import AIRouter, AllProvidersExhausted, Budget, BudgetExceeded
from ..providers.search import SearchRouter
from ..textutil import clip, domain_of, extract_json, normalize_url, registered_domain, research_id, tokens
from . import prompts
from .fetch import Fetcher

log = logging.getLogger(__name__)

REPUTABLE_NEWS = {
    "reuters.com", "bloomberg.com", "ft.com", "bbc.com", "bbc.co.uk", "apnews.com", "nytimes.com", "wsj.com",
    "economist.com", "aljazeera.com", "theguardian.com", "cnbc.com", "forbes.com", "techcrunch.com", "nature.com",
    "premiumtimesng.com", "punchng.com", "businessday.ng", "nairametrics.com", "techcabal.com", "guardian.ng",
    "thecable.ng", "vanguardngr.com", "thisdaylive.com", "theafricareport.com", "africanews.com", "semafor.com",
}
LOW_TRUST = {
    "facebook.com", "x.com", "twitter.com", "reddit.com", "quora.com", "medium.com", "nairaland.com", "tiktok.com",
    "instagram.com", "pinterest.com", "youtube.com",
}
INSTITUTIONAL = re.compile(r"(\.gov(\.[a-z]{2})?|\.edu(\.[a-z]{2})?|\.ac\.[a-z]{2}|\.int|\.mil)$")
MULTILATERAL = {"worldbank.org", "imf.org", "un.org", "oecd.org", "iea.org", "irena.org", "afdb.org", "who.int", "wto.org"}


class ResearchFailed(Exception):
    """Research could not be completed; the message is shown to the user."""


class Cancelled(Exception):
    pass


@dataclass
class Source:
    url: str
    title: str = ""
    snippet: str = ""
    provider: str = ""
    published: str = ""
    text: str = ""
    snippet_only: bool = False
    read: bool = False
    relevant: bool = False
    source_type: str = "unknown"
    publisher: str = ""
    original_source: str = ""
    facts: list[dict] = field(default_factory=list)
    credibility: float = 0.5
    origin_group: str = ""
    num: int = 0

    @property
    def domain(self) -> str:
        return domain_of(self.url)


@dataclass
class Outcome:
    title: str
    summary: str
    report_md: str
    meta: dict
    sources: list[dict]


def score_credibility(source: Source, official_domains: set[str]) -> float:
    reg = registered_domain(source.url)
    if INSTITUTIONAL.search(source.domain) or reg in MULTILATERAL:
        score = 0.85
    elif reg in official_domains or source.provider == "openalex":
        score = 0.8
    elif reg in REPUTABLE_NEWS:
        score = 0.75
    elif reg == "wikipedia.org":
        score = 0.6
    elif reg in LOW_TRUST:
        score = 0.35
    else:
        score = 0.5
    score += {"primary": 0.1, "aggregator": -0.1}.get(source.source_type, 0.0)
    if source.snippet_only:
        score -= 0.15
    return round(max(0.1, min(0.95, score)), 2)


def origin_group(source: Source) -> str:
    """Sources that repeat one underlying report share a group and are not independent."""
    origin = (source.original_source or "").strip().lower()
    if origin:
        match = re.search(r"([a-z0-9-]+\.)+[a-z]{2,}", origin)
        group = registered_domain(match.group(0)) if match else re.sub(r"[^a-z0-9]+", "-", origin).strip("-")[:60]
        if group and group != registered_domain(source.url):
            return group
    return registered_domain(source.url)


def credibility_label(score: float) -> str:
    return "high" if score >= 0.75 else "medium" if score >= 0.5 else "low"


def describe_images(images: list) -> str:
    """Compact text form of the stored vision analyses, for prompts."""
    if not images:
        return "(none)"
    blocks = []
    for index, row in enumerate(images, 1):
        try:
            d = json.loads(row["description"] or "{}")
        except ValueError:
            d = {}
        if row["status"] != "ANALYSED":
            blocks.append(f"Image {index}: could not be analysed ({row['error'] or 'no vision provider'}).")
            continue
        lines = [f"Image {index} ({d.get('image_type') or 'image'}): {d.get('summary') or ''}".strip()]
        for label, key in (("Organisations", "organisations"), ("People named", "people"), ("Products/services", "products"),
                           ("Locations", "locations"), ("Contacts", "contacts"), ("Figures", "figures"), ("Leads", "research_leads")):
            values = [str(v) for v in d.get(key) or [] if v]
            if values:
                lines.append(f"  {label}: " + "; ".join(values[:8]))
        text = (row["extracted_text"] or "").strip()
        if text:
            lines.append("  Visible text: " + clip(text.replace("\n", " / "), 700))
        blocks.append("\n".join(lines))
    return "\n".join(blocks)


def image_leads(images: list) -> list[str]:
    leads: list[str] = []
    for row in images:
        try:
            d = json.loads(row["description"] or "{}")
        except ValueError:
            continue
        leads += [str(v) for v in (d.get("research_leads") or []) + (d.get("organisations") or []) if v]
    return leads


class Pipeline:
    def __init__(self, cfg: Config, db: Database, ai: AIRouter, search: SearchRouter, fetcher: Fetcher):
        self.cfg, self.db, self.ai, self.search, self.fetcher = cfg, db, ai, search, fetcher

    async def run(self, task, images: list, tick) -> Outcome:
        """`tick(stage, message)` reports progress and raises Cancelled if the task must stop."""
        depth = self.cfg.depth(task["depth"])
        budget = Budget(depth.max_ai_calls, depth.max_tokens, task_id=task["id"])
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        notes: list[str] = []  # limitations that must be disclosed in the report
        question, task_context = task["question"], task["task_context"]

        await tick("understanding", "🧭 Understanding the request and your context…")
        image_text = describe_images(images)
        hits = retrieve(self.db, task["user_id"], f"{question} {task_context} {image_text if images else ''}")
        self.db.set_context_links(task["id"], [h.as_link() for h in hits])
        related = related_research(self.db, task["user_id"], question, exclude_task=task["id"])
        failed_images = [i for i in images if i["status"] != "ANALYSED"]
        if failed_images:
            notes.append(f"{len(failed_images)} attached image(s) could not be analysed and did not inform this research.")

        plan = await self._plan(question, task_context, image_text, images, hits, related, depth, budget, today, notes)

        sources: list[Source] = []
        seen_urls: set[str] = set()
        candidates: list[Source] = []
        queries_run: list[str] = []
        search_errors: list[str] = []
        queue = plan["queries"]
        coverage: list[dict] = []
        official = {registered_domain(d) for d in plan.get("official_domains", []) if isinstance(d, str) and "." in d}
        want = tokens(question + " " + " ".join(plan.get("entities", [])))
        first_round = depth.max_queries if depth.max_iterations == 1 else math.ceil(depth.max_queries * 0.65)

        for iteration in range(1, depth.max_iterations + 1):
            room = (first_round if iteration == 1 else depth.max_queries) - len(queries_run)
            batch = [q for q in queue if q["q"].lower() not in {x.lower() for x in queries_run}][: max(0, room)]
            if not batch:
                break
            await tick("searching", f"🔎 Searching ({len(batch)} queries, round {iteration})…")
            for query in batch:
                results, errors = await self.search.search(query["q"], query.get("kind", "web"), task_id=task["id"])
                queries_run.append(query["q"])
                search_errors += errors
                for result in results:
                    key = normalize_url(result.url)
                    if key not in seen_urls:
                        seen_urls.add(key)
                        candidates.append(Source(url=result.url, title=result.title, snippet=result.snippet,
                                                 provider=result.provider, published=result.published))
                await tick("searching", None)
            if not candidates and iteration == 1:
                detail = "; ".join(dict.fromkeys(search_errors)) or "the search providers returned no results"
                raise ResearchFailed(f"No search results could be retrieved ({clip(detail, 300)}). Nothing was generated.")

            remaining = depth.max_sources - sum(1 for s in sources if s.read)
            share = remaining if iteration == depth.max_iterations else math.ceil(depth.max_sources * (0.65 if iteration == 1 else 0.35))
            picked = self._pick(candidates, want, official, min(remaining, share), sources)
            if not picked:
                break
            await tick("reading", f"📄 Reading {len(picked)} sources…")
            pages = await asyncio.gather(*(self.fetcher.fetch(s.url) for s in picked))
            unreadable = 0
            for source, page in zip(picked, pages):
                source.read = True
                if page.ok:
                    source.text = page.text
                    source.title = source.title or page.title
                    source.published = source.published or page.published
                elif len(source.snippet) >= 80:
                    source.text, source.snippet_only = source.snippet, True
                else:
                    unreadable += 1
            if unreadable:
                notes.append(f"{unreadable} source(s) in round {iteration} could not be opened (blocked, paywalled or not HTML).")
            fresh = [s for s in picked if s.text]
            sources += fresh

            await tick("extracting", f"🧪 Extracting evidence from {len(fresh)} sources…")
            try:
                await self._extract(fresh, question, plan, budget, today, notes)
            except BudgetExceeded as exc:
                notes.append(f"Evidence extraction stopped early: {exc}.")
                break
            for source in fresh:
                source.credibility = score_credibility(source, official)
                source.origin_group = origin_group(source)

            gained = sum(1 for s in fresh if s.relevant and s.facts)
            if iteration == depth.max_iterations or len(queries_run) >= depth.max_queries:
                break
            if iteration > 1 and gained < 2:
                notes.append("Follow-up searching stopped: the last round added little new evidence (diminishing returns).")
                break
            if budget.remaining_calls < 2:  # always keep one call for the report itself
                notes.append("Follow-up searching skipped: the AI call budget for this task was reached.")
                break
            await tick("evaluating", "⚖️ Checking coverage and looking for gaps…")
            try:
                enough, followups, coverage = await self._gaps(question, plan, sources, queries_run, depth, budget, today)
            except (BudgetExceeded, AllProvidersExhausted, ValueError) as exc:
                notes.append(f"Gap analysis was skipped ({clip(str(exc), 120)}).")
                break
            if enough or not followups:
                break
            queue = followups

        evidence = [s for s in sources if s.relevant and s.facts]
        if not evidence:
            raise ResearchFailed(
                "Sources were found but none yielded usable evidence for this question, so no report was written. "
                "Try rephrasing, adding context, or a deeper setting."
            )
        evidence.sort(key=lambda s: (-s.credibility, s.snippet_only, s.url))
        for number, source in enumerate(evidence, 1):
            source.num = number

        await tick("writing", f"✍️ Writing the report from {len(evidence)} sources…")
        try:
            body, confidence, influence = await self._write(question, task_context, image_text, hits, plan, coverage, evidence, budget, today)
        except BudgetExceeded as exc:
            raise ResearchFailed(f"The task ran out of its AI budget before the report could be written ({exc}).")
        if search_errors:
            notes.append("Some search providers failed during this run: " + clip("; ".join(dict.fromkeys(search_errors)), 200))
        return self._assemble(task, plan, depth, body, confidence, influence, evidence, sources, hits, images, notes, queries_run, budget, today)

    # ------------------------------------------------------------ planning
    async def _plan(self, question, task_context, image_text, images, hits: list[ContextHit], related, depth: Depth,
                    budget: Budget, today: str, notes: list[str]) -> dict:
        n_queries = depth.max_queries if depth.max_iterations == 1 else math.ceil(depth.max_queries * 0.65)
        prompt = prompts.PLAN.format(
            today=today, question=question, task_context=task_context or "(none)", images=image_text,
            context="\n".join(f"C{h.id} [{h.category}, updated {h.updated_at[:10]}]: {clip(h.content, 400)}" for h in hits) or "(none saved or none relevant)",
            related="\n".join(f"{r['rid']} ({(r['finished_at'] or '')[:10]}): {r['title']} — {clip(r['summary'], 200)}" for r in related) or "(none)",
            n_queries=n_queries,
        )
        plan: dict = {}
        try:
            result = await self.ai.generate(prompt, system=prompts.SYSTEM, want_json=True, max_output_tokens=2000, budget=budget, purpose="plan")
            parsed = extract_json(result.text)
            plan = parsed if isinstance(parsed, dict) else {}
        except ValueError:
            notes.append("The planning step returned an unreadable answer, so a simple keyword plan was used instead.")
        queries = []
        for item in plan.get("queries") or []:
            if isinstance(item, str):
                item = {"q": item}
            if isinstance(item, dict) and str(item.get("q", "")).strip():
                queries.append({"q": str(item["q"]).strip()[:200], "objective": str(item.get("objective", "")), "kind": str(item.get("kind", "web"))})
        if not queries:
            queries = [{"q": clip(question, 180), "objective": "O1", "kind": "web"}]
        # Guarantee that attached images steer the search, whatever the model planned.
        leads = image_leads(images)
        if leads:
            joined = " ".join(q["q"].lower() for q in queries)
            if not any(any(tok in joined for tok in tokens(lead)) for lead in leads):
                queries.insert(0, {"q": clip(leads[0], 150), "objective": "O1", "kind": "web"})
        objectives = [
            {"id": str(o.get("id") or f"O{i}"), "text": str(o.get("text", "")).strip()}
            for i, o in enumerate(plan.get("objectives") or [], 1) if isinstance(o, dict) and str(o.get("text", "")).strip()
        ] or [{"id": "O1", "text": question}]
        return {
            "title": str(plan.get("title") or clip(question, 90)).strip(),
            "objective": str(plan.get("objective") or question).strip(),
            "entities": [str(e) for e in plan.get("entities") or [] if e][:12],
            "decision_focus": str(plan.get("decision_focus") or "").strip(),
            "objectives": objectives[:6],
            "queries": queries[: depth.max_queries],
            "official_domains": [d for d in plan.get("official_domains") or [] if isinstance(d, str)],
            "assumptions": [str(a) for a in plan.get("assumptions") or [] if a][:6],
        }

    # ----------------------------------------------------- source selection
    @staticmethod
    def _pick(candidates: list[Source], want: set[str], official: set[str], limit: int, already: list[Source] = ()) -> list[Source]:
        """Choose which unread results to open: official and relevant first, at most three per site per task."""
        def rank(source: Source) -> float:
            overlap = len(want & tokens(f"{source.title} {source.snippet}"))
            return score_credibility(source, official) * 2 + min(overlap, 6) * 0.25

        per_site: dict[str, int] = {}
        for source in already:
            site = registered_domain(source.url)
            per_site[site] = per_site.get(site, 0) + 1
        chosen = []
        for source in sorted((s for s in candidates if not s.read), key=rank, reverse=True):
            site = registered_domain(source.url)
            if per_site.get(site, 0) >= 3:
                continue
            per_site[site] = per_site.get(site, 0) + 1
            chosen.append(source)
            if len(chosen) >= limit:
                break
        return chosen

    # ----------------------------------------------------------- extraction
    async def _extract(self, fresh: list[Source], question: str, plan: dict, budget: Budget, today: str, notes: list[str]) -> None:
        objectives = "\n".join(f"{o['id']}: {o['text']}" for o in plan["objectives"])
        per_source = self.cfg.page_chars
        room = max(per_source, min(p.max_prompt_chars for p in self.ai.providers if p.supports_text) - 3000) if self.ai.has_text else per_source
        batch_chars = min(room, 36_000)
        batches, current, size = [], [], 0
        for source in fresh:
            cost = min(len(source.text), per_source) + 200
            if current and size + cost > batch_chars:
                batches.append(current)
                current, size = [], 0
            current.append(source)
            size += cost
        if current:
            batches.append(current)

        for index, batch in enumerate(batches):
            if budget.remaining_calls < 2:  # keep the last call for the report
                notes.append(f"{sum(len(b) for b in batches[index:])} fetched source(s) were not analysed: AI call budget reached.")
                return
            numbered = {i: s for i, s in enumerate(batch, 1)}
            blocks = [
                f"--- SOURCE {i} ---\nURL: {s.url}\nTitle: {s.title}\nPublished: {s.published or 'unknown'}"
                f"{' (search snippet only; page could not be opened)' if s.snippet_only else ''}\nText:\n{clip(s.text, per_source)}"
                for i, s in numbered.items()
            ]
            prompt = prompts.EXTRACT.format(today=today, question=question, objectives=objectives, count=len(batch),
                                            max_facts=8, sources="\n\n".join(blocks))
            result = await self.ai.generate(prompt, system=prompts.SYSTEM, want_json=True, max_output_tokens=4000, budget=budget, purpose="extract")
            try:
                parsed = extract_json(result.text)
                items = parsed.get("sources", []) if isinstance(parsed, dict) else parsed
                if not isinstance(items, list):
                    raise ValueError("unexpected shape")
            except ValueError:
                notes.append(f"Evidence from {len(batch)} source(s) could not be structured and was left out.")
                continue
            for item in items:
                if not isinstance(item, dict):
                    continue
                try:
                    source = numbered.get(int(item.get("n", 0)))
                except (TypeError, ValueError):
                    source = None
                if source is None:
                    continue
                facts = []
                for fact in item.get("facts") or []:
                    if isinstance(fact, str):
                        fact = {"claim": fact}
                    if isinstance(fact, dict) and str(fact.get("claim", "")).strip():
                        facts.append({k: clip(str(fact[k]).strip(), 400) for k in ("claim", "quote", "date") if fact.get(k)})
                source.facts = facts[:8]
                source.relevant = bool(item.get("relevant", True)) and bool(facts)
                kind = str(item.get("source_type", "")).lower()
                source.source_type = kind if kind in ("primary", "secondary", "aggregator") else "unknown"
                source.publisher = clip(str(item.get("publisher") or ""), 80)
                source.original_source = clip(str(item.get("original_source") or ""), 120)
                published = str(item.get("published") or "")
                if re.match(r"\d{4}(-\d{2}){0,2}$", published):
                    source.published = published

    # ------------------------------------------------------------ gap check
    async def _gaps(self, question, plan, sources, queries_run, depth: Depth, budget, today):
        max_followups = max(1, min(4, depth.max_queries - len(queries_run)))
        prompt = prompts.GAPS.format(
            today=today, question=question, decision_focus=plan["decision_focus"] or plan["objective"],
            objectives="\n".join(f"{o['id']}: {o['text']}" for o in plan["objectives"]),
            evidence=self._evidence_digest([s for s in sources if s.relevant and s.facts], 9000, numbered=False) or "(nothing relevant yet)",
            queries="\n".join(f"- {q}" for q in queries_run), max_followups=max_followups,
        )
        result = await self.ai.generate(prompt, system=prompts.SYSTEM, want_json=True, max_output_tokens=1200, budget=budget, purpose="gaps")
        parsed = extract_json(result.text)
        if not isinstance(parsed, dict):
            raise ValueError("gap analysis returned an unexpected shape")
        followups = [
            {"q": str(f["q"]).strip()[:200], "objective": str(f.get("objective", "")), "kind": str(f.get("kind", "web"))}
            for f in parsed.get("followup_queries") or [] if isinstance(f, dict) and str(f.get("q", "")).strip()
        ][:max_followups]
        coverage = [c for c in parsed.get("coverage") or [] if isinstance(c, dict)]
        return bool(parsed.get("enough")), followups, coverage

    @staticmethod
    def _evidence_digest(evidence: list[Source], char_budget: int, numbered: bool = True) -> str:
        """Evidence as text, trimming facts per source evenly until it fits the budget."""
        for max_facts in (8, 6, 4, 3, 2, 1):
            blocks = []
            for source in evidence:
                tag = f"[S{source.num}] " if numbered else "- "
                head = (f"{tag}{clip(source.title or source.domain, 110)} — {source.domain} — {source.source_type}"
                        f" — published {source.published or 'unknown'} — credibility {credibility_label(source.credibility)}"
                        f" — origin group: {source.origin_group or source.domain}"
                        f"{' — SNIPPET ONLY' if source.snippet_only else ''}")
                lines = [head]
                for fact in source.facts[:max_facts]:
                    line = f"    • {fact['claim']}"
                    if fact.get("date"):
                        line += f" ({fact['date']})"
                    if fact.get("quote") and max_facts > 2:
                        line += f' — "{clip(fact["quote"], 200)}"'
                    lines.append(line)
                blocks.append("\n".join(lines))
            text = "\n".join(blocks)
            if len(text) <= char_budget:
                return text
        return text[:char_budget]

    # -------------------------------------------------------------- writing
    async def _write(self, question, task_context, image_text, hits, plan, coverage, evidence, budget, today):
        status = {str(c.get("objective")): f"{c.get('status', '')} {c.get('note', '')}".strip() for c in coverage}
        limit = min(p.max_prompt_chars for p in self.ai.providers if p.supports_text) if self.ai.has_text else self.cfg.ai_max_prompt_chars
        fixed = prompts.REPORT.format(
            today=today, question=question, task_context=task_context or "(none)", images=image_text,
            context="\n".join(f"C{h.id} [{h.category}, updated {h.updated_at[:10]}]: {clip(h.content, 400)}" for h in hits) or "(none)",
            objective=plan["objective"], decision_focus=plan["decision_focus"] or "(not specified)",
            objectives="\n".join(f"{o['id']}: {o['text']}" + (f" — {status[o['id']]}" if o["id"] in status else "") for o in plan["objectives"]),
            assumptions="; ".join(plan["assumptions"]) or "(none)", evidence="{evidence}", max_words=max(400, self.cfg.max_report_chars // 7),
        )
        prompt = fixed.replace("{evidence}", self._evidence_digest(evidence, max(4000, limit - len(fixed) - len(prompts.SYSTEM) - 500)))
        result = await self.ai.generate(prompt, system=prompts.SYSTEM, max_output_tokens=6000, budget=budget, purpose="report")
        text = re.sub(r"^```(?:markdown)?\s*|\s*```$", "", result.text.strip())
        parts = re.split(r"^\s*=+\s*(CONFIDENCE|CONTEXT)\s*=+\s*$", text, flags=re.M)
        body, confidence, influence = parts[0].strip(), "", ""
        for label, chunk in zip(parts[1::2], parts[2::2]):
            if label == "CONFIDENCE":
                confidence = chunk.strip()
            else:
                influence = chunk.strip()
        return body, confidence, influence

    def _assemble(self, task, plan, depth, body, confidence, influence, evidence: list[Source], sources: list[Source],
                  hits: list[ContextHit], images, notes, queries_run, budget: Budget, today) -> Outcome:
        valid = {s.num for s in evidence}

        def fix_citation(match: re.Match) -> str:
            kept = [n for n in re.findall(r"\d+", match.group(0)) if int(n) in valid]
            return "".join(f"[S{n}]" for n in kept)

        body = re.sub(r"\[S\d+(?:\s*[,;]\s*S?\d+)*\]", fix_citation, body)
        body = re.sub(r"[ \t]+([.,;:])", r"\1", body)  # tidy up where an invalid citation was removed
        body = re.sub(r"^#\s+.*\n+", "", body, count=1) if body.startswith("# ") else body  # we add the title ourselves
        if len(body) > self.cfg.max_report_chars:
            body = body[: self.cfg.max_report_chars].rsplit("\n", 1)[0] + "\n\n_(Report truncated at the configured maximum length.)_"
            notes.append("The report body was cut at the configured maximum length.")
        cited = {int(n) for n in re.findall(r"\[S(\d+)\]", body)}

        primary = sum(1 for s in evidence if s.source_type == "primary")
        secondary = sum(1 for s in evidence if s.source_type == "secondary")
        origins = len({s.origin_group for s in evidence})
        snippet_only = sum(1 for s in evidence if s.snippet_only)

        lines = [f"# {plan['title']}", "", f"_{research_id(task['id'])} · {today} · depth: {depth.name} · {len(evidence)} sources_", "", body, ""]
        lines += ["## 10. SOURCES"]
        for s in evidence:
            extra = " · ".join(x for x in (s.source_type if s.source_type != "unknown" else "", s.published,
                                           f"credibility {credibility_label(s.credibility)}",
                                           "snippet only" if s.snippet_only else "", "" if s.num in cited else "not cited") if x)
            lines.append(f"- [S{s.num}] [{clip(s.title or s.domain, 100).replace('[', '(').replace(']', ')')}]({s.url}) — {s.domain} · {extra}")
        lines += ["", "## 11. CONFIDENCE AND LIMITATIONS"]
        if confidence:
            lines += [confidence, ""]
        lines.append("**Evidence base (computed, not model-written):**")
        lines.append(f"- {len(evidence)} sources used: {primary} primary, {secondary} secondary, {len(evidence) - primary - secondary} other; "
                     f"{origins} independent origin(s) after grouping sources that repeat the same report.")
        if snippet_only:
            lines.append(f"- {snippet_only} source(s) are search snippets only because the page could not be opened; treat them as weak.")
        lines.append(f"- {len(queries_run)} search queries run; {sum(1 for s in sources if s.read)} pages opened; "
                     f"{budget.calls} AI calls, about {budget.tokens:,} tokens.")
        lines += [f"- {note}" for note in dict.fromkeys(notes)]
        lines += ["", "## 12. HOW YOUR CONTEXT INFLUENCED THIS RESEARCH"]
        if influence:
            lines += [influence, ""]
        lines.append("**Inputs actually supplied to this research (computed):**")
        if hits:
            lines += [f"- Saved context C{h.id} ({h.category}): {clip(h.content, 160)} — _{h.reason}_" for h in hits]
        else:
            lines.append("- No saved context was supplied (none saved, or none relevant to this request).")
        if task["task_context"]:
            lines.append(f"- Task-only context: {clip(task['task_context'], 240)}")
        if images:
            ok = sum(1 for i in images if i["status"] == "ANALYSED")
            lines.append(f"- {len(images)} image(s) attached, {ok} analysed and used to build the search plan.")
        if plan["assumptions"]:
            lines.append("- Assumptions: " + "; ".join(plan["assumptions"]))

        match = re.search(r"EXECUTIVE SUMMARY\s*\n+(.*?)(?=\n##\s|\Z)", body, flags=re.S | re.I)
        summary = clip(re.sub(r"\s+", " ", (match.group(1) if match else body)).strip(), 900)
        meta = {
            "depth": depth.name, "queries": queries_run, "ai_calls": budget.calls, "tokens": budget.tokens,
            "sources_used": len(evidence), "independent_origins": origins, "notes": list(dict.fromkeys(notes)),
            "context_ids": [h.id for h in hits], "image_ids": [i["id"] for i in images],
        }
        stored = [
            {"num": s.num, "url": s.url, "title": s.title, "domain": s.domain, "provider": s.provider, "source_type": s.source_type,
             "credibility": s.credibility, "published": s.published, "origin_group": s.origin_group, "evidence": s.facts}
            for s in evidence
        ]
        return Outcome(plan["title"], summary, "\n".join(lines).strip() + "\n", meta, stored)
