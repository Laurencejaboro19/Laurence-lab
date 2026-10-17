import { describe, expect, it } from 'vitest';

import {
  ORDER_STATUSES,
  TERMINAL_STATUSES,
  assertTransition,
  canTransition,
  customerCanCancel,
  getRule,
  type ActorType,
  type OrderStatus,
} from './order-status.js';

const ACTORS: ActorType[] = ['customer', 'staff', 'system', 'provider'];

/**
 * The legal moves, written out by hand from docs/ARCHITECTURE.md §4.4. The test
 * below checks the FULL 13×13×4 matrix against this list, so adding a transition
 * in code without updating the design doc (or vice versa) fails loudly.
 */
const EXPECTED: [OrderStatus, OrderStatus, ActorType[]][] = [
  ['PLACED', 'AWAITING_PAYMENT', ['system']],
  ['PLACED', 'CANCELLED', ['customer', 'staff', 'system']],
  ['AWAITING_PAYMENT', 'PAID', ['system']],
  ['AWAITING_PAYMENT', 'EXPIRED', ['system']],
  ['AWAITING_PAYMENT', 'CANCELLED', ['customer', 'staff', 'system']],
  ['PAID', 'ACCEPTED', ['staff']],
  ['PAID', 'REJECTED', ['staff']],
  ['PAID', 'CANCELLED', ['staff', 'customer']],
  ['ACCEPTED', 'PREPARING', ['staff']],
  ['ACCEPTED', 'CANCELLED', ['staff']],
  ['PREPARING', 'READY', ['staff']],
  ['PREPARING', 'CANCELLED', ['staff']],
  ['READY', 'DISPATCHED', ['staff', 'provider']],
  ['READY', 'DELIVERED', ['staff']],
  ['READY', 'CANCELLED', ['staff']],
  ['DISPATCHED', 'DELIVERED', ['staff', 'provider']],
  ['DISPATCHED', 'CANCELLED', ['staff']],
  // refunds from every paid status
  ...(
    ['PAID', 'ACCEPTED', 'PREPARING', 'READY', 'DISPATCHED', 'DELIVERED'] as OrderStatus[]
  ).flatMap((s): [OrderStatus, OrderStatus, ActorType[]][] => [
    [s, 'PARTIALLY_REFUNDED', ['staff', 'system']],
    [s, 'REFUNDED', ['staff', 'system']],
  ]),
  ['PARTIALLY_REFUNDED', 'REFUNDED', ['staff', 'system']],
];

describe('order state machine — full matrix', () => {
  const allowed = new Map<string, Set<ActorType>>();
  for (const [from, to, actors] of EXPECTED) allowed.set(`${from}>${to}`, new Set(actors));

  for (const from of ORDER_STATUSES) {
    for (const to of ORDER_STATUSES) {
      for (const actor of ACTORS) {
        const expected = allowed.get(`${from}>${to}`)?.has(actor) ?? false;
        it(`${from} → ${to} by ${actor}: ${expected ? 'allowed' : 'rejected'}`, () => {
          expect(canTransition(from, to, actor)).toBe(expected);
        });
      }
    }
  }

  it('has exactly the expected number of legal (from, to) pairs', () => {
    let count = 0;
    for (const from of ORDER_STATUSES)
      for (const to of ORDER_STATUSES) if (getRule(from, to)) count++;
    expect(count).toBe(EXPECTED.length);
  });

  it('no transition leaves a terminal status except DELIVERED → refunds', () => {
    for (const from of TERMINAL_STATUSES) {
      for (const to of ORDER_STATUSES) {
        const rule = getRule(from, to);
        if (from === 'DELIVERED') {
          expect(rule === undefined || to === 'REFUNDED' || to === 'PARTIALLY_REFUNDED').toBe(true);
        } else {
          expect(rule, `${from} → ${to}`).toBeUndefined();
        }
      }
    }
  });
});

describe('assertTransition', () => {
  it('returns the rule with its effects for a legal move', () => {
    const rule = assertTransition('AWAITING_PAYMENT', 'PAID', 'system');
    expect(rule.effects).toContain('commit_stock');
    expect(rule.effects).toContain('notify_kitchen');
  });

  it('rejects illegal moves with INVALID_TRANSITION', () => {
    expect(() => assertTransition('PLACED', 'DELIVERED', 'staff')).toThrow(
      expect.objectContaining({ code: 'INVALID_TRANSITION' }),
    );
  });

  it('rejects the wrong actor with FORBIDDEN', () => {
    expect(() => assertTransition('AWAITING_PAYMENT', 'PAID', 'customer')).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });

  it('requires a reason for rejections, cancellations after payment, and refunds', () => {
    expect(() => assertTransition('PAID', 'REJECTED', 'staff')).toThrow(/reason is required/);
    expect(() => assertTransition('PAID', 'REJECTED', 'staff', 'out of chicken')).not.toThrow();
    expect(() => assertTransition('DELIVERED', 'REFUNDED', 'staff', '')).toThrow(/reason/);
  });

  it('stock side effects are symmetric: every reserve path has a release or commit', () => {
    const reserve = assertTransition('PLACED', 'AWAITING_PAYMENT', 'system').effects;
    expect(reserve).toContain('reserve_stock');
    expect(assertTransition('AWAITING_PAYMENT', 'PAID', 'system').effects).toContain(
      'commit_stock',
    );
    expect(assertTransition('AWAITING_PAYMENT', 'EXPIRED', 'system').effects).toContain(
      'release_stock',
    );
    expect(assertTransition('AWAITING_PAYMENT', 'CANCELLED', 'customer').effects).toContain(
      'release_stock',
    );
    expect(assertTransition('PAID', 'REJECTED', 'staff', 'x').effects).toContain('release_stock');
  });
});

describe('customerCanCancel', () => {
  it('lets customers cancel before and during payment, and right after paying', () => {
    expect(customerCanCancel('PLACED')).toBe(true);
    expect(customerCanCancel('AWAITING_PAYMENT')).toBe(true);
    expect(customerCanCancel('PAID')).toBe(true);
    expect(customerCanCancel('ACCEPTED')).toBe(false);
    expect(customerCanCancel('DISPATCHED')).toBe(false);
  });
});
