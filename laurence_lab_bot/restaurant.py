"""Business data for the restaurant: profile, opening hours, delivery zones and the menu.

Edit this file to change what the bot tells customers. No other code changes are needed.
"""

from __future__ import annotations

from dataclasses import dataclass, field

RESTAURANT = {
    "name": "Laurence Lab",
    "tagline": "Fresh, fast food delivered right to your doorstep.",
    "description": (
        "Laurence Lab is a modern Nigerian kitchen serving freshly cooked rice dishes, "
        "grilled proteins, sides and chilled drinks. Every order is cooked when you place it "
        "and delivered hot by our riders."
    ),
    "address": "12 Admiralty Way, Lekki Phase 1, Lagos, Nigeria",
    "latitude": 6.4474,
    "longitude": 3.4723,
    "phone": "+234 800 000 0000",
    "email": "hello@laurencelab.ng",
    "website": "https://laurencelab.ng",
    "instagram": "@laurencelab",
    "opening_hours": {
        "Monday": "9:00 AM – 10:00 PM",
        "Tuesday": "9:00 AM – 10:00 PM",
        "Wednesday": "9:00 AM – 10:00 PM",
        "Thursday": "9:00 AM – 10:00 PM",
        "Friday": "9:00 AM – 11:00 PM",
        "Saturday": "10:00 AM – 11:00 PM",
        "Sunday": "12:00 PM – 9:00 PM",
    },
    "faq": [
        ("How long does delivery take?", "Usually 30–60 minutes depending on distance and traffic."),
        ("Do you cater events?", "Yes! Use 'Business Inquiries' and tell us about your event."),
        ("Can I pay on delivery?", "Yes. You can also pay by bank transfer or online card payment."),
        ("What is the minimum order?", "There is no minimum order for pickup. Delivery orders start from ₦1,000."),
    ],
}

# ---------------------------------------------------------------------------
# Delivery pricing
# ---------------------------------------------------------------------------
DELIVERY = {
    "base_fee": 500,          # charged on every delivery
    "free_km": 2.0,           # first N km included in the base fee
    "per_km_fee": 150,        # fee for each km beyond free_km
    "max_km": 25.0,           # beyond this we don't deliver
    "free_delivery_from": 25000,  # subtotal at/above which delivery is free
    "round_to": 50,           # round fee up to this step
    "prep_minutes": 25,       # kitchen preparation time
    "minutes_per_km": 3,      # rider travel time estimate
    # Flat fees for customers who type an area name instead of sharing GPS location.
    "zones": {
        "lekki": 800,
        "lekki phase 1": 800,
        "lekki phase 2": 1200,
        "victoria island": 1000,
        "vi": 1000,
        "ikoyi": 1000,
        "ajah": 1800,
        "sangotedo": 2200,
        "yaba": 1800,
        "surulere": 2000,
        "ikeja": 2500,
        "maryland": 2200,
        "gbagada": 1800,
        "oniru": 900,
        "chevron": 1200,
        "osapa": 1200,
        "agungi": 1300,
        "jakande": 1400,
        "obalende": 1200,
        "lagos island": 1200,
        "festac": 3000,
        "apapa": 3000,
    },
    "unknown_zone_fee": 2500,
}


@dataclass(frozen=True)
class MenuItem:
    id: str
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


CATEGORIES = [
    ("rice", "🍚 Rice & Mains"),
    ("protein", "🍗 Proteins"),
    ("sides", "🍌 Sides"),
    ("drinks", "🥤 Drinks"),
    ("combo", "🎁 Combos"),
]

