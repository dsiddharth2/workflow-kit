import fs from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';

// The holder rewrites the lock's heartbeat every LOCK_UPDATE_MS. A lock whose
// heartbeat is older than LOCK_STALE_MS is treated as abandoned and stolen --
// this is what recovers a worker after a hard kill. PID liveness is
// deliberately not used: across containers, PIDs are meaningless.
export const LOCK_UPDATE_MS = 5000;
export const LOCK_STALE_MS = 15000;

function holderPath(lockTarget) {
  return `${lockTarget}.holder.json`;
}

async function ensureTarget(lockTarget) {
  await fs.mkdir(path.dirname(lockTarget), { recursive: true });
  await fs.writeFile(lockTarget, '', { flag: 'a' });
}

export async function tryClaim(lockTarget, { onCompromised } = {}) {
  await ensureTarget(lockTarget);

  let releaseLock;
  try {
    releaseLock = await lockfile.lock(lockTarget, {
      stale: LOCK_STALE_MS,
      update: LOCK_UPDATE_MS,
      retries: 0,
      onCompromised: (err) => onCompromised?.(err),
    });
  } catch (err) {
    if (err.code === 'ELOCKED') return null;
    throw err;
  }

  // Diagnostic metadata only -- inspect-members reads it to report heldSince.
  await fs.writeFile(
    holderPath(lockTarget),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    'utf8',
  );

  return async () => {
    await fs.rm(holderPath(lockTarget), { force: true });
    await releaseLock();
  };
}

export async function readHolder(lockTarget) {
  let locked = false;
  try {
    locked = await lockfile.check(lockTarget, { stale: LOCK_STALE_MS });
  } catch (err) {
    if (err.code === 'ENOENT') return { locked: false, heldSince: null };
    throw err;
  }
  if (!locked) return { locked: false, heldSince: null };

  try {
    const raw = await fs.readFile(holderPath(lockTarget), 'utf8');
    return { locked: true, heldSince: JSON.parse(raw).startedAt ?? null };
  } catch {
    return { locked: true, heldSince: null };
  }
}
