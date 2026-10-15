"""Business data: the Laurence Lab platform, its partner restaurants, their menus and delivery pricing.

Edit this file to change what customers see. Every restaurant has a ``vendor_code``: staff of that
restaurant send ``/vendor <code>`` to the bot once and from then on receive that restaurant's orders.

⚠️  The entries below are SAMPLE DATA. Replace addresses, phones, hours, menus and prices with real ones.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

# ---------------------------------------------------------------------------
# The platform (the brand customers talk to)
# ---------------------------------------------------------------------------
PLATFORM = {
    "name": "Laurence Lab",
    "tagline": "Fresh, fast food delivered right to your doorstep.",
    "description": (
        "Laurence Lab connects you with the best kitchens around you. Pick a restaurant, order in plain "
        "English or from the menu, pay how you like, and track your rider live."
    ),
    "support_phone": "+234 805 982 7250",
    "support_email": "hello@laurencelab.ng",
    "website": "https://laurence-lab-bot.vercel.app",
    "instagram": "@laurencelab",
    "faq": [
        ("How long does delivery take?", "Usually 30–60 minutes depending on the restaurant, distance and traffic."),
        ("Can I order from two restaurants at once?", "One restaurant per order, so each kitchen can cook and dispatch independently."),
        ("Can I pay on delivery?", "Yes. You can also pay by bank transfer or securely online by card, transfer or USSD."),
        ("Do you cater events?", "Yes! Use 'Business Inquiries' and tell us about your event."),
        ("I own a restaurant – can I join?", "Use 'Business Inquiries' → Partnership and we'll onboard you."),
    ],
}

TZ = timezone(timedelta(hours=int(os.getenv("TZ_OFFSET_HOURS", "1"))))  # Africa/Lagos = UTC+1, no DST

# ---------------------------------------------------------------------------
# Delivery pricing (platform-wide; distance is measured from the chosen restaurant)
# ---------------------------------------------------------------------------
DELIVERY = {
    "base_fee": 500,
    "free_km": 2.0,
    "per_km_fee": 150,
    "max_km": 25.0,
    "free_delivery_from": 25000,
    "round_to": 50,
    "prep_minutes": 25,
    "minutes_per_km": 3,
    "zones": {
        "lekki": 800, "lekki phase 1": 800, "lekki phase 2": 1200, "victoria island": 1000, "vi": 1000,
        "ikoyi": 1000, "ajah": 1800, "sangotedo": 2200, "yaba": 1800, "surulere": 2000, "ikeja": 2500,
        "maryland": 2200, "gbagada": 1800, "oniru": 900, "chevron": 1200, "osapa": 1200, "agungi": 1300,
        "jakande": 1400, "obalende": 1200, "lagos island": 1200, "festac": 3000, "apapa": 3000,
    },
    "unknown_zone_fee": 2500,
}


@dataclass(frozen=True)
class Restaurant:
    id: str
    name: str
    emoji: str
    cuisine: str
    tagline: str
    address: str
    latitude: float
    longitude: float
    phone: str
    email: str
    opening_hours: dict  # weekday name -> (open "HH:MM", close "HH:MM") or None when closed
    vendor_code: str     # staff send `/vendor <code>` to receive this restaurant's orders

    def hours_text(self) -> str:
        lines = []
        for day in ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"):
            h = self.opening_hours.get(day)
            lines.append(f"*{day}:* {h[0]} – {h[1]}" if h else f"*{day}:* Closed")
        return "\n".join(lines)

    def is_open_now(self, now: datetime | None = None) -> bool:
        now = now or datetime.now(TZ)
        h = self.opening_hours.get(now.strftime("%A"))
        if not h:
            return False
        open_t = now.replace(hour=int(h[0][:2]), minute=int(h[0][3:]), second=0, microsecond=0)
        close_t = now.replace(hour=int(h[1][:2]), minute=int(h[1][3:]), second=0, microsecond=0)
        return open_t <= now <= close_t

    def effective_vendor_code(self) -> str:
        return os.getenv(f"VENDOR_CODE_{self.id.upper()}", self.vendor_code)


@dataclass(frozen=True)
class MenuItem:
    id: str
    restaurant_id: str
    name: str
    category: str
    price: int
    description: str = ""
    unit: str = "portion"
    aliases: tuple[str, ...] = field(default_factory=tuple)
    emoji: str = "🍽️"

    @property
    def all_names(self) -> tuple[str, ...]:
        return (self.name.lower(),) + tuple(a.lower() for a in self.aliases)


_STD_HOURS = {d: ("09:00", "22:00") for d in ("Monday", "Tuesday", "Wednesday", "Thursday")}
_STD_HOURS.update({"Friday": ("09:00", "23:00"), "Saturday": ("10:00", "23:00"), "Sunday": ("12:00", "21:00")})

RESTAURANTS: list[Restaurant] = [
    Restaurant(
        id="ll", name="Laurence Lab Kitchen", emoji="🍚", cuisine="Nigerian · Rice & Grills",
        tagline="Smoky jollof, grilled proteins and chilled drinks.",
        address="12 Admiralty Way, Lekki Phase 1, Lagos", latitude=6.4474, longitude=3.4723,
        phone="+234 805 982 7250", email="kitchen@laurencelab.ng", opening_hours=_STD_HOURS,
        vendor_code="LL-KITCHEN-2026",
    ),
    Restaurant(
        id="mp", name="Mama Put Express", emoji="🥘", cuisine="Nigerian · Soups & Swallow",
        tagline="Home-style soups, swallow and native rice.",
        address="5 Awolowo Road, Ikoyi, Lagos", latitude=6.4432, longitude=3.4216,
        phone="+234 800 000 0002", email="orders@mamaputexpress.ng", opening_hours={**_STD_HOURS, "Sunday": None},
        vendor_code="MP-EXPRESS-2026",
    ),
    Restaurant(
        id="gh", name="Grill House", emoji="🍗", cuisine="Grills · Shawarma · Burgers",
        tagline="Suya, shawarma and loaded burgers till late.",
        address="22 Chevron Drive, Lekki, Lagos", latitude=6.4381, longitude=3.5301,
        phone="+234 800 000 0003", email="hello@grillhouse.ng",
        opening_hours={d: ("12:00", "23:59") for d in ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")},
        vendor_code="GH-GRILL-2026",
    ),
]
RESTAURANT_BY_ID: dict[str, Restaurant] = {r.id: r for r in RESTAURANTS}

CATEGORIES = [
    ("rice", "🍚 Rice & Mains"),
    ("soup", "🥣 Soups & Swallow"),
    ("protein", "🍗 Proteins"),
    ("grill", "🔥 Grills & Shawarma"),
    ("burger", "🍔 Burgers & Wraps"),
    ("sides", "🍌 Sides"),
    ("drinks", "🥤 Drinks"),
    ("combo", "🎁 Combos"),
]


def _m(rid, iid, name, cat, price, desc="", unit="portion", aliases=(), emoji="🍽️"):
    return MenuItem(f"{rid}_{iid}", rid, name, cat, price, desc, unit, tuple(aliases), emoji)


MENU: list[MenuItem] = [
    # ---- Laurence Lab Kitchen
    _m("ll", "jollof", "Jollof Rice", "rice", 1500, "Smoky party-style jollof rice.", "portion", ("jollof", "jollof rice", "jolof"), "🍚"),
    _m("ll", "fried_rice", "Fried Rice", "rice", 1500, "Fried rice with mixed veggies and liver.", "portion", ("fried rice", "friedrice"), "🍚"),
    _m("ll", "white_rice", "White Rice & Stew", "rice", 1200, "Steamed white rice with tomato stew.", "portion", ("white rice", "rice and stew", "rice & stew"), "🍚"),
    _m("ll", "spaghetti", "Jollof Spaghetti", "rice", 1400, "Spaghetti cooked in rich jollof sauce.", "portion", ("spaghetti", "spag", "pasta"), "🍝"),
    _m("ll", "chicken", "Grilled Chicken", "protein", 2500, "Quarter chicken, grilled and spiced.", "piece", ("chicken", "grilled chicken", "chicken lap"), "🍗"),
    _m("ll", "fried_chicken", "Fried Chicken", "protein", 2500, "Crispy fried chicken.", "piece", ("fried chicken",), "🍗"),
    _m("ll", "beef", "Beef", "protein", 1000, "Peppered beef (2 pieces).", "serving", ("beef", "meat", "peppered beef"), "🥩"),
    _m("ll", "fish", "Grilled Fish", "protein", 3000, "Grilled tilapia with pepper sauce.", "piece", ("fish", "grilled fish", "tilapia", "croaker"), "🐟"),
    _m("ll", "turkey", "Turkey", "protein", 3000, "Peppered turkey wing.", "piece", ("turkey", "turkey wing"), "🦃"),
    _m("ll", "egg", "Boiled Egg", "protein", 300, "One boiled egg.", "piece", ("egg", "boiled egg", "eggs"), "🥚"),
    _m("ll", "plantain", "Fried Plantain", "sides", 500, "Sweet fried plantain (dodo).", "portion", ("plantain", "dodo", "fried plantain", "plantains"), "🍌"),
    _m("ll", "coleslaw", "Coleslaw", "sides", 500, "Creamy coleslaw.", "portion", ("coleslaw", "slaw"), "🥗"),
    _m("ll", "moimoi", "Moi Moi", "sides", 600, "Steamed bean pudding.", "piece", ("moi moi", "moimoi", "moin moin"), "🫘"),
    _m("ll", "salad", "Mixed Salad", "sides", 700, "Fresh garden salad.", "portion", ("salad", "mixed salad"), "🥗"),
    _m("ll", "chivita", "Chivita Juice (1L)", "drinks", 1000, "Chivita fruit juice.", "bottle", ("chivita", "juice", "chivita juice"), "🧃"),
    _m("ll", "water", "Bottle Water", "drinks", 300, "75cl bottled water.", "bottle", ("water", "bottle water", "bottled water", "bottle of water"), "💧"),
    _m("ll", "coke", "Coca-Cola", "drinks", 500, "50cl Coke.", "bottle", ("coke", "coca cola", "coca-cola", "cola"), "🥤"),
    _m("ll", "malt", "Malt", "drinks", 700, "Malta Guinness.", "bottle", ("malt", "malta", "maltina"), "🍺"),
    _m("ll", "zobo", "Zobo", "drinks", 700, "Chilled hibiscus drink.", "bottle", ("zobo", "zobo drink"), "🍹"),
    _m("ll", "combo_classic", "Classic Combo", "combo", 4000, "Jollof rice + grilled chicken + plantain + water.", "combo", ("classic combo", "combo"), "🎁"),
    _m("ll", "combo_family", "Family Pack", "combo", 12000, "4 jollof + 4 chicken + 2 plantain + 4 drinks.", "combo", ("family pack", "family combo"), "👨‍👩‍👧‍👦"),
    # ---- Mama Put Express
    _m("mp", "egusi", "Egusi Soup", "soup", 2000, "Melon seed soup with assorted meat.", "portion", ("egusi", "egusi soup"), "🥣"),
    _m("mp", "efo", "Efo Riro", "soup", 1800, "Spinach stew with assorted meat.", "portion", ("efo", "efo riro", "vegetable soup"), "🥬"),
    _m("mp", "ogbono", "Ogbono Soup", "soup", 2000, "Draw soup with stockfish.", "portion", ("ogbono", "ogbono soup"), "🥣"),
    _m("mp", "afang", "Afang Soup", "soup", 2200, "Afang leaves with periwinkle and beef.", "portion", ("afang", "afang soup"), "🥣"),
    _m("mp", "eba", "Eba", "soup", 500, "Garri swallow.", "wrap", ("eba", "garri"), "🍘"),
    _m("mp", "pounded_yam", "Pounded Yam", "soup", 800, "Smooth pounded yam.", "wrap", ("pounded yam", "poundo", "iyan"), "🍘"),
    _m("mp", "amala", "Amala", "soup", 500, "Yam flour swallow.", "wrap", ("amala",), "🍘"),
    _m("mp", "semo", "Semovita", "soup", 500, "Semolina swallow.", "wrap", ("semo", "semovita"), "🍘"),
    _m("mp", "ofada", "Ofada Rice & Ayamase", "rice", 2200, "Local ofada rice with green pepper sauce.", "portion", ("ofada", "ofada rice", "ayamase"), "🍛"),
    _m("mp", "assorted", "Assorted Meat", "protein", 1200, "Shaki, ponmo and beef.", "serving", ("assorted", "assorted meat", "shaki", "ponmo"), "🥩"),
    _m("mp", "goat_meat", "Goat Meat", "protein", 1500, "Peppered goat meat.", "serving", ("goat meat", "goat"), "🐐"),
    _m("mp", "water", "Bottle Water", "drinks", 300, "75cl bottled water.", "bottle", ("water", "bottle water"), "💧"),
    _m("mp", "zobo", "Zobo", "drinks", 600, "Chilled hibiscus drink.", "bottle", ("zobo",), "🍹"),
    _m("mp", "kunu", "Kunu", "drinks", 600, "Millet drink.", "bottle", ("kunu", "kunun zaki"), "🥛"),
    # ---- Grill House
    _m("gh", "shawarma_chicken", "Chicken Shawarma", "grill", 2500, "Grilled chicken, veggies, sauce, double sausage.", "wrap", ("chicken shawarma", "shawarma"), "🌯"),
    _m("gh", "shawarma_beef", "Beef Shawarma", "grill", 2800, "Spiced beef strips with garlic sauce.", "wrap", ("beef shawarma",), "🌯"),
    _m("gh", "suya_beef", "Beef Suya", "grill", 2000, "Spicy skewered beef with yaji.", "portion", ("suya", "beef suya"), "🍢"),
    _m("gh", "suya_chicken", "Chicken Suya", "grill", 2200, "Skewered chicken with yaji.", "portion", ("chicken suya",), "🍢"),
    _m("gh", "wings", "BBQ Wings (6 pcs)", "grill", 3000, "Sticky barbecue chicken wings.", "pack", ("wings", "bbq wings", "chicken wings"), "🍗"),
    _m("gh", "burger_classic", "Classic Beef Burger", "burger", 3500, "Beef patty, cheese, lettuce, tomato.", "burger", ("burger", "beef burger", "classic burger"), "🍔"),
    _m("gh", "burger_chicken", "Crispy Chicken Burger", "burger", 3500, "Fried chicken fillet with slaw.", "burger", ("chicken burger",), "🍔"),
    _m("gh", "fries", "French Fries", "sides", 1200, "Crispy seasoned fries.", "portion", ("fries", "french fries", "chips"), "🍟"),
    _m("gh", "coke", "Coca-Cola", "drinks", 500, "50cl Coke.", "bottle", ("coke", "coca cola", "cola"), "🥤"),
    _m("gh", "water", "Bottle Water", "drinks", 300, "75cl bottled water.", "bottle", ("water", "bottle water"), "💧"),
    _m("gh", "milkshake", "Vanilla Milkshake", "drinks", 2000, "Thick vanilla shake.", "cup", ("milkshake", "shake"), "🥤"),
]

MENU_BY_ID: dict[str, MenuItem] = {item.id: item for item in MENU}


def items_for(restaurant_id: str, category_id: str | None = None) -> list[MenuItem]:
    return [i for i in MENU if i.restaurant_id == restaurant_id and (category_id is None or i.category == category_id)]


def categories_for(restaurant_id: str) -> list[tuple[str, str]]:
    present = {i.category for i in MENU if i.restaurant_id == restaurant_id}
    return [(cid, label) for cid, label in CATEGORIES if cid in present]


def category_label(category_id: str) -> str:
    for cid, label in CATEGORIES:
        if cid == category_id:
            return label
    return category_id.title()


def get_restaurant(restaurant_id: str | None) -> Restaurant | None:
    return RESTAURANT_BY_ID.get(restaurant_id or "")


def restaurant_for_item(item_id: str) -> Restaurant | None:
    item = MENU_BY_ID.get(item_id)
    return get_restaurant(item.restaurant_id) if item else None


def find_restaurant_by_code(code: str) -> Restaurant | None:
    code = code.strip().upper()
    for r in RESTAURANTS:
        if r.effective_vendor_code().upper() == code:
            return r
    return None


# Backwards-compatible view of the primary restaurant (used by a few text builders)
RESTAURANT = {
    "name": PLATFORM["name"],
    "tagline": PLATFORM["tagline"],
    "description": PLATFORM["description"],
    "address": RESTAURANTS[0].address,
    "latitude": RESTAURANTS[0].latitude,
    "longitude": RESTAURANTS[0].longitude,
    "phone": PLATFORM["support_phone"],
    "email": PLATFORM["support_email"],
    "website": PLATFORM["website"],
    "instagram": PLATFORM["instagram"],
    "faq": PLATFORM["faq"],
}
