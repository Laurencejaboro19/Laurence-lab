/**
 * Money is an integer number of kobo. Never a float, never a string with a
 * decimal point. ₦1 = 100 kobo.
 *
 * We use `number`, not `bigint`: JavaScript numbers are exact integers up to
 * 2^53 ≈ 9×10^15 kobo ≈ ₦90 trillion, far beyond any order. pg returns bigint
 * columns as strings, so repositories pass them through `kobo()` at the edge.
 */

/** Branded type so a plain number cannot be passed where kobo is expected by accident. */
export type Kobo = number & { readonly __brand: 'Kobo' };

export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

/** Validate and brand. Accepts the string form pg returns for bigint. */
export function kobo(value: number | string | bigint): Kobo {
  const n =
    typeof value === 'string' ? Number(value) : typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(n))
    throw new MoneyError(`not an integer kobo amount: ${String(value)}`);
  if (n < 0) throw new MoneyError(`negative kobo amount: ${n}`);
  return n as Kobo;
}

export const ZERO: Kobo = 0 as Kobo;

export function add(...amounts: Kobo[]): Kobo {
  return kobo(amounts.reduce<number>((acc, a) => acc + a, 0));
}

export function subtract(a: Kobo, b: Kobo): Kobo {
  if (b > a) throw new MoneyError(`subtraction would go negative: ${a} - ${b}`);
  return kobo(a - b);
}

export function multiply(amount: Kobo, quantity: number): Kobo {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new MoneyError(`quantity must be a non-negative integer: ${quantity}`);
  }
  return kobo(amount * quantity);
}

/**
 * Percentage of an amount, rounded DOWN to the kobo (the customer is never
 * charged a fraction up; the business absorbs the rounding).
 */
export function percentOf(amount: Kobo, percent: number): Kobo {
  if (percent < 0 || percent > 100) throw new MoneyError(`percent out of range: ${percent}`);
  return kobo(Math.floor((amount * percent) / 100));
}

export function min(a: Kobo, b: Kobo): Kobo {
  return a < b ? a : b;
}

/** ₦1,234.50 style formatting for messages. Kobo part shown only when non-zero. */
export function formatNaira(amount: Kobo): string {
  const nairaPart = Math.floor(amount / 100);
  const koboPart = amount % 100;
  const grouped = nairaPart.toLocaleString('en-NG');
  return koboPart === 0 ? `₦${grouped}` : `₦${grouped}.${String(koboPart).padStart(2, '0')}`;
}

/** Parse "₦1,500", "1500", "1,500.50" from staff input into kobo. */
export function parseNaira(input: string): Kobo {
  const cleaned = input.replace(/[₦,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) throw new MoneyError(`cannot parse amount: ${input}`);
  const [whole, frac = ''] = cleaned.split('.');
  return kobo(Number(whole) * 100 + Number(frac.padEnd(2, '0')));
}
