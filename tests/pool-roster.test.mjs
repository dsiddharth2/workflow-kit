import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  DOER,
  REVIEWER,
  buildRoster,
  poolConfig,
  rosterMemberNames,
  workerDescriptor,
} from '../pool/roster.mjs';

test('role keywords are the reserved lowercase strings', () => {
  assert.equal(DOER, 'doer');
  assert.equal(REVIEWER, 'reviewer');
});

test('poolConfig falls back to documented defaults', () => {
  const config = poolConfig({});
  assert.equal(config.size, 4);
  assert.equal(config.acquireTimeoutMs, 300000);
  assert.equal(path.basename(config.root), 'workdir');
});

test('poolConfig reads the environment', () => {
  const config = poolConfig({
    WORKER_POOL_SIZE: '8',
    WORKER_POOL_ROOT: '/tmp/pool-root',
    WORKER_POOL_ACQUIRE_TIMEOUT_MS: '1000',
  });
  assert.equal(config.size, 8);
  assert.equal(config.root, '/tmp/pool-root');
  assert.equal(config.acquireTimeoutMs, 1000);
});

test('poolConfig accepts zero (ephemeral-only) but rejects negatives and non-integers', () => {
  assert.equal(poolConfig({ WORKER_POOL_SIZE: '0' }).size, 0);
  assert.throws(() => poolConfig({ WORKER_POOL_SIZE: '-1' }), /WORKER_POOL_SIZE/);
  assert.throws(() => poolConfig({ WORKER_POOL_SIZE: 'four' }), /WORKER_POOL_SIZE/);
  assert.throws(() => poolConfig({ WORKER_POOL_SIZE: '2.5' }), /WORKER_POOL_SIZE/);
  assert.throws(() => poolConfig({ WORKER_POOL_ACQUIRE_TIMEOUT_MS: '0' }), /WORKER_POOL_ACQUIRE_TIMEOUT_MS/);
});

test('buildRoster with size 0 is empty', () => {
  assert.deepEqual(buildRoster({ size: 0, root: '/root' }), []);
});

test('workerDescriptor is 1-indexed and pairs names with folders', () => {
  const worker = workerDescriptor('/root', 2);
  assert.equal(worker.id, 2);
  assert.equal(worker.doer.name, 'WORKER-2-DOER');
  assert.equal(worker.reviewer.name, 'WORKER-2-REVIEWER');
  assert.equal(worker.doer.folder, path.join('/root', 'worker-2', 'doer'));
  assert.equal(worker.reviewer.folder, path.join('/root', 'worker-2', 'reviewer'));
  assert.equal(worker.lockTarget, path.join('/root', '.locks', 'worker-2'));
});

test('buildRoster produces size workers starting at 1', () => {
  const roster = buildRoster({ size: 3, root: '/root' });
  assert.deepEqual(roster.map((worker) => worker.id), [1, 2, 3]);
  assert.deepEqual(rosterMemberNames(roster).slice(0, 2), ['WORKER-1-DOER', 'WORKER-1-REVIEWER']);
  assert.equal(rosterMemberNames(roster).length, 6);
});
