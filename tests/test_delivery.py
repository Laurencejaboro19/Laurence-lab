from laurence_lab_bot.delivery import haversine_km, match_zone, quote_by_address, quote_by_coordinates, quote_pickup
from laurence_lab_bot.restaurant import DELIVERY, RESTAURANT


def test_pickup_is_free():
    q = quote_pickup()
    assert q.fee == 0 and q.deliverable


def test_haversine_zero_distance():
    assert haversine_km(6.44, 3.47, 6.44, 3.47) == 0


def test_nearby_location_pays_base_fee():
    q = quote_by_coordinates(RESTAURANT["latitude"] + 0.005, RESTAURANT["longitude"], subtotal=3000)
    assert q.deliverable
    assert q.fee == DELIVERY["base_fee"]
    assert q.eta_minutes >= DELIVERY["prep_minutes"]


def test_far_location_pays_per_km():
    # ~0.09 deg latitude ≈ 10 km
    q = quote_by_coordinates(RESTAURANT["latitude"] + 0.09, RESTAURANT["longitude"], subtotal=3000)
    assert q.deliverable
    assert q.fee > DELIVERY["base_fee"]
    assert q.fee % DELIVERY["round_to"] == 0


def test_too_far_is_not_deliverable():
    q = quote_by_coordinates(RESTAURANT["latitude"] + 1.0, RESTAURANT["longitude"], subtotal=3000)
    assert not q.deliverable
    assert "km" in q.reason


def test_free_delivery_threshold():
    q = quote_by_coordinates(RESTAURANT["latitude"] + 0.05, RESTAURANT["longitude"], subtotal=DELIVERY["free_delivery_from"])
    assert q.fee == 0


def test_zone_matching_prefers_longest():
    assert match_zone("12 Fola Osibo, Lekki Phase 1, Lagos") == "lekki phase 1"
    assert match_zone("Somewhere in Ikeja GRA") == "ikeja"
    assert match_zone("Mars") is None


def test_zone_fees():
    assert quote_by_address("Ikoyi", 1000).fee == DELIVERY["zones"]["ikoyi"]
    assert quote_by_address("Unknown place", 1000).fee == DELIVERY["unknown_zone_fee"]
