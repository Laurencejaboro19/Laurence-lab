# Laurence Lab – Telegram Restaurant Bot 🍔

A production-ready Telegram bot that automates a restaurant's customer conversations:

| Area | What the bot does |
|---|---|
| **Business inquiries** | About Us, opening hours, location pin, FAQ, and a guided *Business Inquiries* form (catering, bulk orders, partnerships) that is saved and pushed to staff |
| **Food ordering** | Browse menu by category, quantity picker, cart management, **and plain-English ordering** – e.g. *"4 portions of jollof, 1 chicken, 1 chivita, 2 plantain and bottle water"* is parsed into a cart automatically |
| **Shipping / delivery** | Delivery or pickup; GPS location sharing with distance-based pricing (base fee + per-km), typed-address zone pricing, max delivery radius, free delivery above a threshold, ETA estimate |
| **Payment** | Pay on delivery, bank transfer (with "I have paid" + staff confirmation), **Paystack online checkout** (card/transfer/USSD) and **Telegram native payments** – online methods switch on automatically when their keys are configured |
| **Order tracking** | Unique order IDs (`LL-AB12CD`), live status timeline (Received → Confirmed → Preparing → Out for delivery → Delivered), push notifications to the customer on every status change, order history, customer-side cancellation |
| **Support** | "Speak to Support" tickets forwarded to staff; staff reply from Telegram with `/reply` |
| **Staff / admin** | New orders, payments, tickets and inquiries pushed to admins with one-tap status buttons; `/queue`, `/order`, `/setstatus`, `/confirmpay`, `/inquiries`, `/stats` |

Everything is stored in SQLite (no external database needed). Conversation state survives restarts.

---

## 1. Create your bot on Telegram (2 minutes, on your Android phone)

1. Open Telegram and search for **@BotFather** (blue verified tick) → tap **Start**.
2. Send `/newbot`.
3. Name: `Laurence Lab`.
4. Username: something ending in `bot`, e.g. `LaurenceLabBot` (if taken, try `LaurenceLabFoodBot`).
5. BotFather replies with a **token** like `7123456789:AAH4k...`. Keep it secret – this is your `BOT_TOKEN`.
6. Your bot's link is **`https://t.me/<username>`** (e.g. `https://t.me/LaurenceLabBot`). Open it on your phone and tap **Start** once the bot is running (step 2).

Optional polish in BotFather: `/setuserpic` (logo), `/setdescription`, `/setabouttext`.

## 2. Run the bot

### Option 0 – Already hosted on Vercel (no server needed) ✅

This repo is deployed as serverless functions at **https://laurence-lab-bot.vercel.app** with
Vercel Blob as the database. To bring it online:

1. In the Vercel project *laurence-lab-bot* → Settings → Environment Variables, add
   `BOT_TOKEN` (from @BotFather) and `ADMIN_CHAT_IDS` (your Telegram user ID, from `/myid`).
2. Redeploy. The build step (`scripts/register_webhook.py`) registers the Telegram webhook
   automatically; the home page shows the live status and the `t.me` link.

Endpoints: `/` status page · `/api/webhook` (Telegram → bot) · `/api/setup` (re-register webhook).

### Option A – On your own computer (quickest test)

```bash
git clone https://github.com/Laurencejaboro19/Laurence-lab.git
cd Laurence-lab
pip install -r requirements.txt
cp .env.example .env        # then edit .env and paste your BOT_TOKEN
python -m laurence_lab_bot
```

Open your bot link on your phone and send `/start`. Send `/myid` – the bot shows your Telegram user ID.
Put it in `ADMIN_CHAT_IDS` in `.env` and restart: you'll now receive every order, payment and support message.

### Option B – 24/7 hosting on Render (free-tier friendly)

1. Create an account at <https://render.com> and connect GitHub.
2. **New + → Blueprint**, pick this repository. Render reads `render.yaml` and creates a worker.
3. Fill in `BOT_TOKEN` and `ADMIN_CHAT_IDS` when prompted → **Apply**.
4. Done. The bot stays online and restarts automatically.

### Option C – Railway / Fly / any VPS with Docker

```bash
docker compose up -d --build      # uses .env; data persisted in a volume
```

`railway.json` and the `Dockerfile` are ready for Railway, Fly.io, Koyeb, etc.

## 3. Configuration

All settings live in `.env` (see `.env.example`):

| Variable | Purpose |
|---|---|
| `BOT_TOKEN` | **Required.** From @BotFather |
| `ADMIN_CHAT_IDS` | Comma-separated Telegram user IDs of staff. Get yours with `/myid` |
| `BANK_NAME`, `BANK_ACCOUNT_NAME`, `BANK_ACCOUNT_NUMBER` | Shown for bank-transfer payments |
| `PAYSTACK_SECRET_KEY` | Enables the "Pay online" button (Paystack hosted checkout + verification) |
| `TELEGRAM_PROVIDER_TOKEN` | Enables in-Telegram card payments (BotFather → `/mybots` → Payments) |
| `WEBHOOK_URL`, `PORT` | Leave empty for long-polling (works everywhere). Set to switch to webhook mode |
| `DB_PATH`, `CURRENCY_SYMBOL` | Storage location and currency symbol (default `₦`) |

### Restaurant data, menu and delivery pricing

Edit **`laurence_lab_bot/restaurant.py`** – it's plain Python data:

- `RESTAURANT` – name, tagline, address, GPS coordinates, phone, email, hours, FAQ.
- `MENU` – items with price, category, description and **aliases** used by the plain-text order parser
  (e.g. `"dodo"` → Fried Plantain).
- `DELIVERY` – base fee, per-km fee, free km, max radius, free-delivery threshold, flat zone fees, prep time.

No code changes needed; restart the bot after editing.

## 4. Customer commands

`/start` · `/menu` · `/cart` · `/track` · `/orders` · `/support` · `/about` · `/hours` · `/help` · `/cancel`

…or just type what you want to eat.

## 5. Staff commands

| Command | Action |
|---|---|
| `/admin` | Admin help |
| `/queue` | All active orders |
| `/order LL-XXXXXX` | View an order with action buttons (Confirm → Preparing → Out for delivery → Delivered) |
| `/setstatus LL-XXXXXX preparing` | Update status (customer is notified instantly) |
| `/confirmpay LL-XXXXXX` | Confirm a bank transfer |
| `/reply <user_id> <text>` | Answer a support ticket or business inquiry |
| `/inquiries` | Latest business inquiries |
| `/stats` | Orders, revenue, tickets |

## 6. Development

```bash
pip install -r requirements.txt pytest
python -m pytest -q
```

```
laurence_lab_bot/
├── main.py          # app wiring, polling / webhook
├── config.py        # .env settings
├── restaurant.py    # business data, menu, delivery pricing  ← edit me
├── delivery.py      # haversine distance, fees, ETA
├── nlp.py           # plain-English order parser
├── payments.py      # Paystack, bank transfer, Telegram payments
├── storage.py       # SQLite: orders, customers, inquiries, tickets
├── formatting.py    # message text builders
├── keyboards.py     # inline / reply keyboards
└── handlers/        # start, info, menu, cart, checkout, payment, tracking, support, admin, text
```

## License

MIT
