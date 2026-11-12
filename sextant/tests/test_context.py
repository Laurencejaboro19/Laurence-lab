from conftest import USER
from sextant import context as ctx


def test_context_persists_and_can_be_edited_and_removed(env):
    cid = env.db.add_context(USER, "objectives", "Find commercial partners and clients")
    assert [r["content"] for r in env.db.list_context(USER)] == ["Find commercial partners and clients"]
    assert env.db.update_context(USER, cid, content="Find distribution partners")
    assert env.db.get_context(USER, cid)["content"] == "Find distribution partners"
    assert env.db.delete_context(USER, cid)
    assert env.db.list_context(USER) == []
    env.db.add_context(USER, "general", "a")
    env.db.add_context(USER, "general", "b")
    assert env.db.clear_context(USER) == 2


def test_category_parsing():
    assert ctx.parse_category("projects: solar distribution in Lagos") == ("projects", "solar distribution in Lagos")
    assert ctx.parse_category("Goals: enter West Africa") == ("objectives", "enter West Africa")
    assert ctx.parse_category("I prefer primary sources") == ("general", "I prefer primary sources")
    assert ctx.parse_category("Note: this colon is not a category") == ("general", "Note: this colon is not a category")


def test_relevance_retrieval_includes_framing_but_filters_topical(env):
    objective = env.db.add_context(USER, "objectives", "Identify commercial partnerships and potential clients")
    solar = env.db.add_context(USER, "projects", "Building a solar panel distribution business in Lagos")
    cocoa = env.db.add_context(USER, "projects", "Exporting cocoa beans to the Netherlands")
    kenya = env.db.add_context(USER, "geography", "Kenya and Tanzania logistics corridors")

    hits = {h.id: h for h in ctx.retrieve(env.db, USER, "Research the solar energy market in Nigeria")}

    assert objective in hits, "standing objectives shape every request even without shared words"
    assert solar in hits and "solar" in hits[solar].reason
    assert cocoa not in hits and kenya not in hits, "unrelated topical context must not be injected"


def test_retrieval_respects_size_budget(env):
    for i in range(30):
        env.db.add_context(USER, "general", f"note {i} " + "x" * 380)
    hits = ctx.retrieve(env.db, USER, "anything", char_budget=1200)
    assert 1 <= len(hits) <= 3


def test_profile_separates_stated_from_observed(env):
    env.db.add_context(USER, "interests", "Renewable energy distribution")
    text = ctx.format_profile(env.db, USER)
    assert "Stated by you" in text and "Renewable energy distribution" in text
    assert "not treated as a preference" in text
    empty = ctx.format_profile(env.db, 4242)
    assert "Nothing yet" in empty


async def test_task_context_is_not_promoted_to_persistent(env):
    task = await env.run("Research cement prices", task_context="Only consider Ogun State suppliers")
    assert task["task_context"] == "Only consider Ogun State suppliers"
    assert env.db.list_context(USER) == [], "one task's instructions must not become a standing preference"
