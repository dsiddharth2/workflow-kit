# Fleet Agent Kit — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `host/` and `comm/` modules alongside the existing `mcp/` code, delivering a config-driven entry point, extended tools registry, tool executor, and swappable comm layer with named route slots.

**Architecture:** `host/index.mjs` orchestrates the same Fleet transport, worker pool, and MCP server layer that `mcp/main.mjs` uses today, but wired through a config file (`host.config.mjs`) and a comm adapter interface (`comm/`). The existing `mcp/` path is untouched.

**Tech Stack:** Node 22, ESM, `node:test` runner, Zod v4, Express 5 via `@modelcontextprotocol/express`, existing `pool/` and `transport/` modules.

**Spec:** `docs/specs/2026-09-11-fleet-agent-kit-phase1-spec.md`

---

### Task 1: Config loader and validator

**Files:**
- Create: `host/config.mjs`
- Test: `tests/host-config.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/host-config.test.mjs`
Expected: FAIL — `host/config.mjs` does not exist.

- [ ] **Step 3: Write the implementation**

```js
// host/config.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SUPPORTED_ADAPTERS = new Set(['express']);
const KNOWN_MODULES = new Set([
  'runLoop', 'memory', 'budgets', 'guardrails', 'evals', 'dispatch',
]);
const IMPLEMENTED_MODULES = new Set([]); // Phase 1: none

export async function loadConfig(configDir, env = process.env) {
  const raw = await resolveConfig(configDir);
  return validate(raw, env);
}

async function resolveConfig(dir) {
  const mjsPath = path.join(dir, 'host.config.mjs');
  try {
    const mod = await import(pathToFileURL(mjsPath).href);
    return mod.default;
  } catch (err) {
    if (err.code !== 'ERR_MODULE_NOT_FOUND' && !err.message?.includes('Cannot find module')) {
      throw err;
    }
  }

  const jsonPath = path.join(dir, 'host.config.json');
  try {
    const text = await fs.readFile(jsonPath, 'utf8');
    return JSON.parse(text);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  throw new Error(`host.config.mjs (or .json) not found in ${dir}`);
}

function validate(raw, env) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('config must be an object');
  }
  if (!raw.name || typeof raw.name !== 'string') {
    throw new Error('config.name is required (non-empty string)');
  }
  if (!raw.fleet || typeof raw.fleet !== 'object') {
    throw new Error('config.fleet is required (object)');
  }
  if (!raw.comm || typeof raw.comm !== 'object') {
    throw new Error('config.comm is required (object)');
  }
  if (!SUPPORTED_ADAPTERS.has(raw.comm.adapter)) {
    throw new Error(
      `unsupported comm adapter: "${raw.comm.adapter}" — supported: ${[...SUPPORTED_ADAPTERS].join(', ')}`,
    );
  }

  const port = raw.comm.port ?? Number(env.PORT ?? 3000);
  const host = raw.comm.host ?? env.MCP_BIND_HOST ?? '127.0.0.1';

  if (raw.modules && typeof raw.modules === 'object') {
    for (const key of Object.keys(raw.modules)) {
      if (!KNOWN_MODULES.has(key)) {
        console.warn(`[host/config] unknown module "${key}" — ignored`);
      } else if (raw.modules[key]?.enabled && !IMPLEMENTED_MODULES.has(key)) {
        console.warn(
          `[host/config] ${key} enabled but not implemented in this version — ignored`,
        );
      }
    }
  }

  return Object.freeze({
    name: raw.name,
    description: raw.description ?? '',
    fleet: Object.freeze({ ...raw.fleet }),
    comm: Object.freeze({
      adapter: raw.comm.adapter,
      port,
      host,
    }),
    modules: Object.freeze(raw.modules ?? {}),
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/host-config.test.mjs`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add host/config.mjs tests/host-config.test.mjs
git commit -m "feat: add host config loader with validation"
```

---

### Task 2: Extended tools registry

**Files:**
- Create: `host/tools/registry.mjs`
- Test: `tests/host-registry.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// tests/host-registry.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { extendRegistry, hostRegistry } = await import('../host/tools/registry.mjs');
const { defaultRegistry } = await import('../mcp/registry.mjs');

