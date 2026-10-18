# Decision Record

Each decision lists what was chosen, what was rejected, and what breaks without it. Written for the
owner, who will maintain this alone from a possibly low-powered device. The fixed inputs were:
TypeScript on Node LTS, Fastify, Supabase Postgres, no web front end, no Docker required locally.

The bias throughout is **boring, pure-JavaScript, one process, one database**. Every extra service is
one more thing that can be down at 7 pm on a Friday when the kitchen is busy.

---

## DR-001 — Database access: `pg` with hand-written SQL, no ORM

**Chosen:** the `pg` driver with parameterised SQL in small repository modules; a ~100-line migration
runner that applies numbered `.sql` files inside a transaction under an advisory lock.

**Rejected:**

- _Prisma_ — ships a native query engine binary per platform. It has WASM options now, but it is the
  single most common "fails to install on Termux / ARM" report, and the generated client hides the SQL
  the owner wants to audit.
- _Drizzle_ — pure JS and good, but adds a schema DSL that duplicates the SQL migrations, and the
  owner already reads SQL fluently.
- _Kysely_ — pure JS query builder; a reasonable second choice. Rejected only because plain SQL is one
  fewer layer to learn and the number of queries here is modest.

**Why it matters:** the money- and stock-critical paths (reservation, payment confirmation, refunds)
are easier to review when the exact SQL is in front of the reviewer with a `REVIEW:` comment above
it, and `pg` has no native dependencies, so `npm ci` works everywhere including Android.

---

## DR-002 — Job queue: `pg-boss` on the main Postgres (no Redis)

**Chosen:** `pg-boss` — a Postgres-backed queue using `SELECT … FOR UPDATE SKIP LOCKED`, with
retries, exponential backoff, dead-letter queues, singleton keys (dedupe), and cron scheduling with a
built-in leader lock.

**Rejected:**

- _BullMQ + Redis_ — excellent, but Redis is a second service to host, back up and pay for. At our
  scale (≤5,000 orders/day, a few hundred jobs/minute at peak) Postgres handles the queue without
  noticing.
- _graphile-worker_ — also good; `pg-boss` chosen for its scheduling, singleton and dead-letter
  features out of the box.
- _Hand-written queue_ — tempting for readability, but retries, visibility timeouts and leader
  election are exactly where home-grown queues lose jobs. Reuse the battle-tested one.

**Constraints it imposes:** `pg-boss` needs a **session-mode or direct** connection
(`DATABASE_URL_DIRECT`), not the transaction pooler, because it uses `LISTEN/NOTIFY` and session
state. It owns its own schema (`pgboss`) and is excluded from the exposed API schemas.

**What breaks without it:** webhook handlers would have to do real work inline, violating the
"acknowledge in under 500 ms" target; scheduled jobs would double-run when two instances start.

---

## DR-003 — Validation and OpenAPI: Zod v4 + `fastify-type-provider-zod`

**Chosen:** Zod schemas at every boundary (env, HTTP bodies, webhook payloads, AI output, settings
JSON). The Fastify Zod type provider turns the same route schemas into the OpenAPI document served at
`/internal/v1/openapi.json`.

**Rejected:** TypeBox (JSON-Schema-first; fine, but Zod is what the owner is likelier to meet
elsewhere) and hand-written OpenAPI (drifts from the code within a week).

---

## DR-004 — Hosting: a small always-on VM/container (Fly.io, `lhr` region), not serverless

**Chosen (to be price-checked in phase 8, COSTS.md):** Fly.io with one `shared-cpu-1x` machine for
staging and one or two for production, in **London (`lhr`)** to sit next to the database. Railway
and Render are acceptable substitutes with the same deployment files; all three run a plain
container from the repository `Dockerfile`.

**Rejected:**

- _Vercel / Netlify / Cloudflare Workers (serverless-only)_ — no long-lived process for the queue
  consumers and scheduler, cold starts on webhook acknowledgement, and `LISTEN/NOTIFY` is impossible.
- _Render free tier_ — spins down after inactivity; a Telegram webhook hitting a sleeping instance
  waits ~30 s. Unsafe for production, fine for a demo.
- _A VPS (e.g. Hetzner)_ — cheapest at scale, but the owner then owns OS patching, TLS and process
  supervision. Reasonable upgrade path later; noted in HANDOVER.md.

**Why London:** Supabase has **no African region** (verified against the regions page on
2026-10-17: closest options are London `eu-west-2`, Ireland `eu-west-1`, Paris, Frankfurt). Lagos →
London round-trips are ~90–120 ms over the main submarine routes. A request makes several DB
round-trips, so the app server must be in the same region as the database; the one customer-facing
hop from Nigeria happens once per message. Hence app and DB both in London.

---

## DR-005 — Supabase project layout and connection modes

- Three Supabase projects: `laurence-lab-dev` (Free, allowed to pause), `laurence-lab-staging`
  (Free or Pro), `laurence-lab-prod` (**Pro, $25/month**, daily backups kept 7 days, never paused).
  Point-in-time recovery is an add-on ($100/month per 7 days of retention) — recommended once daily
  revenue makes a lost day expensive; until then, daily backups plus our own nightly `pg_dump` to
  object storage (phase 8). Verified on the pricing page 2026-10-17.
