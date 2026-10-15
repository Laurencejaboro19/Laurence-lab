from laurence_lab_bot.nlp import looks_like_order, parse_order


def _as_dict(parsed):
    return {item.id: qty for item, qty in parsed.lines}


def test_screenshot_order():
    text = "Id like to order 4 portions of jollof, 1 chicken, 1 chivita, 2 portions of plantain and bottle water"
    parsed = parse_order(text)
    assert _as_dict(parsed) == {"ll_jollof": 4, "ll_chicken": 1, "ll_chivita": 1, "ll_plantain": 2, "ll_water": 1}
    assert parsed.unmatched == []


def test_number_words_and_merging():
    parsed = parse_order("two jollof rice and 3 jollof plus a coke")
    assert _as_dict(parsed) == {"ll_jollof": 5, "ll_coke": 1}


def test_unmatched_items_reported():
    parsed = parse_order("1 jollof and 2 pizza")
    assert _as_dict(parsed) == {"ll_jollof": 1}
    assert parsed.unmatched == ["2 pizza"] or "pizza" in parsed.unmatched[0]


def test_fried_rice_beats_rice_alias():
    parsed = parse_order("2 fried rice")
    assert _as_dict(parsed) == {"ll_fried_rice": 2}


def test_looks_like_order():
    assert looks_like_order("I want 2 jollof")
    assert looks_like_order("plantain")
    assert not looks_like_order("hello there")


def test_multi_restaurant_resolution():
    p = parse_order("2 chicken shawarma and fries")
    assert p.restaurant.id == "gh" and _as_dict(p) == {"gh_shawarma_chicken": 2, "gh_fries": 1}
    p = parse_order("egusi with 2 eba from mama put")
    assert p.restaurant.id == "mp" and _as_dict(p) == {"mp_egusi": 1, "mp_eba": 2} and p.unmatched == []
    # ambiguous item: current cart's restaurant wins the tie
    assert parse_order("2 water").restaurant.id == "ll"
    assert parse_order("2 water", "gh").restaurant.id == "gh"
    assert "Grill House" in parse_order("2 water").other_restaurants