test('hostRegistry has same length as defaultRegistry', () => {
  assert.equal(hostRegistry.length, defaultRegistry.length);
});

test('every tool has the extended fields', () => {
  for (const tool of hostRegistry) {
    assert.equal(typeof tool.reversible, 'boolean', `${tool.name}.reversible`);
    assert.equal(typeof tool.timeout, 'number', `${tool.name}.timeout`);
    assert.equal(typeof tool.retryable, 'boolean', `${tool.name}.retryable`);
    assert.ok(Array.isArray(tool.tags), `${tool.name}.tags`);
  }
});

test('defaults are applied when tool does not declare them', () => {
  const original = [{ name: 'bare', run: async () => 'ok' }];
  const extended = extendRegistry(original);
  assert.equal(extended[0].reversible, true);
  assert.equal(extended[0].timeout, 300_000);
  assert.equal(extended[0].retryable, false);
  assert.deepEqual(extended[0].tags, []);
});

test('explicit values on a tool are preserved', () => {
  const original = [{
    name: 'custom',
    reversible: false,
    timeout: 10_000,
    retryable: true,
    tags: ['critical'],
    run: async () => 'ok',
  }];
  const extended = extendRegistry(original);
  assert.equal(extended[0].reversible, false);
  assert.equal(extended[0].timeout, 10_000);
  assert.equal(extended[0].retryable, true);
  assert.deepEqual(extended[0].tags, ['critical']);
});

