import json
import re

from conftest import JPEG, PNG, USER, Env, FakeSearch
from sextant.research.pipeline import Source, origin_group, score_credibility
from sextant.textutil import extract_json, normalize_url

Q = "Research the solar energy market in Nigeria"


async def test_full_research_produces_an_evidence_backed_report(env):
    """Acceptance test A (engine side): question in, structured report out."""
    task = await env.run(Q)
    assert task["status"] == "COMPLETED", task["error"]
    assert env.notifier.completed_ids == [task["id"]]

    kinds = env.ai_fake.kinds()
    assert kinds[0] == "plan" and kinds[-1] == "report" and "extract" in kinds and "gaps" in kinds
    assert len(env.search_fake.queries) >= 4, "the question is decomposed into several searches"
    assert "nigeria solar distributor list" in env.search_fake.queries, "a follow-up round ran after the gap check"

    report = env.db.get_report(task["id"])["report_md"]
    for heading in ("EXECUTIVE SUMMARY", "KEY FINDINGS", "10. SOURCES", "11. CONFIDENCE AND LIMITATIONS",
                    "12. HOW YOUR CONTEXT INFLUENCED THIS RESEARCH"):
        assert heading in report
    assert "[S99]" not in report, "citations that match no source are removed"

    sources = env.db.get_sources(task["id"])
    urls = {s["url"] for s in sources}
    assert all(f"]({u})" in report for u in urls), "every listed link is a URL that was actually fetched"
    assert set(re.findall(r"\]\((https?://[^)]+)\)", report)) == urls, "the report links to nothing else"
    assert all(json.loads(s["evidence"]) for s in sources)


async def test_research_is_bounded_by_depth_budget(env):
    task = await env.run(Q, depth="quick")
    meta = json.loads(env.db.get_report(task["id"])["meta"])
    assert len(meta["queries"]) <= 4 and meta["ai_calls"] <= 5
    assert "gaps" not in env.ai_fake.kinds(), "quick depth is a single round"

    deep = await env.run("Research the wind energy market in Nigeria", depth="deep")
    meta = json.loads(env.db.get_report(deep["id"])["meta"])
    assert len(meta["queries"]) <= 14 and meta["ai_calls"] <= 14


async def test_user_context_reaches_the_model_and_is_disclosed(env):
    """Acceptance test D: the same question is steered by the user's context."""
    cid = env.db.add_context(USER, "objectives", "Identify commercial partnerships and potential clients")
    env.db.add_context(USER, "projects", "Exporting cocoa beans to the Netherlands")
    task = await env.run(Q, task_context="Focus on Kano and Kaduna only")

    plan_prompt = next(c["prompt"] for c in env.ai_fake.calls if c["kind"] == "plan")
    report_prompt = next(c["prompt"] for c in env.ai_fake.calls if c["kind"] == "report")
    for prompt in (plan_prompt, report_prompt):
        assert "commercial partnerships and potential clients" in prompt
        assert "Focus on Kano and Kaduna only" in prompt
        assert "cocoa" not in prompt, "irrelevant context is not injected"

    links = env.db.get_context_links(task["id"])
    assert [l["context_id"] for l in links] == [cid]
    section = env.db.get_report(task["id"])["report_md"].split("12. HOW YOUR CONTEXT INFLUENCED THIS RESEARCH")[1]
    assert f"C{cid}" in section and "commercial partnerships" in section and "Kano and Kaduna" in section


async def test_without_context_the_report_says_so(env):
    task = await env.run(Q)
    section = env.db.get_report(task["id"])["report_md"].split("12. HOW YOUR CONTEXT INFLUENCED THIS RESEARCH")[1]
    assert "No saved context was supplied" in section


async def test_image_is_interpreted_and_drives_the_searches(env):
    """Acceptance test E."""
    image_id = env.add_image()
    task = await env.run("Investigate this company and identify partnership opportunities", image_ids=[image_id])
    assert task["status"] == "COMPLETED", task["error"]

    assert env.ai_fake.kinds()[0] == "vision"
    row = env.db.task_images(task["id"])[0]
    assert row["status"] == "ANALYSED" and "SunVolt Energy" in row["extracted_text"]
    assert any("SunVolt" in q for q in env.search_fake.queries), "the company in the image must be searched for"
    report_prompt = next(c["prompt"] for c in env.ai_fake.calls if c["kind"] == "report")
    assert "SunVolt Energy" in report_prompt and "0803 000 0000" in report_prompt


