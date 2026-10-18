// Prints the key for the /setup/* routes of a deployment, derived from INTERNAL_API_SECRET.
import 'dotenv/config';
import { createHash } from 'node:crypto';
const secret = process.env.INTERNAL_API_SECRET;
if (!secret) throw new Error('INTERNAL_API_SECRET is not set');
console.log(createHash('sha256').update(`setup:${secret}`).digest('base64url').slice(0, 32));
