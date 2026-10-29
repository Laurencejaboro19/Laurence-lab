# Laurence Lab — mobile app

Native customer app (iOS + Android, plus a web build used as the live demo) for the
Laurence Lab food-ordering platform. Built with Expo / React Native and Expo Router. It
talks to the bot server's mobile API (`/app/v1`, see `src/http/routes/app/v1` at the repo
root), which shares the Supabase database, menu, zones, Paystack payments and the admin bot
with the Telegram channel.

```
app/            screens (file-based routes)
  welcome.tsx     name + phone → per-install session
  (tabs)/         Menu · Cart · Orders · Account
  item/[id]       size, extras, quantity
  cart.tsx        quantities, totals
  checkout.tsx    delivery/pickup, address, note, promo → Paystack
  address/new     GPS pin (zone resolved server-side) or pick an area
  orders/[id]     live status timeline, pay-now, cancel
src/api/        typed HTTP client (live) — src/demo is the offline twin
src/state/      AppProvider: session, menu, cart quote, live/demo switch
src/ui/         theme + components
```

**Demo mode.** If the server cannot be reached (or cannot serve app sessions yet), the app
switches to a built-in simulation with the same menu, a fake kitchen that moves orders
through every status, and promo codes `WELCOME10` / `LAB500`. A ribbon at the top says so.
Force it from Account → Demo mode.

## Run it on your phone (no store needed)

```powershell
cd "$env:USERPROFILE\Laurence-lab\mobile"
npm ci
npx expo start --tunnel
```

Scan the QR code with **Expo Go** (Android: Play Store · iPhone: App Store). The web demo
is `npx expo export -p web` → `dist/`, deployed by Vercel from this folder.

## Ship to the stores

One-time: an [Expo account](https://expo.dev) (free), a Google Play Console account
($25 once) and an Apple Developer account ($99/year).

```powershell
cd "$env:USERPROFILE\Laurence-lab\mobile"
npm install -g eas-cli
eas login
eas init                      # fills extra.eas.projectId in app.json — commit that
eas build --platform android --profile production   # .aab for Play
eas build --platform ios --profile production       # .ipa for App Store (Apple account needed)
eas submit --platform android --latest
eas submit --platform ios --latest
```

`eas build --profile preview --platform android` makes an installable `.apk` for testers.

Before the first store build: replace the placeholder icons in `assets/` (1024×1024 icon,
adaptive-icon foreground, splash), and set `PUBLIC_BASE_URL`/`PAYSTACK_PUBLIC_KEY` on the
server if the API ever moves.

## Server requirements

The server must be on a commit that includes the `/app/v1` routes **and** have migration
`0009_app_channel.sql` applied (`/setup/migrate?key=…`, see `docs/DEPLOY_VERCEL.md`).
The API base URL is `extra.apiBaseUrl` in `app.json`, overridable with
`EXPO_PUBLIC_API_BASE_URL`.
