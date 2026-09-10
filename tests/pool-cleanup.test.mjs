import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanWorker, cleanWorkerFolder } from '../pool/cleanup.mjs';

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'pool-cleanup-'));
}

test('cleanWorkerFolder removes files and directories', async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, 'output.txt'), 'stale');
  await fs.mkdir(path.join(dir, 'nested', 'deep'), { recursive: true });

  const removed = await cleanWorkerFolder(dir);

  assert.deepEqual(removed.sort(), ['nested', 'output.txt']);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('cleanWorkerFolder preserves .claude', async () => {
  const dir = await tempDir();
  await fs.mkdir(path.join(dir, '.claude'));
  await fs.writeFile(path.join(dir, '.claude', 'settings.local.json'), '{}');
  await fs.writeFile(path.join(dir, 'junk.txt'), 'x');

  await cleanWorkerFolder(dir);

  assert.deepEqual(await fs.readdir(dir), ['.claude']);
  assert.equal(
    await fs.readFile(path.join(dir, '.claude', 'settings.local.json'), 'utf8'),
    '{}',
  );
});

test('cleanWorkerFolder creates the folder when it does not exist', async () => {
  const dir = path.join(await tempDir(), 'missing');
  const removed = await cleanWorkerFolder(dir);
  assert.deepEqual(removed, []);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('cleanWorker cleans both role folders', async () => {
  const root = await tempDir();
  const worker = {
    id: 1,
    doer: { name: 'WORKER-1-DOER', folder: path.join(root, 'worker-1', 'doer') },
    reviewer: { name: 'WORKER-1-REVIEWER', folder: path.join(root, 'worker-1', 'reviewer') },
  };
  await fs.mkdir(worker.doer.folder, { recursive: true });
  await fs.mkdir(worker.reviewer.folder, { recursive: true });
  await fs.writeFile(path.join(worker.doer.folder, 'a.txt'), 'a');
  await fs.writeFile(path.join(worker.reviewer.folder, 'b.txt'), 'b');

  const removed = await cleanWorker(worker);

  assert.deepEqual(removed.sort(), ['a.txt', 'b.txt']);
  assert.deepEqual(await fs.readdir(worker.doer.folder), []);
  assert.deepEqual(await fs.readdir(worker.reviewer.folder), []);
});
