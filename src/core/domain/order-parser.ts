/**
 * Deterministic plain-text order parser. No AI, no network, no cost.
 *
 *   "I'd like 4 portions of jollof, 1 chicken, 1 chivita, 2 plantain and bottle water"
 *   → [{slug:'jollof-rice',qty:4},{slug:'chicken',qty:1},{slug:'chivita',qty:1},
 *      {slug:'fried-plantain',qty:2},{slug:'bottled-water',qty:1}]
 *
 * Strategy: split on commas / "and" / "with" / newlines, then in each chunk find
 * the longest alias match (so "fried rice" beats "rice") and the nearest number.
 * Number words (one…ten, Pidgin "two two" doubles are left alone) are supported.
 * Anything unmatched is returned so the conversation can ask about it. This is
 * also the fallback when the optional AI parser is disabled or down.
 */
export interface ParsableItem {
  slug: string;
  name: string;
  aliases: readonly string[];
}

export interface ParsedLine {
  slug: string;
  quantity: number;
  /** The text chunk it came from, for the confirmation message. */
  source: string;
}

export interface ParseResult {
  lines: ParsedLine[];
  unmatched: string[];
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  dozen: 12,
  half: 1,
};

const FILLER =
  /\b(i'?d like|i want|i wan|abeg|please|pls|make i get|give me|gimme|send me|can i (?:get|have)|order|portions?|plates?|packs?|pieces?|bottles?|of|the|some)\b/g;

const MAX_QTY = 50;

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s,&+-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function quantityIn(chunk: string): number | undefined {
  const digits = /(\d{1,3})\s*x?\b/.exec(chunk) ?? /\bx\s*(\d{1,3})\b/.exec(chunk);
  if (digits?.[1]) return Math.min(MAX_QTY, Math.max(1, Number(digits[1])));
  for (const word of chunk.split(' ')) {
    const n = NUMBER_WORDS[word];
    if (n !== undefined) return n;
  }
  return undefined;
}

export function parseOrderText(text: string, items: readonly ParsableItem[]): ParseResult {
  const candidates = items
    .flatMap((item) =>
      [item.name, ...item.aliases].map((alias) => ({ alias: normalise(alias), slug: item.slug })),
    )
    .filter((c) => c.alias.length > 0)
    // Longest alias first so "fried rice" wins over "rice".
    .sort((a, b) => b.alias.length - a.alias.length);

  const chunks = normalise(text)
    .split(/,|\band\b|\bwith\b|\bplus\b|&|\+|\n/)
    .map((c) => c.replace(FILLER, ' ').replace(/\s+/g, ' ').trim())
    .filter((c) => c.length > 0);

  const lines: ParsedLine[] = [];
  const unmatched: string[] = [];

  for (const chunk of chunks) {
    let rest = ` ${chunk} `;
    let matchedAny = false;
    const qty = quantityIn(chunk) ?? 1;
    // A chunk can mention two items without a separator ("jollof chicken"); loop.
    for (const c of candidates) {
      const needle = ` ${c.alias} `;
      if (rest.includes(needle)) {
        rest = rest.replace(needle, ' ');
        const existing = lines.find((l) => l.slug === c.slug);
        if (existing) existing.quantity = Math.min(MAX_QTY, existing.quantity + qty);
        else lines.push({ slug: c.slug, quantity: qty, source: chunk });
        matchedAny = true;
      }
    }
    if (!matchedAny) {
      const leftover = rest.replace(/\b\d+\b/g, '').trim();
      if (leftover.length > 1) unmatched.push(chunk);
    }
  }
  return { lines, unmatched };
}
