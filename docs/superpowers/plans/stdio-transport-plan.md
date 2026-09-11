# Stdio Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the downstream HTTP/MCP connection to Fleet with spawning `apra-fleet run --transport stdio` as a child process, so workflow runs no longer require a pre-started Fleet server.

**Architecture:** A new `transport/stdio-fleet.mjs` module spawns Fleet via `StdioClientTransport` from `@modelcontextprotocol/client/stdio`, connects an MCP `Client`, registers the member, attaches OAuth, and returns a `fleetApi`-compatible wrapper. Launchers swap `connectFleet()` for `spawnFleet()`. Workflow bodies and the upstream MCP server see the same `fleetApi` interface.

**Tech Stack:** Node ≥ 22.16, ESM, `node --test`, `@modelcontextprotocol/client` (already a devDependency — promote to `dependencies`), `@modelcontextprotocol/client/stdio` subpath for `StdioClientTransport`.

**Spec:** `docs/specs/stdio-transport-spec.md`

## Global Constraints

- Node ≥ 22.16, ESM only (`"type": "module"`). No TypeScript.
- Tests use `node --test` with `node:test` and `node:assert/strict`.
- No new runtime dependencies — `@modelcontextprotocol/client` is already installed (promote from devDependencies to dependencies).
- `StdioClientTransport` is imported from `@modelcontextprotocol/client/stdio` (subpath export, not the main entry).
- The `fleetApi` interface seen by workflow bodies and the MCP server is unchanged.
- Fleet MCP tool names must be discovered at runtime via `client.listTools()` — the wrapper maps camelCase method names to discovered tool names.
- `CLAUDE_CODE_OAUTH_TOKEN` is inherited from the parent environment.
- `APRA_FLEET_BIN` env var overrides the default `apra-fleet` command for non-PATH installs.
- Commit after every task.

---

### Task 1: Promote `@modelcontextprotocol/client` to a runtime dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Move the dependency**

Move `@modelcontextprotocol/client` from `devDependencies` to `dependencies` in `package.json`. The transport module imports it at runtime, not just in tests.

In `package.json`, change from:

```json
  "dependencies": {
    "@modelcontextprotocol/express": "^2.0.0",
    "@modelcontextprotocol/node": "^2.0.0",
    "@modelcontextprotocol/server": "^2.0.0",
    "express": "^5.1.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@modelcontextprotocol/client": "^2.0.0"
  }
```

To:

```json
  "dependencies": {
    "@modelcontextprotocol/client": "^2.0.0",
    "@modelcontextprotocol/express": "^2.0.0",
    "@modelcontextprotocol/node": "^2.0.0",
    "@modelcontextprotocol/server": "^2.0.0",
    "express": "^5.1.0",
    "zod": "^4.4.3"
  }
```

Remove the entire `devDependencies` block (it becomes empty).

- [ ] **Step 2: Reinstall to update lockfile**

Run: `npm install`
Expected: `package-lock.json` updated, no errors.

- [ ] **Step 3: Verify the import resolves**

Run: `node --input-type=module -e "import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'; console.log('ok')"`
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: promote @modelcontextprotocol/client to runtime dependency"
```

---

### Task 2: The `fleetApi` wrapper over an MCP client

**Files:**
- Create: `transport/stdio-fleet.mjs`
- Test: `tests/transport-stdio-fleet.test.mjs`

**Interfaces:**
- Consumes: `Client` from `@modelcontextprotocol/client`, `StdioClientTransport` from `@modelcontextprotocol/client/stdio`.
- Produces: `spawnFleet({ memberName, workFolder, oauthToken?, bin?, env? }) -> Promise<{ fleetApi, stop() }>`.

The `fleetApi` object returned has these methods, each translating to a `client.callTool()` over stdio:
- `fleetApi.executeCommand(opts)` → calls the Fleet tool for executing commands
- `fleetApi.executePrompt(opts)` → calls the Fleet tool for executing prompts
- `fleetApi.listMembers(opts)` → calls the Fleet tool for listing members
- `fleetApi.registerMember(opts)` → calls the Fleet tool for registering a member
- `fleetApi.fleetStatus()` → calls the Fleet tool for server status

The wrapper discovers Fleet's tool names via `client.listTools()` at connect time and maps them by matching against known patterns (`execute_command`, `executeCommand`, etc.).

- [ ] **Step 1: Write the failing test**

```js
// tests/transport-stdio-fleet.test.mjs
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// We test the wrapper logic by mocking the MCP Client. The actual
// StdioClientTransport spawn is tested in the live integration tier.

