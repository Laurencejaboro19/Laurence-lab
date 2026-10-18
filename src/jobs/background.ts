/**
 * Minimal background runner used until pg-boss arrives in phase 7. Work is
 * kicked off after the HTTP response is sent; failures are logged, never thrown
 * into the request. Durability comes from the database row written BEFORE the
 * 200 (payment_events / inbound_events) plus the replay sweeps, not from this
 * class — if the process dies mid-task, the sweep finishes the job.
 */
export interface Logger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export class BackgroundRunner {
  private inFlight = 0;
  private draining = false;

  constructor(private readonly log: Logger) {}

  /** Fire and forget, with structured error logging. */
  run(name: string, task: () => Promise<unknown>): void {
    if (this.draining) {
      this.log.warn({ task: name }, 'background task refused: draining');
      return;
    }
    this.inFlight++;
    setImmediate(() => {
      task()
        .then((result) => {
          this.log.info({ task: name, result }, 'background task done');
        })
        .catch((err: unknown) => {
          this.log.error({ task: name, err }, 'background task failed');
        })
        .finally(() => {
          this.inFlight--;
        });
    });
  }

  /** Graceful shutdown: stop accepting and wait (bounded) for in-flight tasks. */
  async drain(timeoutMs = 10_000): Promise<void> {
    this.draining = true;
    const start = Date.now();
    while (this.inFlight > 0 && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  get pending(): number {
    return this.inFlight;
  }
}
