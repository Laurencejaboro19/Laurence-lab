"""Delivery fee and ETA calculation, measured from the chosen restaurant."""

from __future__ import annotations

import math
from dataclasses import dataclass

from .restaurant import DELIVERY, RESTAURANTS, get_restaurant


@dataclass(frozen=True)
class DeliveryQuote:
    fee: int
    distance_km: float | None
    eta_minutes: int
    zone: str | None
    deliverable: bool
    reason: str = ""


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlam / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _round_up(value: float, step: int) -> int:
    return int(math.ceil(value / step) * step) if step > 0 else int(math.ceil(value))


def _origin(restaurant_id: str | None) -> tuple[float, float]:
    r = get_restaurant(restaurant_id) or RESTAURANTS[0]
    return r.latitude, r.longitude


def quote_pickup() -> DeliveryQuote:
    return DeliveryQuote(fee=0, distance_km=None, eta_minutes=DELIVERY["prep_minutes"], zone=None, deliverable=True)


def quote_by_coordinates(lat: float, lon: float, subtotal: int, restaurant_id: str | None = None) -> DeliveryQuote:
    olat, olon = _origin(restaurant_id)
    km = round(haversine_km(olat, olon, lat, lon), 1)
    if km > DELIVERY["max_km"]:
        return DeliveryQuote(0, km, 0, None, False,
                             f"That location is {km:.1f} km away. We currently deliver within {DELIVERY['max_km']:.0f} km.")
    billable = max(0.0, km - DELIVERY["free_km"])
    fee = _round_up(DELIVERY["base_fee"] + billable * DELIVERY["per_km_fee"], DELIVERY["round_to"])
    if subtotal >= DELIVERY["free_delivery_from"]:
        fee = 0
    eta = DELIVERY["prep_minutes"] + int(math.ceil(km * DELIVERY["minutes_per_km"]))
    return DeliveryQuote(fee=fee, distance_km=km, eta_minutes=eta, zone=None, deliverable=True)


def match_zone(address: str) -> str | None:
    text = address.lower()
    best = None
    for zone in DELIVERY["zones"]:
        if zone in text and (best is None or len(zone) > len(best)):
            best = zone
    return best


def quote_by_address(address: str, subtotal: int, restaurant_id: str | None = None) -> DeliveryQuote:
    zone = match_zone(address)
    fee = DELIVERY["zones"][zone] if zone else DELIVERY["unknown_zone_fee"]
    if subtotal >= DELIVERY["free_delivery_from"]:
        fee = 0
    eta = DELIVERY["prep_minutes"] + 10 + int(fee / 100)
    return DeliveryQuote(fee=fee, distance_km=None, eta_minutes=eta, zone=zone, deliverable=True)
