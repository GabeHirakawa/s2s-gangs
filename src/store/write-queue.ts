/**
 * One ordered, asynchronous persistence queue.
 *
 * Every cache mutation enqueues its database write here. Operations run strictly one at a time in
 * enqueue order (a promise chain), so a later write can never overtake an earlier one and a
 * per-player load enqueued after a write observes it. A failing operation is logged with its label
 * and the chain continues; nothing is ever thrown back into the (synchronous) caller.
 */
export type QueueOp = () => Promise<unknown>;

export class WriteQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private failures = 0;

  constructor(private readonly log: (message: string) => void = () => {}) {}

  /** Append `op`. Returns immediately; the op runs after every previously enqueued op settles. */
  enqueue(label: string, op: QueueOp): void {
    this.pending++;
    this.tail = this.tail
      .then(op)
      .then(
        () => undefined,
        (e: unknown) => {
          this.failures++;
          this.log(`[gangs] db write failed (${label}): ${String(e)}`);
        },
      )
      .finally(() => { this.pending--; });
  }

  /** Resolves once every op enqueued so far (and any they enqueue meanwhile) has settled. */
  async flush(): Promise<void> {
    while (this.pending > 0) await this.tail;
  }

  /** Ops enqueued but not yet settled. */
  get size(): number { return this.pending; }

  /** Ops that rejected since construction. */
  get failed(): number { return this.failures; }
}
