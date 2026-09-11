import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DOER = 'doer';
export const REVIEWER = 'reviewer';
export const ROLES = Object.freeze([DOER, REVIEWER]);

export const DEFAULT_POOL_SIZE = 4;
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 300000;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function positiveInt(raw, name, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got: ${String(raw)}`);
  }
  return value;
}

function nonNegativeInt(raw, name, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got: ${String(raw)}`);
  }
  return value;
}

export function poolConfig(env = process.env) {
  return {
    size: nonNegativeInt(env.WORKER_POOL_SIZE, 'WORKER_POOL_SIZE', DEFAULT_POOL_SIZE),
    root: env.WORKER_POOL_ROOT
      ? path.resolve(env.WORKER_POOL_ROOT)
      : path.join(repoRoot, 'workdir'),
    acquireTimeoutMs: positiveInt(
      env.WORKER_POOL_ACQUIRE_TIMEOUT_MS,
      'WORKER_POOL_ACQUIRE_TIMEOUT_MS',
      DEFAULT_ACQUIRE_TIMEOUT_MS,
    ),
  };
}

export function workerDescriptor(root, id) {
  const base = path.join(root, `worker-${id}`);
  return {
    id,
    doer: { name: `WORKER-${id}-DOER`, folder: path.join(base, 'doer') },
    reviewer: { name: `WORKER-${id}-REVIEWER`, folder: path.join(base, 'reviewer') },
    // Locks live outside the folders they protect so cleanup needs no carve-out.
    lockTarget: path.join(root, '.locks', `worker-${id}`),
  };
}

export function buildRoster({ size, root }) {
  return Array.from({ length: size }, (_, index) => workerDescriptor(root, index + 1));
}

export function rosterMemberNames(roster) {
  return roster.flatMap((worker) => [worker.doer.name, worker.reviewer.name]);
}
