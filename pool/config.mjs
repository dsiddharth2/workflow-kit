// pool/config.mjs
import os from 'node:os';
import path from 'node:path';
import { poolConfig } from './roster.mjs';

export const DEFAULT_EPHEMERAL_MAX = 10;
export const DEFAULT_EPHEMERAL_TTL_MS = 600000;
export const DEFAULT_QUEUE_SIZE = 20;
export const DEFAULT_QUEUE_TIMEOUT_MS = 300000;

function intAtLeast(min, raw, name, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}, got: ${String(raw)}`);
  }
  return value;
}

export function ephemeralConfig(env = process.env) {
  return {
    maxConcurrent: intAtLeast(0, env.WORKER_EPHEMERAL_MAX, 'WORKER_EPHEMERAL_MAX', DEFAULT_EPHEMERAL_MAX),
    workRoot: env.WORKER_EPHEMERAL_ROOT
      ? path.resolve(env.WORKER_EPHEMERAL_ROOT)
      : path.join(os.tmpdir(), 'workflow-kit'),
    ttlMs: intAtLeast(1, env.WORKER_EPHEMERAL_TTL_MS, 'WORKER_EPHEMERAL_TTL_MS', DEFAULT_EPHEMERAL_TTL_MS),
  };
}

export function dispatchConfig(env = process.env) {
  return {
    maxQueueSize: intAtLeast(0, env.WORKER_DISPATCH_QUEUE_SIZE, 'WORKER_DISPATCH_QUEUE_SIZE', DEFAULT_QUEUE_SIZE),
    queueTimeoutMs: intAtLeast(
      1,
      env.WORKER_DISPATCH_QUEUE_TIMEOUT_MS,
      'WORKER_DISPATCH_QUEUE_TIMEOUT_MS',
      DEFAULT_QUEUE_TIMEOUT_MS,
    ),
  };
}

export function workersConfig(env = process.env) {
  const config = {
    pool: poolConfig(env),
    ephemeral: ephemeralConfig(env),
    dispatch: dispatchConfig(env),
  };
  if (config.pool.size === 0 && config.ephemeral.maxConcurrent === 0) {
    throw new Error(
      'no workers configured — set WORKER_POOL_SIZE > 0, WORKER_EPHEMERAL_MAX > 0, or both',
    );
  }
  return config;
}