async def test_image_entities_are_searched_even_if_the_model_plan_ignores_them(env):
    env.ai_fake.vision_reply = dict(env.ai_fake.vision_reply, organisations=["Zenith Photon Ltd"],
                                    research_leads=["Zenith Photon Ltd Abuja"], summary="A flyer.", visible_text="Zenith Photon Ltd")
    image_id = env.add_image()
    await env.run("What is this?", image_ids=[image_id])
    assert env.search_fake.queries[0] == "Zenith Photon Ltd Abuja"


async def test_multiple_images_are_combined(env):
    """Acceptance test F."""
    second = dict(env.ai_fake.vision_reply, summary="Price list from HelioMax Nigeria.", organisations=["HelioMax Nigeria"],
                  visible_text="HelioMax Nigeria\n5kVA inverter NGN 1,200,000", figures=["5kVA inverter: NGN 1,200,000"],
                  research_leads=["HelioMax Nigeria inverter prices"])
    env.ai_fake.vision_by_size[len(PNG)] = second
    a, b = env.add_image(JPEG, "u1"), env.add_image(PNG, "u2")
    task = await env.run("Compare these two companies", image_ids=[a, b])

    assert env.ai_fake.kinds().count("vision") == 2
    plan_prompt = next(c["prompt"] for c in env.ai_fake.calls if c["kind"] == "plan")
    assert "Image 1" in plan_prompt and "Image 2" in plan_prompt
    assert "SunVolt Energy" in plan_prompt and "HelioMax Nigeria" in plan_prompt and "NGN 1,200,000" in plan_prompt
    assert "2 image(s) attached, 2 analysed" in env.db.get_report(task["id"])["report_md"]


async def test_same_image_is_never_analysed_twice(env):
    first = env.add_image(JPEG, "u1")
    await env.run("Investigate this company", image_ids=[first])
    forwarded = env.add_image(JPEG, "another-telegram-id")  # same bytes, different Telegram file
    await env.run("What are the risks of partnering with this company", image_ids=[forwarded])
    assert env.ai_fake.kinds().count("vision") == 1
    assert len(list(env.cfg.image_dir.iterdir())) == 1, "identical files are stored once"


async def test_no_search_results_fails_honestly(tmp_path):
    env = Env(tmp_path, web=[FakeSearch(results=[])])
    task = await env.run(Q)
    assert task["status"] == "FAILED" and env.db.get_report(task["id"]) is None
    assert "No search results" in env.notifier.failures[0][1]
    assert "report" not in env.ai_fake.kinds(), "the model is never asked to write without evidence"
    await env.close()


async def test_unreadable_plan_falls_back_and_is_disclosed(env):
    env.ai_fake.bad_json_for = {"plan"}
    task = await env.run(Q)
    assert task["status"] == "COMPLETED"
    assert env.search_fake.queries[0] == Q
    assert "simple keyword plan" in env.db.get_report(task["id"])["report_md"]


def test_reposts_of_one_report_are_not_independent_corroboration():
    a = Source(url="https://site-a.com/x", original_source="Big Agency Report")
    b = Source(url="https://site-b.org/y", original_source="big agency report")
    c = Source(url="https://site-c.net/z")
    assert origin_group(a) == origin_group(b) != origin_group(c)
    assert origin_group(Source(url="https://news.com/a", original_source="per worldbank.org data")) == "worldbank.org"


async def test_report_counts_independent_origins(env):
    task = await env.run(Q)
    meta = json.loads(env.db.get_report(task["id"])["meta"])
    sources = env.db.get_sources(task["id"])
    reposts = [s for s in sources if "repost" in s["url"]]
    assert len(reposts) >= 2 and len({s["origin_group"] for s in reposts}) == 1
    assert meta["independent_origins"] < meta["sources_used"]


def test_credibility_prefers_primary_and_official_sources():
    official = {"sunvolt.example"}
    gov = score_credibility(Source(url="https://rea.gov.ng/data", source_type="primary"), official)
    news = score_credibility(Source(url="https://www.reuters.com/a", source_type="secondary"), official)
    forum = score_credibility(Source(url="https://www.nairaland.com/t", source_type="aggregator"), official)
    snippet = score_credibility(Source(url="https://unknown.example.net/a", snippet_only=True), official)
    assert gov > news > 0.5 > forum and snippet < 0.5


def test_helpers():
    assert normalize_url("http://WWW.Example.com/a/?utm_source=x&id=2#frag") == "https://example.com/a?id=2"
    assert extract_json('Sure! ```json\n{"a": [1, 2]}\n``` hope that helps') == {"a": [1, 2]}
