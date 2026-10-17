import { randomInt } from 'node:crypto';

/**
 * Human-facing references. Customers read these aloud on the phone, so the
 * alphabet drops look-alikes (0/O, 1/I/L) and the format stays short.
 * 5 characters from 31 symbols ≈ 28.6 million combinations — plenty for one
 * business, and the database UNIQUE constraint catches the rare collision
 * (callers retry on conflict).
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function token(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET.charAt(randomInt(ALPHABET.length));
  return out;
}

export const newOrderRef = (): string => `LL-${token(5)}`;
export const newTicketRef = (): string => `T-${token(4)}`;

/** Paystack reference for an order attempt — unique per attempt, traceable to the order. */
export const newPaymentReference = (orderRef: string, attempt: number): string =>
  `${orderRef}-${attempt}-${token(6)}`;

/** Short ids inside Telegram callback data and WhatsApp row ids (≤ 32 bytes total). */
export const newActionNonce = (): string => token(4);