// createFleetApi is the internal wrapper builder — spawnFleet uses it after
// connecting. We export it separately for unit testing.
const { createFleetApi, FLEET_METHODS } = await import('../transport/stdio-fleet.mjs');

function createMockClient({ tools = [], callResults = {} } = {}) {
  const calls = [];
  return {
    calls,
    async listTools() {
      return { tools: tools.map((name) => ({ name })) };
    },
    async callTool(params) {
      calls.push(params);
      const result = callResults[params.name];
      if (result instanceof Error) throw result;
      return result ?? { content: [{ type: 'text', text: 'ok' }] };
    },
    async close() {},
  };
}

// Fleet's known tool names, as they appear in a real Fleet MCP server.
const FLEET_TOOLS = [
  'execute_command',
  'execute_prompt',
  'list_members',
  'register_member',
  'fleet_status',
  'credential_store_set',
  'provision_llm_auth',
];

test('createFleetApi discovers tool names and maps all five methods', async () => {
  const client = createMockClient({ tools: FLEET_TOOLS });
  const api = await createFleetApi(client);

  await api.executeCommand({ command: 'echo hi', member_name: 'DOER' });
  await api.executePrompt({ prompt: 'hello', member_name: 'DOER' });
  await api.listMembers({});
  await api.registerMember({ friendly_name: 'X', work_folder: '/tmp/x', member_type: 'local' });
  await api.fleetStatus();

  assert.equal(client.calls.length, 5);
  assert.equal(client.calls[0].name, 'execute_command');
  assert.deepEqual(client.calls[0].arguments, { command: 'echo hi', member_name: 'DOER' });
  assert.equal(client.calls[1].name, 'execute_prompt');
  assert.equal(client.calls[2].name, 'list_members');
  assert.equal(client.calls[3].name, 'register_member');
  assert.equal(client.calls[4].name, 'fleet_status');
});

test('createFleetApi normalizes MCP callTool response to content envelope', async () => {
  const client = createMockClient({
    tools: FLEET_TOOLS,
    callResults: {
      fleet_status: { content: [{ type: 'text', text: 'running' }] },
    },
  });
  const api = await createFleetApi(client);
  const result = await api.fleetStatus();
  assert.deepEqual(result, { content: [{ type: 'text', text: 'running' }] });
});

test('createFleetApi passes through structuredContent when present', async () => {
  const client = createMockClient({
    tools: FLEET_TOOLS,
    callResults: {
      execute_command: {
        content: [{ type: 'text', text: 'hello' }],
        structuredContent: { stdout: 'hello', exitCode: 0 },
      },
    },
  });
  const api = await createFleetApi(client);
  const result = await api.executeCommand({ command: 'echo', member_name: 'X' });
  assert.equal(result.structuredContent.stdout, 'hello');
});

test('createFleetApi throws when a required tool is missing from Fleet', async () => {
  const client = createMockClient({ tools: ['fleet_status'] });
  await assert.rejects(
    () => createFleetApi(client),
    (err) => {
      assert.match(err.message, /execute_command/);
      return true;
    },
  );
});

