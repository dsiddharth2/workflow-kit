// tests/pool-config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { dispatchConfig, ephemeralConfig, workersConfig } from '../pool/config.mjs';

test('ephemeralConfig defaults to 10 workers under the OS tmpdir with a 10 minute ttl', () => {
  const config = ephemeralConfig({});
  assert.equal(config.maxConcurrent, 10);
  assert.equal(config.workRoot, path.join(os.tmpdir(), 'workflow-kit'));
  assert.equal(config.ttlMs, 600000);
});

test('ephemeralConfig reads the environment', () => {
  const config = ephemeralConfig({
    WORKER_EPHEMERAL_MAX: '3',
    WORKER_EPHEMERAL_ROOT: '/scratch',
    WORKER_EPHEMERAL_TTL_MS: '5000',
  });
  assert.equal(config.maxConcurrent, 3);
  assert.equal(config.workRoot, path.resolve('/scratch'));
  assert.equal(config.ttlMs, 5000);
});

test('ephemeralConfig accepts zero workers but rejects bad numbers', () => {
  assert.equal(ephemeralConfig({ WORKER_EPHEMERAL_MAX: '0' }).maxConcurrent, 0);
  assert.throws(() => ephemeralConfig({ WORKER_EPHEMERAL_MAX: '-1' }), /WORKER_EPHEMERAL_MAX/);
  assert.throws(() => ephemeralConfig({ WORKER_EPHEMERAL_TTL_MS: '0' }), /WORKER_EPHEMERAL_TTL_MS/);
});

test('dispatchConfig defaults and env', () => {
  assert.deepEqual(dispatchConfig({}), { maxQueueSize: 20, queueTimeoutMs: 300000 });
  assert.deepEqual(
    dispatchConfig({ WORKER_DISPATCH_QUEUE_SIZE: '0', WORKER_DISPATCH_QUEUE_TIMEOUT_MS: '1' }),
    { maxQueueSize: 0, queueTimeoutMs: 1 },
  );
});

test('workersConfig combines all three sections', () => {
  const config = workersConfig({ WORKER_POOL_SIZE: '2', WORKER_EPHEMERAL_MAX: '1' });
  assert.equal(config.pool.size, 2);
  assert.equal(config.ephemeral.maxConcurrent, 1);
  assert.equal(config.dispatch.maxQueueSize, 20);
});

test('workersConfig refuses a configuration with no workers at all', () => {
  assert.throws(
    () => workersConfig({ WORKER_POOL_SIZE: '0', WORKER_EPHEMERAL_MAX: '0' }),
    /no workers configured/,
  );
});
