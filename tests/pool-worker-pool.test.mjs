// tests/pool-worker-pool.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PoolSaturatedError, WorkerPool } from '../pool/worker-pool.mjs';

async function makePool({ size = 1, acquireTimeoutMs = 300000 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-pool-'));
  const pool = WorkerPool.create({ config: { size, root, acquireTimeoutMs } });
  return { pool, root };
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

test('create needs no fleetApi and never touches Fleet', async () => {
  const { pool } = await makePool({ size: 2 });
  assert.equal(pool.size, 2);
  assert.equal(pool.roster[0].doer.name, 'WORKER-1-DOER');
  await pool.close();
});

test('leases are prefixed pool- and carry both roles', async () => {
  const { pool } = await makePool({ size: 1 });
  const lease = await pool.acquire();
  assert.equal(lease.workerId, 'pool-1');
  assert.equal(lease.doer.name, 'WORKER-1-DOER');
  assert.equal(lease.reviewer.name, 'WORKER-1-REVIEWER');
  assert.ok(lease.signal instanceof AbortSignal);
  await lease.release();
  await pool.close();
});

test('concurrent acquires get different workers', async () => {
  const { pool } = await makePool({ size: 2 });
  const [first, second] = await Promise.all([pool.acquire(), pool.acquire()]);
  assert.notEqual(first.workerId, second.workerId);
  await first.release();
  await second.release();
  await pool.close();
});

test('tryAcquireNow returns null instead of queueing when all workers are held', async () => {
  const { pool } = await makePool({ size: 1 });
  const held = await pool.tryAcquireNow();
  assert.equal(held.workerId, 'pool-1');
  assert.equal(await pool.tryAcquireNow(), null);
  await held.release();
  assert.equal((await pool.tryAcquireNow()).workerId, 'pool-1');
  await pool.close();
});

test('onRelease fires after the worker is free again', async () => {
  const { pool } = await makePool({ size: 1 });
  let fired = 0;
  let freeAtFire = null;
  const unsubscribe = pool.onRelease(() => {
    fired += 1;
    freeAtFire = pool.tryAcquireNow();
  });
  const lease = await pool.acquire();
  await lease.release();
  assert.equal(fired, 1);
  const reacquired = await freeAtFire;
  assert.equal(reacquired.workerId, 'pool-1', 'listener must observe the worker as free');
  await reacquired.release();
  assert.equal(fired, 2);
  unsubscribe();
  // Second listener fire also called tryAcquireNow; release that lease only
  // after unsubscribe so the listener does not grab the worker again.
  await (await freeAtFire).release();
  const again = await pool.acquire();
  await again.release();
  assert.equal(fired, 2, 'unsubscribed listener must not fire');
  await pool.close();
});

test('a saturated pool queues and hands off on release', async () => {
  const { pool } = await makePool({ size: 1 });
  const held = await pool.acquire();
  let waitingResolved = false;
  const waiting = pool.acquire().then((lease) => {
    waitingResolved = true;
    return lease;
  });
  await tick();
  assert.equal(waitingResolved, false, 'must not hand out a held worker');
  await held.release();
  const lease = await waiting;
  assert.equal(lease.workerId, 'pool-1');
  await lease.release();
  await pool.close();
});

test('a queued caller gets an immediate heartbeat with its position', async () => {
  const { pool } = await makePool({ size: 1 });
  const held = await pool.acquire();
  const phases = [];
  const waiting = pool.acquire({ reportPhase: (message) => phases.push(message) });
  await tick();
  assert.equal(phases.length, 1);
  assert.match(phases[0], /position 1/);
  assert.match(phases[0], /pool size 1/);
  await held.release();
  await (await waiting).release();
  await pool.close();
});

test('a queued caller fails with a readable error after the timeout', async () => {
  const { pool } = await makePool({ size: 1, acquireTimeoutMs: 100 });
  const held = await pool.acquire();
  await assert.rejects(() => pool.acquire(), (err) => {
    assert.ok(err instanceof PoolSaturatedError);
    assert.match(err.message, /all 1 workers busy/);
    return true;
  });
  await held.release();
  await pool.close();
});

test('aborting while queued dequeues the waiter', async () => {
  const { pool } = await makePool({ size: 1 });
  const held = await pool.acquire();
  const controller = new AbortController();
  const waiting = pool.acquire({ signal: controller.signal });
  await tick();
  controller.abort(new Error('caller went away'));
  await assert.rejects(() => waiting, /caller went away/);
  await held.release();
  const lease = await pool.acquire();
  assert.equal(lease.workerId, 'pool-1');
  await lease.release();
  await pool.close();
});

test('acquire cleans a folder left dirty by a crashed holder', async () => {
  const { pool, root } = await makePool({ size: 1 });
  const doerFolder = path.join(root, 'worker-1', 'doer');
  await fs.mkdir(doerFolder, { recursive: true });
  const stale = path.join(doerFolder, 'left-behind.txt');
  await fs.writeFile(stale, 'from a crashed run');
  const lease = await pool.acquire();
  await assert.rejects(() => fs.access(stale), 'acquire must wipe inherited files');
  await lease.release();
  await pool.close();
});

test('release is idempotent and a closed pool refuses new leases', async () => {
  const { pool } = await makePool({ size: 1 });
  const lease = await pool.acquire();
  await lease.release();
  await lease.release();
  await pool.close();
  assert.equal(await pool.tryAcquireNow(), null);
  await assert.rejects(() => pool.acquire(), /closed/);
});
