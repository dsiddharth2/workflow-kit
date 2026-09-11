// tests/host-config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'host-config-'));
}

async function writeConfig(dir, filename, content) {
  await fs.writeFile(path.join(dir, filename), content);
}

// Dynamic import of the module under test — deferred so the file can be missing
// at parse time during TDD red phase.
let loadConfig;
test('load module', async () => {
  ({ loadConfig } = await import('../host/config.mjs'));
});

test('valid config returns frozen object', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    name: 'test-host',
    fleet: {},
    comm: { adapter: 'express', port: 4000, host: '127.0.0.1' },
  };`);
  const config = await loadConfig(dir);
  assert.equal(config.name, 'test-host');
  assert.equal(config.comm.adapter, 'express');
  assert.equal(config.comm.port, 4000);
  assert.ok(Object.isFrozen(config));
});

test('missing name throws', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    fleet: {},
    comm: { adapter: 'express' },
  };`);
  await assert.rejects(() => loadConfig(dir), /name/i);
});

test('missing fleet throws', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    name: 'x',
    comm: { adapter: 'express' },
  };`);
  await assert.rejects(() => loadConfig(dir), /fleet/i);
});

test('missing comm throws', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    name: 'x',
    fleet: {},
  };`);
  await assert.rejects(() => loadConfig(dir), /comm/i);
});

test('unsupported adapter throws', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    name: 'x',
    fleet: {},
    comm: { adapter: 'fastify' },
  };`);
  await assert.rejects(() => loadConfig(dir), /fastify/i);
});

test('no config file throws', async () => {
  const dir = await tmpDir();
  await assert.rejects(() => loadConfig(dir), /not found/i);
});

test('falls back to .json when .mjs is absent', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.json', JSON.stringify({
    name: 'json-host',
    fleet: {},
    comm: { adapter: 'express' },
  }));
  const config = await loadConfig(dir);
  assert.equal(config.name, 'json-host');
});

test('env PORT is default when comm.port is absent', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    name: 'x',
    fleet: {},
    comm: { adapter: 'express' },
  };`);
  const config = await loadConfig(dir, { PORT: '9090' });
  assert.equal(config.comm.port, 9090);
});

test('comm.port in config wins over env', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    name: 'x',
    fleet: {},
    comm: { adapter: 'express', port: 5000 },
  };`);
  const config = await loadConfig(dir, { PORT: '9090' });
  assert.equal(config.comm.port, 5000);
});

test('unknown module key logs warning', async (t) => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    name: 'x',
    fleet: {},
    comm: { adapter: 'express' },
    modules: { banana: { enabled: true } },
  };`);
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    await loadConfig(dir);
  } finally {
    console.warn = origWarn;
  }
  assert.ok(warnings.some(w => /banana/i.test(w)));
});

test('unimplemented module with enabled:true logs warning', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    name: 'x',
    fleet: {},
    comm: { adapter: 'express' },
    modules: { runLoop: { enabled: true } },
  };`);
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    await loadConfig(dir);
  } finally {
    console.warn = origWarn;
  }
  assert.ok(warnings.some(w => /runLoop/i.test(w) && /not implemented/i.test(w)));
});