MENU: list[MenuItem] = [
    # Rice & mains
    MenuItem("jollof", "Jollof Rice", "rice", 1500, "Smoky party-style jollof rice.", "portion", ("jollof", "jollof rice", "jolof"), "🍚"),
    MenuItem("fried_rice", "Fried Rice", "rice", 1500, "Fried rice with mixed veggies and liver.", "portion", ("fried rice", "friedrice"), "🍚"),
    MenuItem("ofada", "Ofada Rice & Sauce", "rice", 2000, "Local ofada rice with spicy ayamase sauce.", "portion", ("ofada", "ofada rice", "ayamase"), "🍛"),
    MenuItem("white_rice", "White Rice & Stew", "rice", 1200, "Steamed white rice with tomato stew.", "portion", ("white rice", "rice and stew", "rice & stew"), "🍚"),
    MenuItem("spaghetti", "Jollof Spaghetti", "rice", 1400, "Spaghetti cooked in rich jollof sauce.", "portion", ("spaghetti", "spag", "pasta"), "🍝"),
    MenuItem("eba_egusi", "Eba & Egusi Soup", "rice", 2200, "Garri swallow with egusi soup and assorted meat.", "portion", ("eba", "egusi", "eba and egusi"), "🥣"),
    # Proteins
    MenuItem("chicken", "Grilled Chicken", "protein", 2500, "Quarter chicken, grilled and spiced.", "piece", ("chicken", "grilled chicken", "chicken lap"), "🍗"),
    MenuItem("fried_chicken", "Fried Chicken", "protein", 2500, "Crispy fried chicken.", "piece", ("fried chicken",), "🍗"),
    MenuItem("beef", "Beef", "protein", 1000, "Peppered beef (2 pieces).", "serving", ("beef", "meat", "peppered beef"), "🥩"),
    MenuItem("fish", "Grilled Fish", "protein", 3000, "Grilled tilapia with pepper sauce.", "piece", ("fish", "grilled fish", "tilapia", "croaker"), "🐟"),
    MenuItem("turkey", "Turkey", "protein", 3000, "Peppered turkey wing.", "piece", ("turkey", "turkey wing"), "🦃"),
    MenuItem("egg", "Boiled Egg", "protein", 300, "One boiled egg.", "piece", ("egg", "boiled egg", "eggs"), "🥚"),
    # Sides
    MenuItem("plantain", "Fried Plantain", "sides", 500, "Sweet fried plantain (dodo).", "portion", ("plantain", "dodo", "fried plantain", "plantains"), "🍌"),
    MenuItem("coleslaw", "Coleslaw", "sides", 500, "Creamy coleslaw.", "portion", ("coleslaw", "slaw"), "🥗"),
    MenuItem("moimoi", "Moi Moi", "sides", 600, "Steamed bean pudding.", "piece", ("moi moi", "moimoi", "moin moin"), "🫘"),
    MenuItem("salad", "Mixed Salad", "sides", 700, "Fresh garden salad.", "portion", ("salad", "mixed salad"), "🥗"),
    MenuItem("puff_puff", "Puff Puff (5 pcs)", "sides", 500, "Fluffy fried dough balls.", "pack", ("puff puff", "puffpuff", "puff"), "🍩"),
    # Drinks
    MenuItem("chivita", "Chivita Juice (1L)", "drinks", 1000, "Chivita fruit juice.", "bottle", ("chivita", "juice", "chivita juice"), "🧃"),
    MenuItem("water", "Bottle Water", "drinks", 300, "75cl bottled water.", "bottle", ("water", "bottle water", "bottled water", "bottle of water"), "💧"),
    MenuItem("coke", "Coca-Cola", "drinks", 500, "50cl Coke.", "bottle", ("coke", "coca cola", "coca-cola", "cola"), "🥤"),
    MenuItem("fanta", "Fanta", "drinks", 500, "50cl Fanta.", "bottle", ("fanta",), "🥤"),
    MenuItem("malt", "Malt", "drinks", 700, "Malta Guinness.", "bottle", ("malt", "malta", "maltina"), "🍺"),
    MenuItem("zobo", "Zobo", "drinks", 700, "Chilled hibiscus drink.", "bottle", ("zobo", "zobo drink"), "🍹"),
    # Combos
    MenuItem("combo_classic", "Classic Combo", "combo", 4000, "Jollof rice + grilled chicken + plantain + water.", "combo", ("classic combo", "combo"), "🎁"),
    MenuItem("combo_family", "Family Pack", "combo", 12000, "4 jollof + 4 chicken + 2 plantain + 4 drinks.", "combo", ("family pack", "family combo"), "👨‍👩‍👧‍👦"),
]

MENU_BY_ID: dict[str, MenuItem] = {item.id: item for item in MENU}


def items_in_category(category_id: str) -> list[MenuItem]:
    return [item for item in MENU if item.category == category_id]


def category_label(category_id: str) -> str:
    for cid, label in CATEGORIES:
        if cid == category_id:
            return label
    return category_id.title()
