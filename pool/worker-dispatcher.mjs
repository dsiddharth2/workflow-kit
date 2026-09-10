// pool/worker-dispatcher.mjs

// Beats the 60s first-response-byte timer immediately, then the 5-minute idle
// timer every 30s. See docs/mcp-interface.md for the timer inventory.
export const HEARTBEAT_MS = 30000;

export class DispatchOverflowError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DispatchOverflowError';
  }
}

// Tries pool -> ephemeral -> queue -> reject. Owns the one queue shared by both
// tiers; a release from either tier wakes the head of the queue.
export class WorkerDispatcher {
  #pool;
  #ephemeral;
  #config;
  #waiters = [];
  #servicing = false;
  #rerun = false;
  #closed = false;
  #unsubscribe = [];

  constructor({ pool = null, ephemeral = null, config } = {}) {
    if (!pool && !ephemeral) {
      throw new Error(
        'no workers configured — set WORKER_POOL_SIZE > 0, WORKER_EPHEMERAL_MAX > 0, or both',
      );
    }
    if (!config) throw new Error('WorkerDispatcher requires config');
    this.#pool = pool;
    this.#ephemeral = ephemeral;
    this.#config = config;
    if (pool) this.#unsubscribe.push(pool.onRelease(() => void this.#serviceWaiters()));
    if (ephemeral) this.#unsubscribe.push(ephemeral.onRelease(() => void this.#serviceWaiters()));
  }

  get capacity() {
    return (this.#pool?.size ?? 0) + (this.#ephemeral?.maxConcurrent ?? 0);
  }

  get queued() {
    return this.#waiters.length;
  }

  async dispatch({ signal, reportPhase } = {}) {
    if (this.#closed) throw new Error('WorkerDispatcher is closed');
    signal?.throwIfAborted();

    // Waiters already in line are the only consumers of freed capacity. A
    // newcomer that #tryTiers here would steal a just-released worker.
    if (this.#waiters.length === 0) {
      const lease = await this.#tryTiers(signal);
      if (lease && this.#waiters.length === 0) return lease;
      if (lease) await lease.release();
    }

    if (this.#waiters.length >= this.#config.maxQueueSize) {
      throw new DispatchOverflowError(
        `all ${this.capacity} workers busy and the queue is full (${this.#config.maxQueueSize}); retry later`,
      );
    }
    return this.#enqueue({ signal, reportPhase });
  }

  // Pool first: zero registration cost. Ephemeral second: pays registration
  // but still serves. A failing ephemeral tier is treated as "no capacity",
  // never surfaced to the caller as a registration error.
  async #tryTiers(signal) {
    if (this.#pool) {
      const lease = await this.#pool.tryAcquireNow(signal);
      if (lease) return lease;
    }
    if (this.#ephemeral) {
      try {
        const lease = await this.#ephemeral.create({ signal });
        if (lease) return lease;
      } catch (err) {
        console.warn(`[dispatcher] ephemeral worker creation failed: ${err?.message ?? err}`);
      }
    }
    return null;
  }

  #enqueue({ signal, reportPhase }) {
    return new Promise((resolve, reject) => {
      const waiter = { signal, settled: false };
      this.#waiters.push(waiter);

      const settle = (done, value) => {
        if (waiter.settled) return;
        waiter.settled = true;
        clearInterval(heartbeat);
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        done(value);
      };
      waiter.grant = (lease) => settle(resolve, lease);
      waiter.fail = (err) => settle(reject, err);

      const announce = () => {
        const position = this.#waiters.indexOf(waiter) + 1;
        Promise.resolve(
          reportPhase?.(`queued for a worker: position ${position}, capacity ${this.capacity}`),
        ).catch(() => {});
      };
      announce();
      const heartbeat = setInterval(announce, HEARTBEAT_MS);
      heartbeat.unref?.();

      // Referenced on purpose: a queued dispatch is real work and must be able
      // to reject even if nothing else keeps the event loop alive.
      const timeout = setTimeout(
        () =>
          settle(
            reject,
            new DispatchOverflowError(
              `all ${this.capacity} workers busy after ${this.#config.queueTimeoutMs}ms; retry later`,
            ),
          ),
        this.#config.queueTimeoutMs,
      );

      const onAbort = () => settle(reject, signal.reason ?? new Error('dispatch aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  // FIFO. Guarded against re-entry; a release that lands mid-pass sets #rerun
  // so the freed capacity is not missed.
  async #serviceWaiters() {
    if (this.#servicing) {
      this.#rerun = true;
      return;
    }
    this.#servicing = true;
    try {
      do {
        this.#rerun = false;
        while (this.#waiters.length > 0) {
          const waiter = this.#waiters[0];
          if (waiter.settled) {
            this.#waiters.shift();
            continue;
          }
          const lease = await this.#tryTiers(waiter.signal);
          if (!lease) break;
          if (waiter.settled) {
            await lease.release();
            continue;
          }
          waiter.grant(lease);
        }
      } while (this.#rerun);
    } finally {
      this.#servicing = false;
    }
  }

  async close() {
    this.#closed = true;
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    for (const waiter of [...this.#waiters]) {
      waiter.fail?.(new Error('dispatcher is shutting down'));
    }
    await this.#ephemeral?.close();
    await this.#pool?.close();
  }
}
