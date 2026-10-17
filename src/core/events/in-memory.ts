import type { DomainEvent, EventBus, Tx } from '../ports/index.js';

/**
 * Event bus for tests and for the single-process dev mode. Events are buffered
 * per transaction and only handed to subscribers after the caller signals that
 * the transaction committed — otherwise a rolled-back checkout would still send
 * a "payment link" message. Phase 7 replaces this with pg-boss (same interface).
 */
export type EventHandler = (event: DomainEvent) => Promise<void> | void;

export class InMemoryEventBus implements EventBus {
  readonly published: DomainEvent[] = [];
  private readonly pending = new Map<Tx, DomainEvent[]>();
  private readonly handlers: EventHandler[] = [];

  subscribe(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  async publish(tx: Tx, event: DomainEvent): Promise<void> {
    const list = this.pending.get(tx) ?? [];
    list.push(event);
    this.pending.set(tx, list);
    return Promise.resolve();
  }

  /** Called by the unit of work after COMMIT. */
  async flush(tx: Tx): Promise<void> {
    const list = this.pending.get(tx) ?? [];
    this.pending.delete(tx);
    for (const event of list) {
      this.published.push(event);
      for (const h of this.handlers) await h(event);
    }
  }

  /** Called by the unit of work after ROLLBACK. */
  discard(tx: Tx): void {
    this.pending.delete(tx);
  }

  clear(): void {
    this.published.length = 0;
  }

  ofType<T extends DomainEvent['type']>(type: T): Extract<DomainEvent, { type: T }>[] {
    return this.published.filter((e): e is Extract<DomainEvent, { type: T }> => e.type === type);
  }
}