- The app runs as **`app_runtime`** (least privilege) and migrations run as **`app_migrate`**; the
  `postgres` superuser is never used by the application.
- Connection strings (see README): request-time traffic may use the shared **transaction** pooler
  (port 6543, IPv4, prepared statements off); the job queue, scheduler and migrations use the shared
  **session** pooler (port 5432, IPv4) or the direct connection. Direct connections are IPv6-only
  without the paid IPv4 add-on, so **the default is the session pooler**, which is IPv4 on every plan.
  (Verified on Supabase's connection-strings reference, 2026-10-17.)
- The Data API (PostgREST) is **not used**. Business tables live in a non-exposed schema (`app`) and
  RLS is enabled on every table with no policies for `anon`/`authenticated`; a test in phase 2 proves
  the anon key gets nothing.
- Supabase Storage and Realtime are **not used** in v1. Menu photos are Telegram `file_id`s /
  WhatsApp media ids stored as text; if the owner later wants a web dashboard with photos, Storage
  is the natural add, isolated behind a `MediaStore` interface.

---

## DR-006 — Maps and geocoding: location pins + our own zone polygons; geocoder behind an interface

**Chosen:** the primary address input is a **shared location pin** (both Telegram and WhatsApp
support it natively). Zone membership is a point-in-polygon check against zone polygons stored in
our database — zero external calls, works offline, and is deterministic. Typed addresses go through a
`Geocoder` interface with a `none` provider (ask for a pin), a `google` provider (best Nigerian
coverage; pay-as-you-go, price verified in phase 8) and a `nominatim` provider for local dev only
(its usage policy forbids production use at our volume).

**Rejected:** routing every order through a paid geocoder (cost, latency, and Nigerian street
addresses are often ambiguous anyway — a pin is more accurate than "opposite the blue gate").

---

## DR-007 — AI provider: Anthropic behind an abstraction, off by default

**Chosen:** an `IntentParser` interface. The default implementation is a **deterministic
keyword/quantity parser** (no AI, no cost, no latency) that handles the common "4 jollof, 1 chicken
and water" case. An optional `AnthropicIntentParser` (Claude Haiku-class model, owner's key) can be
switched on with `AI_ENABLED=true` and off instantly from the admin bot. Output is schema-validated
to a closed set of intents; the model never sees prices or order status and never mutates anything.

**Rejected:** AI-first conversation (invents prices, costs money per message, fails on patchy data),
and LLM-based FAQ answering without curated data (hallucinated opening hours).

---

## DR-008 — Charts without native dependencies

**Chosen:** render analytics as **SVG built from a small template**, converted to PNG with
`@resvg/resvg-wasm` (pure WASM) so Telegram can display it. Fallback when WASM is unavailable:
send the numbers as a text table. Decided now so phase 5 does not reach for `canvas`/`sharp`, which
need native binaries.

---

## DR-009 — Telegram library: raw Bot API over `undici` fetch, no framework

**Chosen:** a thin typed client over the Telegram Bot API using Node's built-in `fetch`, with our own
rate limiter (30 msg/s global, 1 msg/s per chat, honours `retry_after`). Updates are normalised into
the channel-neutral `InboundEvent` by the adapter.

**Rejected:** grammY / Telegraf — good libraries, but they encourage business logic inside handlers
and bring their own middleware/session model, which fights the requirement that the core contain no
Telegram-specific logic and that WhatsApp plug into the same core.

---

## DR-010 — Error tracking and alerts

**Chosen:** Sentry (free tier is adequate at our volume and does not pause) via `@sentry/node`, plus
an **admin-chat alert channel**: critical errors, dead-lettered jobs and provider outages are posted
to a Telegram alerts chat. Uptime checks by an external free pinger against `/healthz`. Details and
prices in phase 8.

---

## DR-011 — In-process chat adapters call the core services directly

**Chosen:** the Telegram (and later WhatsApp) adapters run inside the same Node process as the
API and call the core services through the same `Actor`-scoped service layer the API routes
call. The internal HTTP API remains the only way for anything _outside_ the process (admin tools,
a future dashboard, jobs on another box) to reach business logic.

**Rejected:** having the adapter POST to its own HTTP API over loopback for every button tap.
It doubles serialisation and connection use on a small VM for no isolation gain — authorisation
is identical because both paths construct the same `Actor` and hit the same services.

**What this preserves:** no business logic in the adapter; every rule (IDOR, roles, stock,
payments) lives once, in `src/core`, and is exercised by both the API tests and the bot tests.

## Open items to verify later (tracked, not forgotten)

| Item                                     | Verify in | Why it is not decided now                              |
| ---------------------------------------- | --------- | ------------------------------------------------------ |
| Fly.io vs Railway exact monthly cost     | Phase 8   | Prices change; COSTS.md is the single place for them   |
| Paystack webhook source IPs              | Phase 4   | Must come from Paystack's current docs at build time   |
| Kwik Delivery API availability           | Phase 6   | Docs may be partner-gated; ManualDispatch is the floor |
| Google Geocoding price and free credit   | Phase 6/8 | Only matters if typed addresses are enabled            |
| WhatsApp limits (buttons, rows, lengths) | Phase 9   | Encoded as tested constants from Meta's current docs   |
