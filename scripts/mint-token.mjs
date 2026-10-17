#!/usr/bin/env node
// Mint an internal API token for manual testing (curl, Postman, the docs UI).
//   node scripts/mint-token.mjs system my-laptop
//   node scripts/mint-token.mjs staff <staffId> owner
//   node scripts/mint-token.mjs adapter telegram-customer     (then send X-Customer-Id per request)
// Reads INTERNAL_API_SECRET from .env. Tokens live 12 hours.
import 'dotenv/config';
import { createHmac } from 'node:crypto';

const secret = process.env.INTERNAL_API_SECRET;
if (!secret) throw new Error('INTERNAL_API_SECRET is not set');
const [kind, a, b] = process.argv.slice(2);
if (!['system', 'staff', 'adapter'].includes(kind))
  throw new Error('usage: mint-token.mjs <system|staff|adapter> ...');
const claims = {
  kind,
  client: kind === 'staff' ? 'manual' : (a ?? 'manual'),
  exp: Math.floor(Date.now() / 1000) + 12 * 3600,
};
if (kind === 'staff') Object.assign(claims, { staffId: a, staffRole: b ?? 'owner' });
const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
const sig = createHmac('sha256', secret).update(encoded).digest('base64url');
console.log(`${encoded}.${sig}`);
