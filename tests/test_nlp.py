from laurence_lab_bot.nlp import looks_like_order, parse_order


def _as_dict(parsed):
    return {item.id: qty for item, qty in parsed.lines}


def test_screenshot_order():
    text = "Id like to order 4 portions of jollof, 1 chicken, 1 chivita, 2 portions of plantain and bottle water"
    parsed = parse_order(text)
    assert _as_dict(parsed) == {"jollof": 4, "chicken": 1, "chivita": 1, "plantain": 2, "water": 1}
    assert parsed.unmatched == []


def test_number_words_and_merging():
    parsed = parse_order("two jollof rice and 3 jollof plus a coke")
    assert _as_dict(parsed) == {"jollof": 5, "coke": 1}


def test_unmatched_items_reported():
    parsed = parse_order("1 jollof and 2 pizza")
    assert _as_dict(parsed) == {"jollof": 1}
    assert parsed.unmatched == ["2 pizza"] or "pizza" in parsed.unmatched[0]


def test_fried_rice_beats_rice_alias():
    parsed = parse_order("2 fried rice")
    assert _as_dict(parsed) == {"fried_rice": 2}


def test_looks_like_order():
    assert looks_like_order("I want 2 jollof")
    assert looks_like_order("plantain")
    assert not looks_like_order("hello there")
