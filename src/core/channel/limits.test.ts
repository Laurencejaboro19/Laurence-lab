import { describe, expect, it } from 'vitest';

import { outboundLimitViolations, paginatedList } from './limits.js';
import { CHANNEL_LIMITS, inboundEventKey, type ListRow } from './types.js';

const rows = (n: number): ListRow[] =>
  Array.from({ length: n }, (_, i) => ({ title: `Item ${i + 1}`, actionId: `item:${i + 1}` }));

describe('outboundLimitViolations', () => {
  it('accepts a well-formed buttons message', () => {
    expect(
      outboundLimitViolations({
        kind: 'buttons',
        body: { text: 'Delivery or pickup?' },
        choices: [
          { label: 'Delivery', actionId: 'fulfil:delivery' },
          { label: 'Pickup', actionId: 'fulfil:pickup' },
        ],
      }),
    ).toEqual([]);
  });

  it('flags labels longer than the WhatsApp reply-button limit', () => {
    const v = outboundLimitViolations({
      kind: 'buttons',
      body: { text: 'x' },
      choices: [{ label: 'A label that is far too long for WhatsApp', actionId: 'a' }],
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain(String(CHANNEL_LIMITS.maxChoiceLabelChars));
  });

  it('flags lists with more than 10 rows and empty lists', () => {
    const base = {
      kind: 'list' as const,
      body: { text: 'Menu' },
      openLabel: 'Open',
      page: 1,
      pageCount: 1,
    };
    expect(outboundLimitViolations({ ...base, rows: rows(11) })[0]).toMatch(/max 10/);
    expect(outboundLimitViolations({ ...base, rows: [] })[0]).toMatch(/no rows/);
  });

  it('requires https for URL buttons (the Paystack link)', () => {
    expect(
      outboundLimitViolations({
        kind: 'url_button',
        body: { text: 'Pay' },
        label: 'Pay ₦2,500',
        url: 'http://paystack.com/pay/x',
      }),
    ).toContain('url button must be https');
  });

  it('flags empty or oversized bodies', () => {
    expect(outboundLimitViolations({ kind: 'text', body: { text: '   ' } })).toContain(
      'body is empty',
    );
    const long = 'a'.repeat(CHANNEL_LIMITS.maxBodyChars + 1);
    expect(outboundLimitViolations({ kind: 'text', body: { text: long } })[0]).toMatch(/exceeds/);
  });
});

describe('paginatedList', () => {
  it('never emits more rows than the strictest platform allows', () => {
    const list = paginatedList({
      body: { text: 'Menu' },
      openLabel: 'Open',
      rows: rows(23),
      page: 1,
      baseActionId: 'menu',
    });
    expect(list.rows).toHaveLength(10);
    expect(list.pageCount).toBe(3);
    expect(list.nextActionId).toBe('menu:p2');
    expect(list.prevActionId).toBeUndefined();
    expect(outboundLimitViolations(list)).toEqual([]);
  });

  it('clamps out-of-range pages and sets prev/next correctly on the last page', () => {
    const list = paginatedList({
      body: { text: 'Menu' },
      openLabel: 'Open',
      rows: rows(23),
      page: 99,
      baseActionId: 'menu',
    });
    expect(list.page).toBe(3);
    expect(list.rows).toHaveLength(3);
    expect(list.nextActionId).toBeUndefined();
    expect(list.prevActionId).toBe('menu:p2');
  });

  it('handles a single short page without paging controls', () => {
    const list = paginatedList({
      body: { text: 'Menu' },
      openLabel: 'Open',
      rows: rows(4),
      page: 1,
      baseActionId: 'menu',
    });
    expect(list.pageCount).toBe(1);
    expect(list.nextActionId).toBeUndefined();
    expect(list.prevActionId).toBeUndefined();
  });
});

describe('inboundEventKey', () => {
  it('namespaces platform ids by channel so Telegram and WhatsApp ids cannot collide', () => {
    expect(inboundEventKey({ channel: 'telegram', platformEventId: '42' })).toBe('telegram:42');
    expect(inboundEventKey({ channel: 'whatsapp', platformEventId: '42' })).toBe('whatsapp:42');
  });
});
