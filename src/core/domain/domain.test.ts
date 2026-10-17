import { describe, expect, it } from 'vitest';

import { distanceMetres, findZone, pointInPolygon, type GeoJsonPolygon } from './geo.js';
import { newOrderRef, newPaymentReference } from './ids.js';
import { add, formatNaira, kobo, multiply, parseNaira, percentOf, subtract } from './money.js';
import { parseOrderText } from './order-parser.js';
import { computeTotals, promoDiscount } from './pricing.js';

describe('money', () => {
  it('brands integers and rejects floats, negatives and garbage', () => {
    expect(kobo(150000)).toBe(150000);
    expect(kobo('150000')).toBe(150000); // pg bigint arrives as a string
    expect(() => kobo(1.5)).toThrow(/integer/);
    expect(() => kobo(-1)).toThrow(/negative/);
    expect(() => kobo('abc')).toThrow(/integer/);
    expect(() => kobo(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });

  it('does arithmetic without ever producing a fraction', () => {
    expect(add(kobo(100), kobo(250))).toBe(350);
    expect(subtract(kobo(500), kobo(200))).toBe(300);
    expect(() => subtract(kobo(100), kobo(200))).toThrow(/negative/);
    expect(multiply(kobo(333), 3)).toBe(999);
    expect(percentOf(kobo(999), 10)).toBe(99); // floor, never 99.9
    expect(percentOf(kobo(1), 50)).toBe(0);
  });

  it('formats and parses naira', () => {
    expect(formatNaira(kobo(150000))).toBe('₦1,500');
    expect(formatNaira(kobo(150050))).toBe('₦1,500.50');
    expect(formatNaira(kobo(5))).toBe('₦0.05');
    expect(parseNaira('₦1,500')).toBe(150000);
    expect(parseNaira('1500.5')).toBe(150050);
    expect(() => parseNaira('1,5,0,0.123')).toThrow();
  });
});

describe('pricing', () => {
  const jollof = {
    itemId: 'a',
    name: 'Jollof',
    unitPriceKobo: kobo(150000),
    addons: [],
    quantity: 2,
  };
  const chicken = {
    itemId: 'b',
    name: 'Chicken',
    unitPriceKobo: kobo(250000),
    addons: [{ name: 'Extra pepper', priceKobo: kobo(10000) }],
    quantity: 1,
  };

  it('computes subtotal, fee and total with no promo', () => {
    const t = computeTotals([jollof, chicken], kobo(50000));
    expect(t.subtotalKobo).toBe(300000 + 260000);
    expect(t.discountKobo).toBe(0);
    expect(t.totalKobo).toBe(560000 + 50000);
    expect(t.lines[1]!.lineTotalKobo).toBe(260000);
  });

  it('applies percent promos to food only, capped, floored', () => {
    const t = computeTotals([jollof], kobo(50000), {
      code: 'TEN',
      kind: 'percent',
      value: 10,
      minOrderKobo: kobo(0),
      maxDiscountKobo: kobo(20000),
    });
    expect(t.discountKobo).toBe(20000); // 10% of 300000 = 30000, capped at 20000
    expect(t.totalKobo).toBe(300000 - 20000 + 50000);
  });

  it('never discounts below zero and enforces the promo minimum', () => {
    expect(
      promoDiscount(kobo(1000), { code: 'BIG', kind: 'fixed', value: 5000, minOrderKobo: kobo(0) }),
    ).toBe(1000);
    expect(() =>
      promoDiscount(kobo(1000), {
        code: 'MIN',
        kind: 'fixed',
        value: 500,
        minOrderKobo: kobo(2000),
      }),
    ).toThrow(expect.objectContaining({ code: 'PROMO_INVALID' }));
  });

  it('refuses an empty order', () => {
    expect(() => computeTotals([], kobo(0))).toThrow(/no lines/);
  });
});

describe('geo', () => {
  const square: GeoJsonPolygon = {
    type: 'Polygon',
    coordinates: [
      [
        [5.6, 6.3],
        [5.7, 6.3],
        [5.7, 6.4],
        [5.6, 6.4],
        [5.6, 6.3],
      ],
    ],
  };
  it('detects inside, outside and edge-adjacent points', () => {
    expect(pointInPolygon({ latitude: 6.35, longitude: 5.65 }, square)).toBe(true);
    expect(pointInPolygon({ latitude: 6.45, longitude: 5.65 }, square)).toBe(false);
    expect(pointInPolygon({ latitude: 6.35, longitude: 5.75 }, square)).toBe(false);
  });
  it('respects holes and picks the first matching zone', () => {
    const withHole: GeoJsonPolygon = {
      type: 'Polygon',
      coordinates: [
        square.coordinates[0]!,
        [
          [5.64, 6.34],
          [5.66, 6.34],
          [5.66, 6.36],
          [5.64, 6.36],
          [5.64, 6.34],
        ],
      ],
    };
    expect(pointInPolygon({ latitude: 6.35, longitude: 5.65 }, withHole)).toBe(false);
    const zones = [
      { id: 'hole', name: 'H', polygon: withHole },
      { id: 'full', name: 'F', polygon: square },
    ];
    expect(findZone({ latitude: 6.35, longitude: 5.65 }, zones)?.id).toBe('full');
    expect(findZone({ latitude: 6.31, longitude: 5.61 }, zones)?.id).toBe('hole');
  });
  it('measures distance roughly (UNIBEN main gate to Ring Road ≈ 7–8 km)', () => {
    const d = distanceMetres(
      { latitude: 6.397, longitude: 5.615 },
      { latitude: 6.335, longitude: 5.627 },
    );
    expect(d).toBeGreaterThan(6500);
    expect(d).toBeLessThan(8500);
  });
});

describe('ids', () => {
  it('produces readable references without ambiguous characters', () => {
    for (let i = 0; i < 200; i++) {
      expect(newOrderRef()).toMatch(/^LL-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/);
    }
    expect(newPaymentReference('LL-ABCDE', 2)).toMatch(/^LL-ABCDE-2-[2-9A-Z]{6}$/);
  });
});

describe('order text parser', () => {
  const MENU = [
    { slug: 'jollof-rice', name: 'Jollof Rice', aliases: ['jollof', 'jellof'] },
    { slug: 'fried-rice', name: 'Fried Rice', aliases: ['fried rice', 'fried'] },
    {
      slug: 'white-rice-stew',
      name: 'White Rice & Stew',
      aliases: ['white rice', 'rice and stew'],
    },
    { slug: 'chicken', name: 'Chicken', aliases: ['chicken', 'chiken'] },
    { slug: 'chivita', name: 'Chivita Juice (1L)', aliases: ['chivita', 'juice'] },
    { slug: 'fried-plantain', name: 'Fried Plantain', aliases: ['plantain', 'dodo'] },
    { slug: 'bottled-water', name: 'Bottled Water', aliases: ['water', 'bottle water'] },
  ];

  it('parses the screenshot order exactly', () => {
    const r = parseOrderText(
      'Id like to order 4 portions of jollof, 1 chicken, 1 chivita, 2 portions of plantain and bottle water',
      MENU,
    );
    expect(r.unmatched).toEqual([]);
    expect(r.lines.map((l) => [l.slug, l.quantity])).toEqual([
      ['jollof-rice', 4],
      ['chicken', 1],
      ['chivita', 1],
      ['fried-plantain', 2],
      ['bottled-water', 1],
    ]);
  });

  it('prefers the longest alias so "fried rice" is not "rice"', () => {
    const r = parseOrderText('two fried rice and one white rice', MENU);
    expect(r.lines.map((l) => [l.slug, l.quantity])).toEqual([
      ['fried-rice', 2],
      ['white-rice-stew', 1],
    ]);
  });

  it('handles Pidgin and number words, merges repeats, caps quantities', () => {
    const r = parseOrderText('abeg make i get three dodo, 2 dodo and 99 chiken', MENU);
    expect(r.lines).toEqual([
      expect.objectContaining({ slug: 'fried-plantain', quantity: 5 }),
      expect.objectContaining({ slug: 'chicken', quantity: 50 }),
    ]);
  });

  it('reports what it could not match instead of guessing', () => {
    const r = parseOrderText('1 jollof and a pot of egusi', MENU);
    expect(r.lines.map((l) => l.slug)).toEqual(['jollof-rice']);
    expect(r.unmatched).toEqual(['a pot egusi']);
  });

  it('returns nothing for chit-chat', () => {
    expect(parseOrderText('hello, are you open?', MENU).lines).toEqual([]);
  });
});