test('createFleetApi propagates callTool errors', async () => {
  const client = createMockClient({
    tools: FLEET_TOOLS,
    callResults: { fleet_status: new Error('child died') },
  });
  const api = await createFleetApi(client);
  await assert.rejects(() => api.fleetStatus(), /child died/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/transport-stdio-fleet.test.mjs`
Expected: FAIL — `Cannot find module '../transport/stdio-fleet.mjs'`

- [ ] **Step 3: Write the implementation**

```js
// transport/stdio-fleet.mjs
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// The five fleetApi methods and the Fleet MCP tool names they map to.
// Names are discovered at connect time via listTools(); these are the
// expected names used for matching.
export const FLEET_METHODS = Object.freeze({
  executeCommand: 'execute_command',
  executePrompt: 'execute_prompt',
  listMembers: 'list_members',
  registerMember: 'register_member',
  fleetStatus: 'fleet_status',
});

// Build a fleetApi-compatible wrapper from a connected MCP Client.
// Exported for unit testing; spawnFleet() calls it after connecting.
export async function createFleetApi(client) {
  const { tools } = await client.listTools();
  const available = new Set(tools.map((t) => t.name));

  // Verify every required tool is present.
  const missing = Object.values(FLEET_METHODS).filter((name) => !available.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Fleet MCP server is missing required tools: ${missing.join(', ')}. ` +
        `Available: ${[...available].join(', ')}`,
    );
  }

  function call(toolName, args = {}) {
    return client.callTool({ name: toolName, arguments: args });
  }

  return {
    executeCommand(opts) { return call(FLEET_METHODS.executeCommand, opts); },
    executePrompt(opts) { return call(FLEET_METHODS.executePrompt, opts); },
    listMembers(opts) { return call(FLEET_METHODS.listMembers, opts); },
    registerMember(opts) { return call(FLEET_METHODS.registerMember, opts); },
    fleetStatus() { return call(FLEET_METHODS.fleetStatus); },
  };
}

// Spawn apra-fleet as a child process over stdio, connect an MCP client,
// register the member, attach OAuth, and return a ready fleetApi.
export async function spawnFleet({
  memberName,
  workFolder,
  oauthToken,
  bin,
  env = process.env,
} = {}) {
  const command = bin ?? env.APRA_FLEET_BIN ?? 'apra-fleet';
  const token = oauthToken ?? env.CLAUDE_CODE_OAUTH_TOKEN;

  const childEnv = { ...env };
  if (token) childEnv.CLAUDE_CODE_OAUTH_TOKEN = token;

  const transport = new StdioClientTransport({
    command,
    args: ['run', '--transport', 'stdio'],
    env: childEnv,
    stderr: 'inherit',
  });

  const client = new Client({ name: 'workflow-kit', version: '1.0.0' });

  let connected = false;
  try {
    await client.connect(transport);
    connected = true;

    const fleetApi = await createFleetApi(client);

    // Register the member.
    if (memberName && workFolder) {
      await fleetApi.registerMember({
        friendly_name: memberName,
        work_folder: workFolder,
        member_type: 'local',
      });
    }

    // Attach OAuth if a token is available. The token was passed to the child
    // via env, and provision_llm_auth copies the local OAuth session.
    if (memberName && token) {
      try {
        await client.callTool({
          name: 'provision_llm_auth',
          arguments: { member_name: memberName },
        });
      } catch (err) {
        console.warn(`[stdio-fleet] OAuth provisioning failed for ${memberName}: ${err.message}`);
      }
    }

    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      try { await client.close(); } catch { /* best effort */ }
      try { await transport.close(); } catch { /* best effort */ }
    };

    return { fleetApi, stop };
  } catch (err) {
    if (connected) {
      try { await client.close(); } catch { /* best effort */ }
    }
    try { await transport.close(); } catch { /* best effort */ }
    throw err;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/transport-stdio-fleet.test.mjs`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add transport/stdio-fleet.mjs tests/transport-stdio-fleet.test.mjs
git commit -m "feat: add stdio Fleet transport with fleetApi wrapper"
```

---

### Task 3: Wire the demo workflow launcher to use stdio

**Files:**
- Modify: `workflows/demo/main.mjs` (replace lines 10-44)

**Interfaces:**
- Consumes: `spawnFleet` from Task 2; `FleetWorkflow` / `WorkflowEngine` from `@apralabs`.
- Produces: `runDemo({ fleetApi, signal, reportPhase }) -> Promise<result>` — same signature, but when no `fleetApi` is injected, spawns Fleet over stdio instead of connecting over HTTP.

- [ ] **Step 1: Rewrite the launcher**

Replace the entire `runDemo` function in `workflows/demo/main.mjs` (lines 10-44) with:

```js
export async function runDemo({ fleetApi, signal, reportPhase } = {}) {
  ensureApralabs();
  const { FleetWorkflow } = await import('@apralabs/apra-fleet-workflow');
  const { WorkflowEngine } = await import('@apralabs/apra-fleet-workflow/engine');

  let api = fleetApi;
  let stop = null;
  if (!api) {
    const { spawnFleet } = await import('../../transport/stdio-fleet.mjs');
    const repoRoot = path.resolve(here, '../..');
    const fleet = await spawnFleet({
      memberName: 'DEMO-DOER',
      workFolder: path.join(repoRoot, 'workdir', 'DEMO-DOER'),
    });
    api = fleet.fleetApi;
    stop = fleet.stop;
  }

  try {
    const workflow = new FleetWorkflow(api);
    const engine = new WorkflowEngine(workflow);
    return await engine.executeFile(engineScript, { fleetApi: api, signal, reportPhase });
  } finally {
    await stop?.();
  }
}
```

Key changes:
- Removed `APRA_FLEET_TRANSPORT` env forcing (lines 14-16 gone).
- Removed `connectFleet` import and its try/catch block.
- Replaced with `spawnFleet()` import and call.
- `stop()` replaces `transport?.stop()` in the finally block.

- [ ] **Step 2: Run the existing tests to verify they still pass**

Run: `node --test tests/demo.test.mjs`
Expected: PASS — mock tests inject `fleetApi` directly, so the stdio path is never hit. The mock tests must still pass unchanged.

- [ ] **Step 3: Commit**

```bash
git add workflows/demo/main.mjs
git commit -m "feat: wire demo launcher to spawn Fleet over stdio"
```

---

### Task 4: Remove registration logic from `demo.js`

**Files:**
- Modify: `workflows/demo/demo.js` (delete lines 7-57, 72-76)

**Interfaces:**
- Consumes: `fleetApi`, engine context (`phase`, `command`, `transform`, `agent`, `log`, `args`).
- Produces: Same result shape `{ command, transform, agent }` — minus the registration phase.

- [ ] **Step 1: Rewrite the workflow body**

Replace the entire contents of `workflows/demo/demo.js` with:

```js
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const meta = { name: 'demo' };

const DUMMY_PY = fileURLToPath(new URL('./dummy.py', import.meta.url));

function toolText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  const parts = result.content ?? [];
  if (parts.length > 0) {
    return parts.map((part) => part.text ?? '').join('\n');
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

export async function main(context) {
  const { phase, command, transform, agent, log, args } = context;
  const fleetApi = args.fleetApi;
  if (!fleetApi) {
    throw new Error('demo.js requires args.fleetApi');
  }
  const signal = args.signal;
  const reportPhase = args.reportPhase ?? (() => {});
  const cancelled = () => signal?.aborted === true;

  phase('status');
  await reportPhase('reading fleet status');
  log(toolText(await fleetApi.fleetStatus()));
  if (cancelled()) return { cancelled: true };

  phase('python command');
  await reportPhase('running the python command');
  const cmdResult = await command(`python3 "${DUMMY_PY}"`, {
    member_name: 'DEMO-DOER',
    failSoft: true,
  });
  log(`command result: ${typeof cmdResult === 'string' ? cmdResult : JSON.stringify(cmdResult)}`);
  if (cancelled()) return { cancelled: true, command: cmdResult };

  phase('transform returns value');
  await reportPhase('running the transform');
  const payload = await transform('dummy payload', () => ({ ok: true, source: 'transform' }));
  log(`transform result: ${JSON.stringify(payload)}`);
  if (cancelled()) return { cancelled: true, command: cmdResult, transform: payload };

  phase('agent smoke');
  await reportPhase('dispatching the agent prompt');
  if (cancelled()) return { cancelled: true, command: cmdResult, transform: payload };
  const reply = await agent('Reply with exactly: pong', { member_name: 'DEMO-DOER' });
  log(`agent result: ${reply}`);

  return { command: cmdResult, transform: payload, agent: reply };
}
```

Changes from the original:
- Deleted `DOER`, `REVIEWER`, `DOER_WORK`, `REVIEWER_WORK` constants (lines 7-13).
- Deleted `memberListedInStatus`, `memberPresent`, `ensureMember` functions (lines 29-57).
- Deleted the registration phase (lines 72-76).
- The `status` phase no longer checks member presence — it just logs Fleet status.
- Phase count drops from 5 to 4 (no registration phase).

- [ ] **Step 2: Update the demo test to match**

The existing test (`tests/demo.test.mjs`) asserts registration behavior that no longer exists. Replace the entire file with:

```js
import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { runDemo } = await import('../workflows/demo/main.mjs');

const dummyPy = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../workflows/demo/dummy.py',
);

function createMockFleetApi() {
  const commandCalls = [];
  const promptCalls = [];

  return {
    commandCalls,
    promptCalls,
    async fleetStatus() {
      return { content: [{ type: 'text', text: 'fleet server: running' }] };
    },
    async executeCommand(options) {
      commandCalls.push(options);
      return {
        content: [{ type: 'text', text: 'hello-from-python' }],
        structuredContent: { stdout: 'hello-from-python', exitCode: 0 },
      };
    },
    async executePrompt(options) {
      promptCalls.push(options);
      return {
        content: [{ type: 'text', text: 'pong' }],
        structuredContent: { response: 'pong' },
      };
    },
  };
}

test('runDemo runs python command, transform, and agent smoke test', async () => {
  const fleetApi = createMockFleetApi();

  const result = await runDemo({ fleetApi });
  assert.match(String(result.command?.output ?? result.command), /hello-from-python/);
  assert.deepEqual(result.transform, { ok: true, source: 'transform' });
  assert.match(String(result.agent?.response ?? result.agent), /\bpong\b/i);

  assert.equal(fleetApi.commandCalls.length, 1);
  const cmd = fleetApi.commandCalls[0].command;
  assert.match(cmd, /python3/);
  assert.ok(cmd.includes(dummyPy), `expected dummy.py path, got: ${cmd}`);

  assert.ok(fleetApi.promptCalls.length >= 1, 'executePrompt should be invoked');
});

test('the workflow does not register members', async () => {
  const fleetApi = createMockFleetApi();
  // fleetApi has no registerMember — if demo.js tried to call it, it would throw.
  await runDemo({ fleetApi });
});

test('an aborted signal prevents the agent phase from spending tokens', async () => {
  const fleetApi = createMockFleetApi();
  const controller = new AbortController();
  controller.abort();

  const result = await runDemo({ fleetApi, signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.equal(fleetApi.promptCalls.length, 0, 'executePrompt must not run after abort');
});

test('aborting on the final progress notification prevents the agent call', async () => {
  const fleetApi = createMockFleetApi();
  const controller = new AbortController();

  const result = await runDemo({
    fleetApi,
    signal: controller.signal,
    reportPhase(message) {
      if (message === 'dispatching the agent prompt') controller.abort();
    },
  });

  assert.equal(result.cancelled, true);
  assert.equal(fleetApi.promptCalls.length, 0, 'executePrompt must not run after final progress');
});

test('reportPhase receives one message per phase and is optional', async () => {
  const phases = [];
  await runDemo({
    fleetApi: createMockFleetApi(),
    reportPhase: (message) => phases.push(message),
  });
  assert.ok(phases.length >= 4, `expected a message per phase, got ${phases.length}`);

  // Omitting reportPhase must not throw.
  await runDemo({ fleetApi: createMockFleetApi() });
});
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `node --test tests/demo.test.mjs`
Expected: PASS, 5 tests

- [ ] **Step 4: Commit**

```bash
git add workflows/demo/demo.js tests/demo.test.mjs
git commit -m "refactor: remove registration from demo.js — spawnFleet owns it"
```

---

### Task 5: Wire the MCP server launcher to use stdio

**Files:**
- Modify: `mcp/main.mjs` (replace lines 7-32)

**Interfaces:**
- Consumes: `spawnFleet` from Task 2; `buildMcpServer` from `mcp/server.mjs`.
- Produces: `startMcpServer({ fleetApi, port }) -> Promise<{ server, close }>` — same signature.

- [ ] **Step 1: Rewrite the MCP launcher**

Replace the `startMcpServer` function in `mcp/main.mjs` (lines 7-74) with:

```js
export async function startMcpServer({ fleetApi, port } = {}) {
  ensureApralabs();

  let api = fleetApi;
  let stopFleet = null;
  if (!api) {
    const { spawnFleet } = await import('../transport/stdio-fleet.mjs');
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const fleet = await spawnFleet({
      memberName: 'DEMO-DOER',
      workFolder: path.join(repoRoot, 'workdir', 'DEMO-DOER'),
    });
    api = fleet.fleetApi;
    stopFleet = fleet.stop;
  }

  const app = createMcpHttpApp({ buildServer: () => buildMcpServer({ fleetApi: api }) });
  const listenPort = port ?? Number(process.env.PORT ?? 3000);
  const bindHost = process.env.MCP_BIND_HOST || '127.0.0.1';
  let server;
  try {
    server = app.listen(listenPort, bindHost);
    await new Promise((resolve, reject) => {
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      const onError = (err) => {
        server.off('listening', onListening);
        reject(err);
      };
      server.once('listening', onListening);
      server.once('error', onError);
    });
  } catch (err) {
    if (server) {
      try {
        await new Promise((resolve) => server.close(() => resolve()));
      } catch {
        // Preserve the listener error after best-effort HTTP cleanup.
      }
    }
    try {
      await stopFleet?.();
    } catch {
      // Preserve the listener error after best-effort Fleet cleanup.
    }
    throw err;
  }
  console.log(`MCP server listening on http://${bindHost}:${server.address().port}/mcp`);

  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    await stopFleet?.();
  };
  return { server, close };
}
```

Add the missing `path` and `fileURLToPath` imports at the top if not already present:

```js
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
```

Key changes:
- Removed `APRA_FLEET_TRANSPORT` env forcing.
- Removed `connectFleet` import and its try/catch.
- Replaced with `spawnFleet()` import and call.
- `stopFleet()` replaces `transport?.stop()`.

- [ ] **Step 2: Run the MCP test to verify it still passes**

Run: `node --test tests/mcp.test.mjs`
Expected: PASS — the MCP tests inject `fleetApi` via `createMockFleetApi()`, so `spawnFleet` is never called.

- [ ] **Step 3: Commit**

```bash
git add mcp/main.mjs
git commit -m "feat: wire MCP server launcher to spawn Fleet over stdio"
```

---

### Task 6: Update the MCP test mock and inspect-members test

**Files:**
- Modify: `tests/mcp.test.mjs` (update `createMockFleetApi` — remove `registerMember` dependency from `fleetStatus`)
- Modify: `tests/inspect-members.test.mjs` (if it depends on `connectFleet`)
- Modify: `workflows/inspect-members/main.mjs` (replace `connectFleet` with `spawnFleet`)

**Interfaces:**
- Consumes: `spawnFleet` from Task 2.
- Produces: `runInspectMembers({ fleetApi, ... })` — same interface, stdio when no `fleetApi` injected.

- [ ] **Step 1: Update the inspect-members launcher**

Replace the `runInspectMembers` function in `workflows/inspect-members/main.mjs` (lines 12-65) with:

```js
export async function runInspectMembers({
  fleetApi,
  members,
  includeFiles,
  signal,
  reportPhase,
} = {}) {
  ensureApralabs();
  const { FleetWorkflow } = await import('@apralabs/apra-fleet-workflow');
  const { WorkflowEngine } = await import('@apralabs/apra-fleet-workflow/engine');

  let api = fleetApi;
  let stop = null;
  if (!api) {
    const { spawnFleet } = await import('../../transport/stdio-fleet.mjs');
    const fleet = await spawnFleet({});
    api = fleet.fleetApi;
    stop = fleet.stop;
  }

  try {
    const workflowApi = {
      executeCommand(options) {
        Object.defineProperty(options, 'failSoft', { value: true, enumerable: false });
        return api.executeCommand(options);
      },
    };
    const workflow = new FleetWorkflow(workflowApi);
    const engine = new WorkflowEngine(workflow);
    return await engine.executeFile(engineScript, {
      fleetApi: api,
      members,
      includeFiles,
      signal,
      reportPhase,
    });
  } finally {
    await stop?.();
  }
}
```

Key changes:
- Removed `APRA_FLEET_TRANSPORT` env forcing.
- Removed `connectFleet` import and its try/catch.
- Replaced with `spawnFleet()` — no member registration needed since inspect-members doesn't register.

- [ ] **Step 2: Update the MCP test mock**

In `tests/mcp.test.mjs`, the `createMockFleetApi` function (lines 13-43) derives `fleetStatus` from `registerCalls`. Since demo.js no longer registers, `fleetStatus` should return a fixed response. Replace lines 25-29:

```js
    async fleetStatus() {
      return {
        content: [{ type: 'text', text: 'fleet server: running' }],
      };
    },
```

Also remove `registerCalls` from the mock since nothing calls `registerMember` anymore:

```js
function createMockFleetApi() {
  const commandCalls = [];
  const promptCalls = [];
  return {
    commandCalls,
    promptCalls,
    async fleetStatus() {
      return {
        content: [{ type: 'text', text: 'DEMO-DOER\nDEMO-REVIEWER' }],
      };
    },
    async executeCommand(options) {
      commandCalls.push(options);
      const payload = JSON.stringify({ root: '/tmp/x', exists: true, fileCount: 1, totalBytes: 4 });
      return {
        content: [{ type: 'text', text: payload }],
        structuredContent: { stdout: payload, exitCode: 0 },
      };
    },
    async executePrompt(options) {
      promptCalls.push(options);
      return { content: [{ type: 'text', text: 'pong' }], structuredContent: { response: 'pong' } };
    },
  };
}
```

Note: keep `DEMO-DOER\nDEMO-REVIEWER` in `fleetStatus` because `inspect-members.js` still checks for member names there.

- [ ] **Step 3: Run all tests**

Run: `node --test tests/demo.test.mjs tests/inspect-members.test.mjs tests/mcp.test.mjs`
Expected: PASS

- [ ] **Step 4: Update the test script in package.json**

Add the new transport test to the test script:

```json
"test": "node --test tests/transport-stdio-fleet.test.mjs tests/demo.test.mjs tests/inspect-members.test.mjs tests/mcp.test.mjs"
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, all test files

- [ ] **Step 6: Commit**

```bash
git add workflows/inspect-members/main.mjs tests/mcp.test.mjs package.json
git commit -m "refactor: wire inspect-members and MCP tests to stdio transport"
```

---

### Task 7: Add `.gitignore` entry and clean up dead code

**Files:**
- Modify: `.gitignore` (add `transport/` temp files if any)
- Verify: no remaining references to `connectFleet` or `APRA_FLEET_TRANSPORT` forcing

- [ ] **Step 1: Search for dead references**

Run:
```bash
grep -rn "connectFleet\|APRA_FLEET_TRANSPORT" --include="*.mjs" --include="*.js" .
```

Expected: zero matches outside `node_modules/`. If any remain, update them.

- [ ] **Step 2: Verify the transport directory is tracked**

Run: `git status`
Expected: `transport/stdio-fleet.mjs` is tracked from Task 2's commit.

- [ ] **Step 3: Run the full test suite one final time**

Run: `npm test`
Expected: PASS, all test files

- [ ] **Step 4: Commit any cleanup**

```bash
git add -A
git commit -m "chore: remove dead connectFleet references"
```

Skip this commit if there's nothing to clean up.

---

### Task 8: Live integration test (optional — requires `apra-fleet` binary)

**Files:**
- Create: `tests/stdio-fleet.live.test.mjs`

This test spawns a real Fleet process over stdio. It is gated on the binary being available and skips gracefully otherwise.

- [ ] **Step 1: Write the live test**

```js
// tests/stdio-fleet.live.test.mjs
import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Skip the entire file if apra-fleet is not installed.
let fleetBin;
try {
  fleetBin = execSync('which apra-fleet', { encoding: 'utf8' }).trim();
} catch {
  try {
    const home = os.homedir();
    const candidate = path.join(home, '.apra-fleet', 'bin', 'apra-fleet');
    if (fs.existsSync(candidate)) {
      fleetBin = candidate;
    }
  } catch { /* skip */ }
}

if (!fleetBin) {
  test('live stdio tests skipped — apra-fleet not found', { skip: 'apra-fleet binary not installed' }, () => {});
} else {
  const { spawnFleet } = await import('../transport/stdio-fleet.mjs');

  test('spawnFleet connects to a real Fleet process and calls fleetStatus', async () => {
    const workFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'stdio-live-'));
    const { fleetApi, stop } = await spawnFleet({
      memberName: 'LIVE-TEST',
      workFolder,
      bin: fleetBin,
    });
    try {
      const status = await fleetApi.fleetStatus();
      assert.ok(status.content, 'fleetStatus should return a content envelope');
      assert.ok(status.content.length > 0, 'fleetStatus content should not be empty');
    } finally {
      await stop();
      fs.rmSync(workFolder, { recursive: true, force: true });
    }
  });

  test('spawnFleet registers a member and lists it', async () => {
    const workFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'stdio-live-'));
    const { fleetApi, stop } = await spawnFleet({
      memberName: 'LIVE-MEMBER',
      workFolder,
      bin: fleetBin,
    });
    try {
      const result = await fleetApi.listMembers({});
      const text = result.content.map((p) => p.text).join('\n');
      assert.ok(text.includes('LIVE-MEMBER'), `expected LIVE-MEMBER in: ${text}`);
    } finally {
      await stop();
      fs.rmSync(workFolder, { recursive: true, force: true });
    }
  });
}
```

- [ ] **Step 2: Run the live test**

Run: `node --test tests/stdio-fleet.live.test.mjs`
Expected: PASS if `apra-fleet` is installed, SKIP otherwise.

- [ ] **Step 3: Commit**

```bash
git add tests/stdio-fleet.live.test.mjs
git commit -m "test: add live integration tests for stdio Fleet transport"
```
