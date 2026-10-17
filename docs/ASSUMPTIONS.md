# Assumptions

Every value the builder accepted as a default, or did not know, is recorded here with the date.
All of these are **settings or seed data**, changeable by the owner through the admin bot without a
deploy, unless marked otherwise. When the owner confirms or corrects a value, update the line and keep
the history.

| #   | Item                       | Value in use                                                                                                                                                                 | Source                             | Date       |
| --- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------- |
| 1   | Business name              | **Laurence Lab Bot** (brand shown to customers: "Laurence Lab")                                                                                                              | Builder, explicit                  | 2026-10-17 |
| 2   | GitHub repository          | `Laurencejaboro19/Laurence-lab`, new `main` branch; the earlier Python prototype stays on its own branch. **Owner action:** set `main` as default branch, make repo private. | Builder, explicit                  | 2026-10-17 |
| 3   | City and delivery areas    | Benin City, Edo State: Ugbowo, Ekosodin, Uselu, GRA, Ring Road, Sapele Road                                                                                                  | Default accepted                   | 2026-10-17 |
| 4   | Cuisine and sample menu    | Nigerian: jollof rice, fried rice, chicken, fried plantain, moi-moi, Chivita juice, bottled water (seed data only)                                                           | Default accepted                   | 2026-10-17 |
| 5   | Opening hours              | 09:00–21:00 daily, Africa/Lagos                                                                                                                                              | Default accepted                   | 2026-10-17 |
| 6   | Zones, fees, minimum order | Zone A ₦500, Zone B ₦1,000; minimum order ₦2,000                                                                                                                             | Default accepted                   | 2026-10-17 |
| 7   | Average prep time          | 25 minutes                                                                                                                                                                   | Default accepted                   | 2026-10-17 |
| 8   | Staff and roles            | Builder's Telegram user id as `owner`; others added later via admin bot. **Needed before phase 5.**                                                                          | Default accepted; id not yet given | 2026-10-17 |
| 9   | Refund policy              | Full refund if cancelled before ACCEPTED or if the business rejects / fails delivery; after DISPATCHED only for wrong or missing items; refunds via Paystack to source       | Default accepted                   | 2026-10-17 |
| 10  | Support hours              | Same as opening hours                                                                                                                                                        | Default accepted                   | 2026-10-17 |
| 11  | Pilot daily order cap      | 50                                                                                                                                                                           | Default accepted                   | 2026-10-17 |
| 12  | Domain name                | None; host-provided subdomain                                                                                                                                                | Default accepted                   | 2026-10-17 |
| 13  | Third-party accounts       | None exist yet (Paystack, Kwik, Meta Business, Supabase). Test keys and mocks throughout. **Owner should start Meta business verification now** — it takes weeks.            | Default accepted                   | 2026-10-17 |
| 14  | Brand tone, logo, photos   | Friendly English with Pidgin option; no logo or menu photos yet                                                                                                              | Default accepted                   | 2026-10-17 |
| 15  | Telegram bot tokens        | Not yet created. **Needed before phase 4** (customer + admin test bots from @BotFather).                                                                                     | Deferred                           | 2026-10-17 |
| 16  | Builder and owner          | The builder (Laurence Jaboro) is treated as the owner unless told otherwise; the repository is under his account.                                                            | Inferred from the repo instruction | 2026-10-17 |

## Technical assumptions (not business settings)

- Node.js 22 is the minimum; 24 LTS is recommended for production. The CI and `.nvmrc` use 22 so
  that Termux's `nodejs-lts` package works.
- Local development uses a plain PostgreSQL 16 install. The Supabase CLI local stack (Docker) is not
  used anywhere.
- Money is stored as integer **kobo** (`bigint`), never floats. ₦2,000 is stored as `200000`.
- All timestamps are stored as `timestamptz` in UTC and formatted in `Africa/Lagos` only at the edge.