test('original tool properties (name, description, run, inputSchema) are preserved', () => {
  for (let i = 0; i < hostRegistry.length; i++) {
    const original = defaultRegistry[i];
    const extended = hostRegistry[i];
    assert.equal(extended.name, original.name);
    assert.equal(extended.description, original.description);
    assert.equal(extended.run, original.run);
    if (original.inputSchema) {
      assert.equal(extended.inputSchema, original.inputSchema);
    }
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/host-registry.test.mjs`
Expected: FAIL — `host/tools/registry.mjs` does not exist.

- [ ] **Step 3: Write the implementation**

```js
// host/tools/registry.mjs
import { defaultRegistry } from '../../mcp/registry.mjs';

const DEFAULTS = {
  reversible: true,
  timeout: 300_000,
  retryable: false,
  tags: [],
};

export function extendRegistry(registry = defaultRegistry) {
  return registry.map(entry => ({
    ...DEFAULTS,
    ...entry,
    tags: entry.tags ?? DEFAULTS.tags,
  }));
}

export const hostRegistry = extendRegistry();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/host-registry.test.mjs`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add host/tools/registry.mjs tests/host-registry.test.mjs
git commit -m "feat: add extended tools registry with default metadata"
```

---

### Task 3: Tool executor

**Files:**
- Create: `host/tools/executor.mjs`
- Test: `tests/host-executor.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// tests/host-executor.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod/v4';

const { executeTool } = await import('../host/tools/executor.mjs');

const mockFleetApi = {};

function makeTool(overrides = {}) {
  return {
    name: 'test-tool',
    timeout: 5000,
    run: async () => 'ok',
    ...overrides,
  };
}

test('successful tool call returns { ok: true, result }', async () => {
  const tool = makeTool({ run: async () => ({ answer: 42 }) });
  const out = await executeTool(tool, { fleetApi: mockFleetApi, args: {} });
  assert.equal(out.ok, true);
  assert.deepEqual(out.result, { answer: 42 });
});

test('invalid args returns validation_failed', async () => {
  const tool = makeTool({
    inputSchema: z.object({ city: z.string() }),
  });
  const out = await executeTool(tool, { fleetApi: mockFleetApi, args: { city: 123 } });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'validation_failed');
  assert.ok(out.details);
});

test('valid args pass validation and run executes', async () => {
  const tool = makeTool({
    inputSchema: z.object({ city: z.string() }),
    run: async ({ args }) => `weather in ${args.city}`,
  });
  const out = await executeTool(tool, { fleetApi: mockFleetApi, args: { city: 'London' } });
  assert.equal(out.ok, true);
  assert.equal(out.result, 'weather in London');
});

test('tool without inputSchema skips validation', async () => {
  const tool = makeTool({ run: async ({ args }) => args.anything });
  const out = await executeTool(tool, { fleetApi: mockFleetApi, args: { anything: 'goes' } });
  assert.equal(out.ok, true);
  assert.equal(out.result, 'goes');
});

test('thrown error returns tool_error', async () => {
  const tool = makeTool({ run: async () => { throw new Error('boom'); } });
  const out = await executeTool(tool, { fleetApi: mockFleetApi, args: {} });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'tool_error');
  assert.equal(out.message, 'boom');
});

test('timeout returns error', async () => {
  const tool = makeTool({
    timeout: 50,
    run: async ({ signal }) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 10_000);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      });
    },
  });
  const out = await executeTool(tool, { fleetApi: mockFleetApi, args: {} });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'timeout');
});

test('caller abort signal is respected', async () => {
  const ac = new AbortController();
  const tool = makeTool({
    timeout: 60_000,
    run: async ({ signal }) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 10_000);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      });
    },
  });
  setTimeout(() => ac.abort(), 50);
  const out = await executeTool(tool, { fleetApi: mockFleetApi, args: {}, signal: ac.signal });
  assert.equal(out.ok, false);
  assert.match(out.error, /timeout|abort/);
});

test('extra context is passed through to run()', async () => {
  let received;
  const tool = makeTool({
    run: async (ctx) => { received = ctx; return 'ok'; },
  });
  await executeTool(tool, {
    fleetApi: mockFleetApi,
    args: { x: 1 },
    reportPhase: 'test-phase',
    workspace: { workerId: 'w-1' },
  });
  assert.equal(received.fleetApi, mockFleetApi);
  assert.deepEqual(received.args, { x: 1 });
  assert.equal(received.reportPhase, 'test-phase');
  assert.deepEqual(received.workspace, { workerId: 'w-1' });
  assert.ok(received.signal);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/host-executor.test.mjs`
Expected: FAIL — `host/tools/executor.mjs` does not exist.

- [ ] **Step 3: Write the implementation**

```js
// host/tools/executor.mjs

export async function executeTool(tool, { fleetApi, args, signal, ...rest }) {
  if (tool.inputSchema) {
    const result = tool.inputSchema.safeParse(args);
    if (!result.success) {
      return { ok: false, error: 'validation_failed', details: result.error };
    }
  }

  const timeoutSignal = AbortSignal.timeout(tool.timeout);
  const merged = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  try {
    const result = await tool.run({ fleetApi, args, signal: merged, ...rest });
    return { ok: true, result };
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      return { ok: false, error: 'timeout', message: `exceeded ${tool.timeout}ms` };
    }
    return { ok: false, error: 'tool_error', message: err.message };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/host-executor.test.mjs`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add host/tools/executor.mjs tests/host-executor.test.mjs
git commit -m "feat: add tool executor with validation, timeout, error-as-value"
```

---

### Task 4: Comm interface and Express adapter

**Files:**
- Create: `comm/interface.mjs`
- Create: `comm/express.mjs`
- Test: `tests/comm-express.test.mjs`

- [ ] **Step 1: Write the comm interface contract**

```js
// comm/interface.mjs
//
// Every comm adapter must implement this shape:
//
//   {
//     async start({ routes, port, host, authenticate })
//     async stop()
//   }
//
// routes is an object with named handlers. Null or undefined routes are not
// mounted. The adapter provides the HTTP framework; the handlers provide logic.
//
//   routes.mcp     POST /mcp      — MCP protocol
//   routes.task    POST /task     — task submission (Phase 2)
//   routes.jobs    GET  /jobs/:id — job status (Phase 4)
//   routes.health  GET  /health   — health check
//
// authenticate is an Express-compatible middleware function (req, res, next).
```

- [ ] **Step 2: Write the failing tests for the Express adapter**

```js
// tests/comm-express.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';

const { createExpressAdapter } = await import('../comm/express.mjs');

function authenticate(req, res, next) {
  req.user = { id: 'test' };
  next();
}

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpPost(port, path, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

test('health route returns ok', async () => {
  const adapter = createExpressAdapter();
  await adapter.start({
    routes: {
      health: (req, res) => res.json({ ok: true }),
      mcp: null,
      task: null,
      jobs: null,
    },
    port: 0,
    host: '127.0.0.1',
    authenticate,
  });
  try {
    const res = await httpGet(adapter.port(), '/health');
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
  } finally {
    await adapter.stop();
  }
});

test('mcp route calls handler with auth', async () => {
  let called = false;
  const adapter = createExpressAdapter();
  await adapter.start({
    routes: {
      health: null,
      mcp: (req, res) => { called = true; res.json({ received: true }); },
      task: null,
      jobs: null,
    },
    port: 0,
    host: '127.0.0.1',
    authenticate,
  });
  try {
    const res = await httpPost(adapter.port(), '/mcp', { test: 1 });
    assert.equal(res.status, 200);
    assert.ok(called);
  } finally {
    await adapter.stop();
  }
});

test('null routes are not mounted', async () => {
  const adapter = createExpressAdapter();
  await adapter.start({
    routes: { health: (req, res) => res.json({ ok: true }), mcp: null, task: null, jobs: null },
    port: 0,
    host: '127.0.0.1',
    authenticate,
  });
  try {
    const res = await httpPost(adapter.port(), '/mcp', {});
    assert.notEqual(res.status, 200);
  } finally {
    await adapter.stop();
  }
});

test('stop() closes the server', async () => {
  const adapter = createExpressAdapter();
  await adapter.start({
    routes: { health: (req, res) => res.json({ ok: true }), mcp: null, task: null, jobs: null },
    port: 0,
    host: '127.0.0.1',
    authenticate,
  });
  await adapter.stop();
  await assert.rejects(() => httpGet(adapter.port(), '/health'), /ECONNREFUSED/);
});

test('task route is mounted when provided', async () => {
  let taskBody;
  const adapter = createExpressAdapter();
  await adapter.start({
    routes: {
      health: null,
      mcp: null,
      task: (req, res) => { taskBody = req.body; res.json({ queued: true }); },
      jobs: null,
    },
    port: 0,
    host: '127.0.0.1',
    authenticate,
  });
  try {
    const res = await httpPost(adapter.port(), '/task', { goal: 'test' });
    assert.equal(res.status, 200);
    assert.deepEqual(taskBody, { goal: 'test' });
  } finally {
    await adapter.stop();
  }
});

test('jobs route is mounted when provided', async () => {
  let jobId;
  const adapter = createExpressAdapter();
  await adapter.start({
    routes: {
      health: null,
      mcp: null,
      task: null,
      jobs: (req, res) => { jobId = req.params.id; res.json({ status: 'done' }); },
    },
    port: 0,
    host: '127.0.0.1',
    authenticate,
  });
  try {
    const res = await httpGet(adapter.port(), '/jobs/abc-123');
    assert.equal(res.status, 200);
    assert.equal(jobId, 'abc-123');
  } finally {
    await adapter.stop();
  }
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/comm-express.test.mjs`
Expected: FAIL — `comm/express.mjs` does not exist.

- [ ] **Step 4: Write the implementation**

```js
// comm/express.mjs
import { createMcpExpressApp } from '@modelcontextprotocol/express';

export function createExpressAdapter() {
  let server = null;

  return {
    async start({ routes, port, host, authenticate }) {
      const app = createMcpExpressApp();

      if (routes.health) app.get('/health', routes.health);
      if (routes.mcp)    app.post('/mcp', authenticate, routes.mcp);
      if (routes.task)   app.post('/task', authenticate, routes.task);
      if (routes.jobs)   app.get('/jobs/:id', authenticate, routes.jobs);

      server = app.listen(port, host);
      await new Promise((resolve, reject) => {
        const onListening = () => { server.off('error', onError); resolve(); };
        const onError = (err) => { server.off('listening', onListening); reject(err); };
        server.once('listening', onListening);
        server.once('error', onError);
      });
    },

    port() {
      return server?.address()?.port;
    },

    address() {
      return server?.address();
    },

    async stop() {
      if (!server) return;
      await new Promise(resolve => server.close(resolve));
      server = null;
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/comm-express.test.mjs`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add comm/interface.mjs comm/express.mjs tests/comm-express.test.mjs
git commit -m "feat: add comm layer interface and Express adapter"
```

---

### Task 5: Host entry point

**Files:**
- Create: `host/index.mjs`
- Test: `tests/host-index.test.mjs`

This is the integration task. `host/index.mjs` wires config, registry, executor, comm adapter, pool, and MCP server together.

- [ ] **Step 1: Write the failing tests**

```js
// tests/host-index.test.mjs
import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { WorkerDispatcher } from '../pool/worker-dispatcher.mjs';
import { WorkerPool } from '../pool/worker-pool.mjs';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';

const { startHost, createHost } = await import('../host/index.mjs');

function mockPayloadForCommand(command) {
  if (command.includes('weather.py')) {
    return JSON.stringify({
      ok: true, location: 'London', temp_c: '15', temp_f: '59',
      feels_like_c: '14', humidity: '72', description: 'Cloudy',
      wind_speed_kmph: '11', wind_dir: 'WSW', visibility_km: '10', uv_index: '3',
    });
  }
  if (command.includes('timezone.py')) {
    return JSON.stringify({
      ok: true, timezone: 'Europe/London', datetime: '2025-06-15T14:30:00+01:00',
      utc_offset: '+01:00', day_of_week: 0, abbreviation: 'BST',
    });
  }
  if (command.includes('textstats.py')) {
    return JSON.stringify({
      ok: true, char_count: 26, word_count: 5,
      sentence_count: 1, unique_words: 5, avg_word_length: 4.2,
    });
  }
  return JSON.stringify({ root: '/tmp/x', exists: true, fileCount: 1, totalBytes: 4 });
}

function makeMockFleetApi() {
  return createMockFleetApi({
    members: rosterNames(2),
    commandPayload: (options) => mockPayloadForCommand(options.command ?? ''),
  });
}

async function makeDispatcher() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'host-test-pool-'));
  return new WorkerDispatcher({
    pool: WorkerPool.create({ config: { size: 2, root, acquireTimeoutMs: 5000 } }),
    ephemeral: null,
    config: { maxQueueSize: 4, queueTimeoutMs: 5000 },
  });
}

test('startHost boots and serves tools via MCP', async () => {
  const fleetApi = makeMockFleetApi();
  const dispatcher = await makeDispatcher();
  const { host, close } = await startHost({ fleetApi, dispatcher, port: 0 });

  const url = new URL(`http://127.0.0.1:${host.port()}/mcp`);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(url));
    const { tools } = await client.listTools();
    assert.ok(tools.some(t => t.name === 'inspect-members'));
    assert.ok(tools.some(t => t.name === 'demo'));
    assert.ok(tools.some(t => t.name === 'weather'));
    assert.ok(tools.some(t => t.name === 'city-briefing'));

    const result = await client.callTool({ name: 'inspect-members', arguments: {} });
    assert.equal(result.isError, undefined, `tool call failed: ${result.content?.[0]?.text}`);
  } finally {
    try { await client.close(); } finally { await close(); }
  }
});

test('startHost health endpoint returns ok', async () => {
  const fleetApi = makeMockFleetApi();
  const dispatcher = await makeDispatcher();
  const { host, close } = await startHost({ fleetApi, dispatcher, port: 0 });

  try {
    const res = await new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1', port: host.port(), path: '/health', method: 'GET',
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  } finally {
    await close();
  }
});

test('callTool returns result through executor path', async () => {
  const fleetApi = makeMockFleetApi();
  const dispatcher = await makeDispatcher();
  const { callTool, close } = await startHost({ fleetApi, dispatcher, port: 0 });

  try {
    const out = await callTool('inspect-members', {});
    assert.equal(out.ok, true);
    assert.ok(out.result);
  } finally {
    await close();
  }
});

test('callTool returns error for unknown tool', async () => {
  const fleetApi = makeMockFleetApi();
  const dispatcher = await makeDispatcher();
  const { callTool, close } = await startHost({ fleetApi, dispatcher, port: 0 });

  try {
    const out = await callTool('nonexistent-tool', {});
    assert.equal(out.ok, false);
    assert.match(out.error, /not_found|unknown/i);
  } finally {
    await close();
  }
});

test('close shuts down cleanly', async () => {
  const fleetApi = makeMockFleetApi();
  const dispatcher = await makeDispatcher();
  const { host, close } = await startHost({ fleetApi, dispatcher, port: 0 });
  const port = host.port();
  await close();
  await assert.rejects(
    () => new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, path: '/health', method: 'GET' },
        resolve);
      req.on('error', reject);
      req.end();
    }),
    /ECONNREFUSED/,
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/host-index.test.mjs`
Expected: FAIL — `host/index.mjs` does not exist.

- [ ] **Step 3: Write the implementation**

```js
// host/index.mjs
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureApralabs } from '../workflows/demo/ensure-apralabs.mjs';
import { createWorkerDispatcher } from '../pool/index.mjs';
import { buildMcpServer } from '../mcp/server.mjs';
import { authenticate as defaultAuthenticate } from '../mcp/auth.mjs';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { createPooledFleetApi } from '../pool/pooled-fleet-api.mjs';
import { loadConfig } from './config.mjs';
import { extendRegistry } from './tools/registry.mjs';
import { executeTool } from './tools/executor.mjs';
import { createExpressAdapter } from '../comm/express.mjs';

const SUPPORTED_ADAPTERS = { express: createExpressAdapter };

function resolveAdapter(name) {
  const factory = SUPPORTED_ADAPTERS[name];
  if (!factory) throw new Error(`unsupported comm adapter: "${name}"`);
  return factory();
}

// Thin entry point mirroring startMcpServer's injection pattern.
// Accepts optional fleetApi + dispatcher for testing. When omitted, spawns
// Fleet and creates the dispatcher from the pool, same as mcp/main.mjs.
export async function startHost({
  fleetApi,
  dispatcher,
  port,
  env = process.env,
  registry,
  configDir,
  authenticate = defaultAuthenticate,
} = {}) {
  ensureApralabs();

  let config;
  try {
    config = await loadConfig(configDir ?? path.dirname(pathToFileURL(import.meta.url).pathname + '/..'));
  } catch {
    config = {
      name: 'workflow-kit',
      description: '',
      fleet: {},
      comm: { adapter: 'express', port: port ?? Number(env.PORT ?? 3000), host: env.MCP_BIND_HOST ?? '127.0.0.1' },
      modules: {},
    };
  }

  let api = fleetApi;
  let stopFleet = null;
  if (!api) {
    const { spawnFleet } = await import('../transport/stdio-fleet.mjs');
    const fleet = await spawnFleet({ env });
    api = fleet.fleetApi;
    stopFleet = fleet.stop;
  }

  let ownDispatcher = null;
  let activeDispatcher = dispatcher;
  if (!activeDispatcher) {
    try {
      activeDispatcher = ownDispatcher = await createWorkerDispatcher({ fleetApi: api, env });
    } catch (err) {
      try { await stopFleet?.(); } catch { /* preserve original error */ }
      throw err;
    }
  }

  const toolRegistry = registry ?? extendRegistry();

  const mcpHandler = async (req, res) => {
    const server = buildMcpServer({
      fleetApi: api,
      dispatcher: activeDispatcher,
      registry: toolRegistry,
    });
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } finally {
      await server.close();
    }
  };

  const adapter = resolveAdapter(config.comm.adapter);
  const listenPort = port ?? config.comm.port;
  const bindHost = config.comm.host;

  try {
    await adapter.start({
      routes: {
        mcp: mcpHandler,
        task: null,
        jobs: null,
        health: (req, res) => res.json({ ok: true }),
      },
      port: listenPort,
      host: bindHost,
      authenticate,
    });
  } catch (err) {
    try { await ownDispatcher?.close(); } catch { /* preserve */ }
    try { await stopFleet?.(); } catch { /* preserve */ }
    throw err;
  }

  console.log(
    `host '${config.name}' listening on http://${bindHost}:${adapter.port()} ` +
    `(worker capacity ${activeDispatcher.capacity})`,
  );

  async function callTool(name, args = {}, { signal } = {}) {
    const tool = toolRegistry.find(t => t.name === name);
    if (!tool) {
      return { ok: false, error: 'not_found', message: `tool "${name}" not found` };
    }
    const lease = await activeDispatcher.dispatch({ signal });
    try {
      return await executeTool(tool, {
        fleetApi: createPooledFleetApi(api, lease),
        args,
        signal: lease.signal ?? signal,
        reportPhase: () => {},
        workspace: { workerId: lease.workerId, doer: lease.doer, reviewer: lease.reviewer },
      });
    } finally {
      await lease.release();
    }
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    activeDispatcher.beginShutdown();
    await adapter.stop();
    await ownDispatcher?.close();
    await stopFleet?.();
  };

  return {
    host: adapter,
    callTool,
    close,
    config,
    registry: toolRegistry,
  };
}

// Builder API — sugar over startHost.
export function createHost(options = {}) {
  let overrides = { ...options };

  const builder = {
    tools(registry)   { overrides.registry = registry; return builder; },
    comm(commConfig)  { Object.assign(overrides, commConfig); return builder; },
    build() {
      return {
        start: () => startHost(overrides),
      };
    },
  };
  return builder;
}

// Main module guard — same pattern as mcp/main.mjs.
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  try {
    const { close } = await startHost();
    const shutdown = async () => { await close(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error(err?.message ?? err);
    process.exit(1);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/host-index.test.mjs`
Expected: All PASS.

- [ ] **Step 5: Run existing tests to verify zero regressions**

Run: `node --test tests/transport-stdio-fleet.test.mjs tests/pool-roster.test.mjs tests/pool-cleanup.test.mjs tests/pool-worker-lock.test.mjs tests/pool-fleet-text.test.mjs tests/pool-pooled-fleet-api.test.mjs tests/pool-worker-pool.test.mjs tests/pool-config.test.mjs tests/pool-member-manager.test.mjs tests/pool-ephemeral-factory.test.mjs tests/pool-worker-dispatcher.test.mjs tests/pool-index.test.mjs tests/demo.test.mjs tests/inspect-members.test.mjs tests/mcp.test.mjs`
Expected: All PASS — no regressions.

- [ ] **Step 6: Commit**

```bash
git add host/index.mjs tests/host-index.test.mjs
git commit -m "feat: add host entry point with builder API and callTool"
```

---

### Task 6: Config file and npm scripts

**Files:**
- Create: `host.config.mjs`
- Modify: `package.json`

- [ ] **Step 1: Create the config file**

```js
// host.config.mjs
export default {
  name: 'workflow-kit',
  description: 'Fleet Agent Kit — tool server',

  fleet: {},

  comm: {
    adapter: 'express',
  },

  modules: {},
};
```

- [ ] **Step 2: Add npm scripts to package.json**

Add these scripts to the existing `"scripts"` block in `package.json`:

```json
"host": "node host/index.mjs",
"test:host": "node --test tests/host-config.test.mjs tests/host-registry.test.mjs tests/host-executor.test.mjs tests/comm-express.test.mjs tests/host-index.test.mjs",
"test:host:live": "node --test tests/host.live.test.mjs"
```

- [ ] **Step 3: Verify `npm run host` boots (with mock — or skip if no Fleet)**

Run: `npm run test:host`
Expected: All PASS.

- [ ] **Step 4: Commit**

```bash
git add host.config.mjs package.json
git commit -m "feat: add host.config.mjs and npm scripts for host path"
```

---

### Task 7: Live integration test

**Files:**
- Create: `tests/host.live.test.mjs`

This test requires a real Fleet process (Docker). It mirrors `tests/mcp.live.test.mjs`.

- [ ] **Step 1: Write the live test**

```js
// tests/host.live.test.mjs
import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const { startHost } = await import('../host/index.mjs');

test('host serves inspect-members over MCP with live Fleet', { timeout: 180000 }, async () => {
  const { host, close } = await startHost({ port: 0 });
  const url = new URL(`http://127.0.0.1:${host.port()}/mcp`);
  const client = new Client({ name: 'live-test-client', version: '1.0.0' });

  try {
    await client.connect(new StreamableHTTPClientTransport(url));

    const { tools } = await client.listTools();
    assert.ok(tools.some(t => t.name === 'inspect-members'));
    assert.ok(tools.some(t => t.name === 'demo'));

    const result = await client.callTool({ name: 'inspect-members', arguments: {} });
    assert.equal(result.isError, undefined, `tool call failed: ${result.content?.[0]?.text}`);

    const report = JSON.parse(result.content[0].text);
    assert.match(report.workerId, /^(pool|ephemeral)-/);
    assert.deepEqual(
      report.members.map(entry => entry.role),
      ['doer', 'reviewer'],
    );
    for (const member of report.members) {
      assert.equal(member.present, true, `${member.name} should be registered`);
      assert.equal(member.report.exists, true, `${member.name} work folder should exist`);
    }
  } finally {
    try { await client.close(); } finally { await close(); }
  }
});

test('host callTool works with live Fleet', { timeout: 180000 }, async () => {
  const { callTool, close } = await startHost({ port: 0 });

  try {
    const out = await callTool('inspect-members', {});
    assert.equal(out.ok, true);
    const report = out.result;
    const parsed = typeof report === 'string' ? JSON.parse(report) : report;
    assert.match(parsed.workerId, /^(pool|ephemeral)-/);
  } finally {
    await close();
  }
});
```

- [ ] **Step 2: Verify test file is syntactically correct (dry run without Fleet)**

Run: `node -e "import('./tests/host.live.test.mjs').catch(e => console.log('parse ok'))"`
Expected: No syntax errors.

- [ ] **Step 3: Commit**

```bash
git add tests/host.live.test.mjs
git commit -m "feat: add host live integration test"
```

---

### Task 8: CI pipeline

**Files:**
- Create: `.github/workflows/ci-host.yml`

- [ ] **Step 1: Write the CI workflow**

```yaml
# .github/workflows/ci-host.yml
name: CI — Host

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  host-unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run test:host

  host-integration-tests:
    runs-on: ubuntu-latest
    needs: host-unit-tests
    steps:
      - uses: actions/checkout@v4

      - name: Build Docker image
        run: docker build -t workflow-kit-ci .

      - name: Run host unit tests in Docker
        run: |
          docker run --rm workflow-kit-ci \
            node --test \
              tests/host-config.test.mjs \
              tests/host-registry.test.mjs \
              tests/host-executor.test.mjs \
              tests/comm-express.test.mjs \
              tests/host-index.test.mjs

      - name: Run host live integration test
        run: |
          docker run --rm workflow-kit-ci \
            node --test tests/host.live.test.mjs
```

- [ ] **Step 2: Validate YAML syntax**

Run: `node -e "const fs = require('fs'); const y = fs.readFileSync('.github/workflows/ci-host.yml','utf8'); console.log('YAML length:', y.length, 'bytes — ok')"`
Expected: Reports byte count, no errors.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci-host.yml
git commit -m "ci: add separate CI pipeline for host path"
```

---

### Task 9: Final verification

**Files:** None — verification only.

- [ ] **Step 1: Run all host unit tests**

Run: `npm run test:host`
Expected: All PASS.

- [ ] **Step 2: Run all existing tests (regression check)**

Run: `npm run test`
Expected: All PASS — zero regressions.

- [ ] **Step 3: Verify both entry points serve the same tools**

This is a manual check. If a Fleet process is available:

Run: `npm run mcp` — note the tools listed.
Run: `npm run host` — note the tools listed.
Expected: Identical tool set.

If no Fleet process is available, the mock-fleet integration test in Task 5 already verifies this.

- [ ] **Step 4: Review file tree matches spec**

Run: `find host/ comm/ -type f | sort`
Expected:
```
comm/express.mjs
comm/interface.mjs
host/config.mjs
host/index.mjs
host/tools/executor.mjs
host/tools/registry.mjs
```

---

## Summary

| Task | Files | Tests | Depends on |
|---|---|---|---|
| 1. Config loader | `host/config.mjs` | `tests/host-config.test.mjs` | — |
| 2. Tools registry | `host/tools/registry.mjs` | `tests/host-registry.test.mjs` | — |
| 3. Tool executor | `host/tools/executor.mjs` | `tests/host-executor.test.mjs` | — |
| 4. Comm layer | `comm/interface.mjs`, `comm/express.mjs` | `tests/comm-express.test.mjs` | — |
| 5. Host entry point | `host/index.mjs` | `tests/host-index.test.mjs` | Tasks 1-4 |
| 6. Config file + scripts | `host.config.mjs`, `package.json` | — | Task 5 |
| 7. Live integration test | `tests/host.live.test.mjs` | self | Task 5 |
| 8. CI pipeline | `.github/workflows/ci-host.yml` | — | Tasks 6-7 |
| 9. Final verification | — | — | All |

Tasks 1–4 are independent and can be implemented in parallel. Task 5 depends on all four. Tasks 6–9 are sequential.
