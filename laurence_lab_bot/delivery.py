"""Delivery fee and ETA calculation."""

from __future__ import annotations

import math
from dataclasses import dataclass

from .restaurant import DELIVERY, RESTAURANT


@dataclass(frozen=True)
class DeliveryQuote:
    fee: int
    distance_km: float | None
    eta_minutes: int
    zone: str | None
    deliverable: bool
    reason: str = ""


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two points in kilometres."""
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlam / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _round_up(value: float, step: int) -> int:
    if step <= 0:
        return int(math.ceil(value))
    return int(math.ceil(value / step) * step)


def quote_pickup() -> DeliveryQuote:
    return DeliveryQuote(fee=0, distance_km=None, eta_minutes=DELIVERY["prep_minutes"], zone=None, deliverable=True)


def quote_by_coordinates(lat: float, lon: float, subtotal: int) -> DeliveryQuote:
    km = haversine_km(RESTAURANT["latitude"], RESTAURANT["longitude"], lat, lon)
    km = round(km, 1)
    if km > DELIVERY["max_km"]:
        return DeliveryQuote(
            fee=0,
            distance_km=km,
            eta_minutes=0,
            zone=None,
            deliverable=False,
            reason=f"That location is {km:.1f} km away. We currently deliver within {DELIVERY['max_km']:.0f} km.",
        )
    billable = max(0.0, km - DELIVERY["free_km"])
    fee = DELIVERY["base_fee"] + billable * DELIVERY["per_km_fee"]
    fee = _round_up(fee, DELIVERY["round_to"])
    if subtotal >= DELIVERY["free_delivery_from"]:
        fee = 0
    eta = DELIVERY["prep_minutes"] + int(math.ceil(km * DELIVERY["minutes_per_km"]))
    return DeliveryQuote(fee=fee, distance_km=km, eta_minutes=eta, zone=None, deliverable=True)


def match_zone(address: str) -> str | None:
    """Return the longest zone name found inside the typed address, if any."""
    text = address.lower()
    best = None
    for zone in DELIVERY["zones"]:
        if zone in text and (best is None or len(zone) > len(best)):
            best = zone
    return best


def quote_by_address(address: str, subtotal: int) -> DeliveryQuote:
    zone = match_zone(address)
    if zone is None:
        fee = DELIVERY["unknown_zone_fee"]
    else:
        fee = DELIVERY["zones"][zone]
    if subtotal >= DELIVERY["free_delivery_from"]:
        fee = 0
    # Rough ETA: zones further out cost more, so scale ETA with the fee.
    eta = DELIVERY["prep_minutes"] + 10 + int(fee / 100)
    return DeliveryQuote(fee=fee, distance_km=None, eta_minutes=eta, zone=zone, deliverable=True)
