// tests/pool-worker-dispatcher.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DispatchOverflowError, WorkerDispatcher } from '../pool/worker-dispatcher.mjs';
import { WorkerPool } from '../pool/worker-pool.mjs';

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

async function makePool(size) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatcher-pool-'));
  return WorkerPool.create({ config: { size, root, acquireTimeoutMs: 5000 } });
}

// Same contract as EphemeralWorkerFactory, minus Fleet.
function fakeEphemeral({ maxConcurrent = 1, failWith = null } = {}) {
  const listeners = new Set();
  let active = 0;
  let counter = 0;
  return {
    get active() { return active; },
    maxConcurrent,
    created: [],
    onRelease(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async create({ signal } = {}) {
      if (failWith) throw failWith;
      if (active >= maxConcurrent) return null;
      active += 1;
      counter += 1;
      const id = `ephemeral-${String(counter).padStart(8, '0')}`;
      this.created.push(id);
      const controller = new AbortController();
      signal?.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
      let released = false;
      return {
        workerId: id,
        doer: { name: `${id}-DOER`, folder: `/tmp/${id}/doer` },
        reviewer: { name: `${id}-REVIEWER`, folder: `/tmp/${id}/reviewer` },
        signal: controller.signal,
        release: async () => {
          if (released) return;
          released = true;
          active -= 1;
          for (const listener of listeners) listener();
        },
      };
    },
    async close() {},
  };
}

function makeDispatcher({ pool = null, ephemeral = null, maxQueueSize = 10, queueTimeoutMs = 5000 } = {}) {
  return new WorkerDispatcher({ pool, ephemeral, config: { maxQueueSize, queueTimeoutMs } });
}

// Controllable stand-in so a release can stall inside tryAcquireNow while a
// newcomer dispatch runs. Real WorkerPool tryClaim is too fast to lock this race.
function gatedPool() {
  const listeners = new Set();
  let held = 0;
  let stallNext = false;
  let resolveStall = null;
  return {
    size: 1,
    armStall() {
      stallNext = true;
    },
    releaseStall() {
      resolveStall?.();
    },
    onRelease(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async tryAcquireNow() {
      if (stallNext) {
        stallNext = false;
        await new Promise((resolve) => {
          resolveStall = resolve;
        });
      }
      if (held >= 1) return null;
      held += 1;
      let released = false;
      return {
        workerId: 'pool-1',
        doer: { name: 'POOL-1-DOER', folder: '/tmp/pool-1/doer' },
        reviewer: { name: 'POOL-1-REVIEWER', folder: '/tmp/pool-1/reviewer' },
        signal: new AbortController().signal,
        release: async () => {
          if (released) return;
          released = true;
          held -= 1;
          for (const listener of listeners) listener();
        },
      };
    },
    async close() {},
  };
}

test('constructor refuses a dispatcher with no tiers', () => {
  assert.throws(() => makeDispatcher(), /no workers configured/);
});

test('capacity is pool size plus ephemeral max', async () => {
  const dispatcher = makeDispatcher({ pool: await makePool(2), ephemeral: fakeEphemeral({ maxConcurrent: 3 }) });
  assert.equal(dispatcher.capacity, 5);
  await dispatcher.close();
});

test('tier 1: the pool serves first', async () => {
  const ephemeral = fakeEphemeral();
  const dispatcher = makeDispatcher({ pool: await makePool(1), ephemeral });
  const lease = await dispatcher.dispatch();
  assert.equal(lease.workerId, 'pool-1');
  assert.deepEqual(ephemeral.created, []);
  await lease.release();
  await dispatcher.close();
});

test('tier 2: ephemeral serves when the pool is full', async () => {
  const ephemeral = fakeEphemeral({ maxConcurrent: 1 });
  const dispatcher = makeDispatcher({ pool: await makePool(1), ephemeral });
  const first = await dispatcher.dispatch();
  const second = await dispatcher.dispatch();
  assert.equal(first.workerId, 'pool-1');
  assert.match(second.workerId, /^ephemeral-/);
  await first.release();
  await second.release();
  await dispatcher.close();
});

test('tier 3: the queue holds callers and a pool release serves the head', async () => {
  const dispatcher = makeDispatcher({ pool: await makePool(1), ephemeral: fakeEphemeral({ maxConcurrent: 1 }) });
  const first = await dispatcher.dispatch();
  const second = await dispatcher.dispatch();
  let settled = false;
  const third = dispatcher.dispatch().then((lease) => { settled = true; return lease; });
  await tick();
  assert.equal(settled, false);
  assert.equal(dispatcher.queued, 1);

  await first.release();
  const lease = await third;
  assert.equal(lease.workerId, 'pool-1', 'the freed pool worker serves the queued caller');
  assert.equal(dispatcher.queued, 0);
  await second.release();
  await lease.release();
  await dispatcher.close();
});

test('an ephemeral release also serves the queue', async () => {
  const ephemeral = fakeEphemeral({ maxConcurrent: 1 });
  const dispatcher = makeDispatcher({ pool: await makePool(1), ephemeral });
  const first = await dispatcher.dispatch();
  const second = await dispatcher.dispatch();
  const third = dispatcher.dispatch();
  await tick();
  await second.release();
  const lease = await third;
  assert.match(lease.workerId, /^ephemeral-/, 'whichever tier frees first serves');
  await first.release();
  await lease.release();
  await dispatcher.close();
});

test('queued callers are served in FIFO order', async () => {
  const dispatcher = makeDispatcher({ pool: await makePool(1) });
  const held = await dispatcher.dispatch();
  const order = [];
  const a = dispatcher.dispatch().then((lease) => { order.push('a'); return lease; });
  const b = dispatcher.dispatch().then((lease) => { order.push('b'); return lease; });
  await tick();
  await held.release();
  const leaseA = await a;
  await leaseA.release();
  const leaseB = await b;
  await leaseB.release();
  assert.deepEqual(order, ['a', 'b']);
  await dispatcher.close();
});

test('a new dispatch does not barge past queued waiters', async () => {
  const pool = gatedPool();
  const dispatcher = makeDispatcher({ pool, queueTimeoutMs: 1000 });
  const held = await dispatcher.dispatch();
  let aLease = null;
  let bLease = null;
  const a = dispatcher.dispatch().then((lease) => {
    aLease = lease;
    return lease;
  });
  try {
    await tick();
    assert.equal(dispatcher.queued, 1);

    // Stall the waiter's tryTiers so the newcomer would steal the freed slot
    // if dispatch() still tries tiers while the queue is non-empty.
    pool.armStall();
    await held.release();
    await tick();

    const b = dispatcher.dispatch().then((lease) => {
      bLease = lease;
      return lease;
    });
    await tick();
    assert.equal(bLease, null, 'newcomer must not steal the freed worker while a waiter is queued');
    assert.equal(aLease, null, 'queued waiter is still blocked on the stalled acquire');
    assert.equal(dispatcher.queued, 2);

    pool.releaseStall();
    const leaseA = await a;
    assert.equal(leaseA.workerId, 'pool-1');
    await leaseA.release();
    const leaseB = await b;
    await leaseB.release();
  } finally {
    pool.releaseStall();
    await dispatcher.close();
  }
});

test('a full queue rejects with DispatchOverflowError', async () => {
  const dispatcher = makeDispatcher({ pool: await makePool(1), maxQueueSize: 0 });
  const held = await dispatcher.dispatch();
  await assert.rejects(() => dispatcher.dispatch(), (err) => {
    assert.ok(err instanceof DispatchOverflowError);
    assert.match(err.message, /busy/);
    return true;
  });
  await held.release();
  await dispatcher.close();
});

test('a queue wait that times out rejects with DispatchOverflowError', async () => {
  const dispatcher = makeDispatcher({ pool: await makePool(1), queueTimeoutMs: 60 });
  const held = await dispatcher.dispatch();
  await assert.rejects(() => dispatcher.dispatch(), DispatchOverflowError);
  await held.release();
  await dispatcher.close();
});

test('an ephemeral creation failure falls through to the queue', async () => {
  const ephemeral = fakeEphemeral({ failWith: new Error('registration exploded') });
  const dispatcher = makeDispatcher({ pool: await makePool(1), ephemeral, queueTimeoutMs: 60 });
  const held = await dispatcher.dispatch();
  await assert.rejects(() => dispatcher.dispatch(), DispatchOverflowError);
  await held.release();
  await dispatcher.close();
});

test('aborting while queued removes the waiter', async () => {
  const dispatcher = makeDispatcher({ pool: await makePool(1) });
  const held = await dispatcher.dispatch();
  const controller = new AbortController();
  const waiting = dispatcher.dispatch({ signal: controller.signal });
  await tick();
  controller.abort(new Error('caller went away'));
  await assert.rejects(() => waiting, /caller went away/);
  assert.equal(dispatcher.queued, 0);
  await held.release();
  const next = await dispatcher.dispatch();
  assert.equal(next.workerId, 'pool-1');
  await next.release();
  await dispatcher.close();
});

test('a queued caller receives heartbeats with position and capacity', async () => {
  const dispatcher = makeDispatcher({ pool: await makePool(1), ephemeral: fakeEphemeral({ maxConcurrent: 1 }) });
  const first = await dispatcher.dispatch();
  const second = await dispatcher.dispatch();
  const phases = [];
  const third = dispatcher.dispatch({ reportPhase: (message) => phases.push(message) });
  await tick();
  assert.equal(phases.length, 1);
  assert.match(phases[0], /position 1/);
  assert.match(phases[0], /capacity 2/);
  await first.release();
  await (await third).release();
  await second.release();
  await dispatcher.close();
});

test('ephemeral-only dispatch works with no pool', async () => {
  const dispatcher = makeDispatcher({ ephemeral: fakeEphemeral({ maxConcurrent: 1 }) });
  const lease = await dispatcher.dispatch();
  assert.match(lease.workerId, /^ephemeral-/);
  await lease.release();
  await dispatcher.close();
});

test('close rejects queued waiters and refuses new dispatches', async () => {
  const dispatcher = makeDispatcher({ pool: await makePool(1) });
  const held = await dispatcher.dispatch();
  const waiting = dispatcher.dispatch();
  await tick();
  await dispatcher.close();
  await assert.rejects(() => waiting, /shutting down/);
  await assert.rejects(() => dispatcher.dispatch(), /closed/);
  await held.release();
});
