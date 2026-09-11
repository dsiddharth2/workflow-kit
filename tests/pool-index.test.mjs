import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkerDispatcher } from '../pool/index.mjs';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';

async function roots() {
  return {
    pool: await fs.mkdtemp(path.join(os.tmpdir(), 'index-pool-')),
    ephemeral: await fs.mkdtemp(path.join(os.tmpdir(), 'index-eph-')),
  };
}

test('hybrid: provisions the roster, then serves pool before ephemeral', async () => {
  const fleetApi = createMockFleetApi();
  const { pool, ephemeral } = await roots();
  const dispatcher = await createWorkerDispatcher({
    fleetApi,
    oauthToken: 'tok',
    config: {
      pool: { size: 1, root: pool, acquireTimeoutMs: 1000 },
      ephemeral: { maxConcurrent: 1, workRoot: ephemeral, ttlMs: 60000 },
      dispatch: { maxQueueSize: 2, queueTimeoutMs: 1000 },
    },
  });

  assert.deepEqual(fleetApi.registerCalls.map((call) => call.friendly_name), rosterNames(1));
  assert.equal(fleetApi.authCalls.length, 2);
  assert.equal(dispatcher.capacity, 2);

  const first = await dispatcher.dispatch();
  const second = await dispatcher.dispatch();
  assert.equal(first.workerId, 'pool-1');
  assert.match(second.workerId, /^ephemeral-/);
  assert.equal(fleetApi.registerCalls.length, 4, 'the ephemeral pair registered on demand');

  await second.release();
  assert.equal(fleetApi.removeCalls.length, 2, 'ephemeral pair removed on release');
  await first.release();
  assert.equal(fleetApi.removeCalls.length, 2, 'pool members are never removed');
  await dispatcher.close();
});

test('ephemeral-only: pool.size 0 registers nothing at startup', async () => {
  const fleetApi = createMockFleetApi();
  const { pool, ephemeral } = await roots();
  const dispatcher = await createWorkerDispatcher({
    fleetApi,
    config: {
      pool: { size: 0, root: pool, acquireTimeoutMs: 1000 },
      ephemeral: { maxConcurrent: 2, workRoot: ephemeral, ttlMs: 60000 },
      dispatch: { maxQueueSize: 2, queueTimeoutMs: 1000 },
    },
  });
  assert.equal(fleetApi.registerCalls.length, 0);
  const lease = await dispatcher.dispatch();
  assert.match(lease.workerId, /^ephemeral-/);
  await lease.release();
  await dispatcher.close();
});

test('pool-only: maxConcurrent 0 never creates ephemeral workers', async () => {
  const fleetApi = createMockFleetApi();
  const { pool, ephemeral } = await roots();
  const dispatcher = await createWorkerDispatcher({
    fleetApi,
    config: {
      pool: { size: 1, root: pool, acquireTimeoutMs: 1000 },
      ephemeral: { maxConcurrent: 0, workRoot: ephemeral, ttlMs: 60000 },
      dispatch: { maxQueueSize: 0, queueTimeoutMs: 1000 },
    },
  });
  const held = await dispatcher.dispatch();
  await assert.rejects(() => dispatcher.dispatch(), /busy/);
  assert.equal(fleetApi.registerCalls.length, 2, 'only the roster was registered');
  await held.release();
  await dispatcher.close();
});

test('reads env when no config is given and forwards CLAUDE_CODE_OAUTH_TOKEN', async () => {
  const fleetApi = createMockFleetApi();
  const { pool, ephemeral } = await roots();
  const dispatcher = await createWorkerDispatcher({
    fleetApi,
    env: {
      WORKER_POOL_SIZE: '1',
      WORKER_POOL_ROOT: pool,
      WORKER_EPHEMERAL_MAX: '0',
      WORKER_EPHEMERAL_ROOT: ephemeral,
      CLAUDE_CODE_OAUTH_TOKEN: 'from-env',
    },
  });
  assert.equal(fleetApi.authCalls.length, 2);
  await dispatcher.close();
});

test('a roster member that cannot register is fatal', async () => {
  const fleetApi = createMockFleetApi({ registerFails: ['WORKER-1-REVIEWER'] });
  const { pool, ephemeral } = await roots();
  await assert.rejects(
    () =>
      createWorkerDispatcher({
        fleetApi,
        config: {
          pool: { size: 1, root: pool, acquireTimeoutMs: 1000 },
          ephemeral: { maxConcurrent: 0, workRoot: ephemeral, ttlMs: 60000 },
          dispatch: { maxQueueSize: 0, queueTimeoutMs: 1000 },
        },
      }),
    /WORKER-1-REVIEWER/,
  );
});

test('requires fleetApi', async () => {
  await assert.rejects(() => createWorkerDispatcher({}), /requires fleetApi/);
});
