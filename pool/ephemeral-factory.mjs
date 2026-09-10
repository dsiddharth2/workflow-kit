import crypto from 'node:crypto';
import path from 'node:path';

// On-demand doer+reviewer pairs for overflow and serverless deployment. Each
// pair has a unique id, so no two callers can ever share one -- no lock needed.
export class EphemeralWorkerFactory {
  #manager;
  #config;
  #active = new Set();
  #releaseListeners = new Set();
  #closed = false;

  constructor({ memberManager, config } = {}) {
    if (!memberManager) throw new Error('EphemeralWorkerFactory requires memberManager');
    if (!config) throw new Error('EphemeralWorkerFactory requires config');
    this.#manager = memberManager;
    this.#config = config;
  }

  get active() { return this.#active.size; }
  get maxConcurrent() { return this.#config.maxConcurrent; }

  onRelease(listener) {
    this.#releaseListeners.add(listener);
    return () => this.#releaseListeners.delete(listener);
  }

  async create({ signal } = {}) {
    if (this.#closed) return null;
    if (this.#active.size >= this.#config.maxConcurrent) return null;
    signal?.throwIfAborted();

    const id = crypto.randomUUID();
    const shortId = id.slice(0, 8);
    const prefix = `EPHEMERAL-${shortId.toUpperCase()}`;
    const workRoot = path.join(this.#config.workRoot, id);

    // Reserve the slot before the slow registration so concurrent creates
    // cannot overshoot maxConcurrent.
    const entry = { release: null };
    this.#active.add(entry);

    let pair;
    try {
      pair = await this.#manager.provisionPair(prefix, workRoot);
    } catch (err) {
      this.#active.delete(entry);
      throw err;
    }

    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }

    let ttl = null;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      if (ttl) clearTimeout(ttl);
      try {
        await this.#manager.teardownPair(prefix, workRoot);
      } catch (err) {
        console.warn(`[ephemeral] teardown failed for ${prefix}: ${err?.message ?? err}`);
      }
      this.#active.delete(entry);
      for (const listener of this.#releaseListeners) {
        try {
          listener();
        } catch (err) {
          console.warn(`[ephemeral] release listener threw: ${err?.message ?? err}`);
        }
      }
    };
    entry.release = release;

    // Safety net: a task that never releases would leak a Fleet member and a
    // folder under tmpdir. Abort it cooperatively, then tear down regardless.
    ttl = setTimeout(() => {
      controller.abort(new Error(`ephemeral worker ${shortId} exceeded ttl ${this.#config.ttlMs}ms`));
      void release();
    }, this.#config.ttlMs);
    ttl.unref?.();

    return {
      workerId: `ephemeral-${shortId}`,
      doer: pair.doer,
      reviewer: pair.reviewer,
      signal: controller.signal,
      release,
    };
  }

  async close() {
    this.#closed = true;
    await Promise.all([...this.#active].map((entry) => entry.release?.()));
  }
}
