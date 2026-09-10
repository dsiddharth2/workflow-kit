import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readHolder, tryClaim } from '../pool/worker-lock.mjs';

const holdLockScript = fileURLToPath(new URL('./helpers/hold-lock.mjs', import.meta.url));

async function tempTarget() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pool-lock-'));
  return path.join(dir, 'worker-1');
}

test('a second claim on a held lock returns null', async () => {
  const target = await tempTarget();
  const release = await tryClaim(target);
  assert.ok(release, 'first claim should succeed');
  assert.equal(await tryClaim(target), null, 'second claim must not succeed');
  await release();
});

test('a released lock can be claimed again', async () => {
  const target = await tempTarget();
  const release = await tryClaim(target);
  await release();
  const second = await tryClaim(target);
  assert.ok(second, 'claim after release should succeed');
  await second();
});

test('readHolder reports lock state and when it was taken', async () => {
  const target = await tempTarget();
  assert.deepEqual(await readHolder(target), { locked: false, heldSince: null });

  const release = await tryClaim(target);
  const held = await readHolder(target);
  assert.equal(held.locked, true);
  assert.ok(Date.parse(held.heldSince) > 0, `heldSince should be a timestamp, got ${held.heldSince}`);

  await release();
  assert.equal((await readHolder(target)).locked, false);
});

test('a stale lock is stolen rather than waited on', async () => {
  const target = await tempTarget();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, '');
  // Fake a lock abandoned by a crashed holder: the directory proper-lockfile
  // creates, with a heartbeat far older than LOCK_STALE_MS.
  await fs.mkdir(`${target}.lock`, { recursive: true });
  const longAgo = new Date(Date.now() - 60000);
  await fs.utimes(`${target}.lock`, longAgo, longAgo);

  const release = await tryClaim(target);
  assert.ok(release, 'a stale lock should be reclaimed');
  await release();
});

test('a lock held by another process blocks this one, and frees on its exit', async () => {
  const target = await tempTarget();
  const child = spawn(process.execPath, [holdLockScript, target], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    let output = '';
    for await (const chunk of child.stdout) {
      output += String(chunk);
      if (output.includes('locked')) break;
    }
    assert.match(output, /locked/);
    assert.equal(await tryClaim(target), null, 'the other process holds the lock');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }

  const release = await tryClaim(target);
  assert.ok(release, 'lock should be free once the holder exits');
  await release();
});
