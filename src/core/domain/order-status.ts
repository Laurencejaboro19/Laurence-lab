/**
 * The order lifecycle as data. Services never compare status strings ad hoc;
 * they call `assertTransition` and then apply the declared side effects.
 *
 * Reading guide
 *   TRANSITIONS[from][to] exists      → the move is legal …
 *     .actors                          → … for these actor types …
 *     .effects                         → … and these side effects must happen in the same unit of work.
 *   Anything not listed is illegal and raises INVALID_TRANSITION.
 *
 * A stale provider event (e.g. "delivered" arriving after the order was already
 * marked DELIVERED) is not an error for the caller: use `isNoOp` to detect and log it.
 */
import { DomainError } from './errors.js';

export const ORDER_STATUSES = [
  'PLACED',
  'AWAITING_PAYMENT',
  'PAID',
  'ACCEPTED',
  'PREPARING',
  'READY',
  'DISPATCHED',
  'DELIVERED',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export type ActorType = 'customer' | 'staff' | 'system' | 'provider';

/** What a transition obliges the service to do inside the same transaction. */
export type TransitionEffect =
  | 'reserve_stock'
  | 'commit_stock'
  | 'release_stock'
  | 'initialise_payment'
  | 'full_refund'
  | 'partial_refund'
  | 'create_delivery'
  | 'cancel_delivery'
  | 'notify_customer'
  | 'notify_kitchen'
  | 'notify_dispatch';

export interface TransitionRule {
  actors: readonly ActorType[];
  effects: readonly TransitionEffect[];
  /** True when the transition needs a reason string (rejections, cancellations, refunds). */
  requiresReason?: boolean;
}

type TransitionTable = Partial<Record<OrderStatus, Partial<Record<OrderStatus, TransitionRule>>>>;

export const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set([
  'DELIVERED',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
  'REFUNDED',
]);

/** Statuses from which a refund (full or partial) may be issued: money has been taken. */
const PAID_STATUSES: readonly OrderStatus[] = [
  'PAID',
  'ACCEPTED',
  'PREPARING',
  'READY',
  'DISPATCHED',
  'DELIVERED',
  'PARTIALLY_REFUNDED',
];

const STAFF_OR_SYSTEM: readonly ActorType[] = ['staff', 'system'];

export const TRANSITIONS: TransitionTable = {
  PLACED: {
    AWAITING_PAYMENT: {
      actors: ['system'],
      effects: ['reserve_stock', 'initialise_payment', 'notify_customer'],
    },
    // Stock may already be reserved by checkout tx1; release is a ledger-aware no-op otherwise.
    CANCELLED: { actors: ['customer', 'staff', 'system'], effects: ['release_stock'] },
  },
  AWAITING_PAYMENT: {
    PAID: { actors: ['system'], effects: ['commit_stock', 'notify_customer', 'notify_kitchen'] },
    EXPIRED: { actors: ['system'], effects: ['release_stock', 'notify_customer'] },
    CANCELLED: {
      actors: ['customer', 'staff', 'system'],
      effects: ['release_stock', 'notify_customer'],
    },
  },
  PAID: {
    ACCEPTED: { actors: ['staff'], effects: ['notify_customer'] },
    REJECTED: {
      actors: ['staff'],
      effects: ['release_stock', 'full_refund', 'notify_customer'],
      requiresReason: true,
    },
    CANCELLED: {
      actors: ['staff', 'customer'],
      effects: ['release_stock', 'full_refund', 'notify_customer', 'notify_kitchen'],
      requiresReason: true,
    },
  },
  ACCEPTED: {
    PREPARING: { actors: ['staff'], effects: ['notify_customer'] },
    CANCELLED: {
      actors: ['staff'],
      effects: ['full_refund', 'notify_customer', 'notify_kitchen'],
      requiresReason: true,
    },
  },
  PREPARING: {
    READY: {
      actors: ['staff'],
      effects: ['create_delivery', 'notify_customer', 'notify_dispatch'],
    },
    CANCELLED: {
      actors: ['staff'],
      effects: ['full_refund', 'notify_customer', 'notify_kitchen'],
      requiresReason: true,
    },
  },
  READY: {
    DISPATCHED: { actors: ['staff', 'provider'], effects: ['notify_customer'] },
    // Pickup orders go straight to DELIVERED when the customer collects.
    DELIVERED: { actors: ['staff'], effects: ['notify_customer'] },
    CANCELLED: {
      actors: ['staff'],
      effects: ['cancel_delivery', 'full_refund', 'notify_customer'],
      requiresReason: true,
    },
  },
  DISPATCHED: {
    DELIVERED: { actors: ['staff', 'provider'], effects: ['notify_customer'] },
    CANCELLED: {
      actors: ['staff'],
      effects: ['cancel_delivery', 'full_refund', 'notify_customer'],
      requiresReason: true,
    },
  },
  DELIVERED: {},
  PARTIALLY_REFUNDED: {},
};

// Refunds are allowed from every paid status; declare them in one place.
for (const from of PAID_STATUSES) {
  const row = (TRANSITIONS[from] ??= {});
  if (from !== 'PARTIALLY_REFUNDED') {
    row.PARTIALLY_REFUNDED = {
      actors: STAFF_OR_SYSTEM,
      effects: ['partial_refund', 'notify_customer'],
      requiresReason: true,
    };
  }
  row.REFUNDED = {
    actors: STAFF_OR_SYSTEM,
    effects: ['full_refund', 'notify_customer'],
    requiresReason: true,
  };
}

export function getRule(from: OrderStatus, to: OrderStatus): TransitionRule | undefined {
  return TRANSITIONS[from]?.[to];
}

export function canTransition(from: OrderStatus, to: OrderStatus, actor: ActorType): boolean {
  const rule = getRule(from, to);
  return rule?.actors.includes(actor) ?? false;
}

/** A repeated request for the state the order is already in. Callers log and continue. */
export function isNoOp(from: OrderStatus, to: OrderStatus): boolean {
  return from === to;
}

export function assertTransition(
  from: OrderStatus,
  to: OrderStatus,
  actor: ActorType,
  reason?: string,
): TransitionRule {
  const rule = getRule(from, to);
  if (!rule) {
    throw new DomainError('INVALID_TRANSITION', `cannot move order from ${from} to ${to}`, {
      from,
      to,
    });
  }
  if (!rule.actors.includes(actor)) {
    throw new DomainError('FORBIDDEN', `${actor} may not move order from ${from} to ${to}`, {
      from,
      to,
      actor,
    });
  }
  if (rule.requiresReason && (reason?.trim() ?? '') === '') {
    throw new DomainError('VALIDATION', `a reason is required to move order from ${from} to ${to}`);
  }
  return rule;
}

/** Statuses a customer can still cancel from without staff involvement. */
export function customerCanCancel(status: OrderStatus): boolean {
  return canTransition(status, 'CANCELLED', 'customer');
}

/** Human labels for messages. Pidgin variants live with the conversation copy. */
export const STATUS_LABEL_EN: Record<OrderStatus, string> = {
  PLACED: 'Placed',
  AWAITING_PAYMENT: 'Awaiting payment',
  PAID: 'Paid — waiting for the kitchen',
  ACCEPTED: 'Accepted by the kitchen',
  PREPARING: 'Being prepared',
  READY: 'Ready',
  DISPATCHED: 'On the way',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired (not paid in time)',
  REFUNDED: 'Refunded',
  PARTIALLY_REFUNDED: 'Partially refunded',
};
