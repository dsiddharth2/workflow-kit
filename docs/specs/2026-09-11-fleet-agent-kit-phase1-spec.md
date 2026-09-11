# Fleet Agent Kit — Phase 1: Mandatory Core + Config

Status: proposed
Parent spec: `2026-09-09-fleet-agent-kit-spec.md`

## Goal

Build the foundational architecture of the Fleet Agent Kit alongside the
existing MCP server. Phase 1 delivers: a config-driven host entry point, an
extended tools registry, a tool executor, and a swappable communication layer
with named route slots. The existing `mcp/` code path is untouched — `npm run
mcp` continues to work exactly as before. A new `npm run host` boots the same
server through the new architecture.

After Phase 1, Phase 2 (run loop, budgets, guardrails) and Phase 4 (dispatch,
Azure Functions adapter) plug into the structure without architectural changes.

## Naming

The entry point is `createHost()`, not `createAgent()`. A host serves tools and
manages infrastructure — Fleet transport, worker pool, comm adapter. The word
"agent" implies autonomy (taking a task, planning, executing), which arrives in
Phase 2 with the run loop. Phase 2 may introduce a `createAgent()` that wraps
`createHost()` with a run loop, or it may add `.runLoop()` to the host builder.
That decision is deferred.

## Decisions

These decisions were made during the design process and are not open for
revisitation in implementation.

| Decision | Choice | Rationale |
|---|---|---|
| Pool layer relationship | Pool stays as-is, host wraps it | Zero risk to working infrastructure. `host/index.mjs` creates a `WorkerDispatcher` the same way `mcp/main.mjs` does. |
| Migration strategy | Build alongside, don't touch `mcp/` | Both entry points coexist. `mcp/main.mjs` is untouched. Zero risk to the working system. |
| Config schema scope | Full schema defined, Phase 1 fields active | All module slots are in the schema. Phase 1 validates and loads only mandatory fields. Future phases enable their sections — no schema changes needed. |
| Tools registry | Import and extend | `host/tools/registry.mjs` imports `defaultRegistry` from `mcp/registry.mjs` and wraps each entry with extended fields. No duplication of tool definitions. |
| Entry point naming | `createHost()` | A host serves tools. "Agent" implies autonomy that doesn't exist until Phase 2. Honest naming avoids confusing developers. |
| Comm handler contract | Raw `(req, res)` | The MCP SDK's `NodeStreamableHTTPServerTransport.handleRequest()` expects raw Express-compatible `(req, res)`. Normalizing and denormalizing would be pointless indirection. |
| Comm route structure | Named route slots | Adapter accepts `{ mcp, task, jobs, health }`. Null routes are not mounted. Phase 2 plugs in `task`, Phase 4 plugs in `jobs`. Adapter code never changes across phases. |
| CI | Separate pipeline | New `.github/workflows/ci-host.yml` mirrors `ci.yml`. Existing CI untouched. |

## Architecture overview

Two abstractions, orthogonal:

**Comm adapter** = which HTTP framework (deployment shape):
- Express (Phase 1)
- Azure Functions (Phase 4)
- raw-http (Phase 4)

**Ingress paths** = how requests arrive (protocol):
- `POST /mcp` — MCP protocol, tool calls from Claude Code / other agents
- `POST /task` — chat/task submission, natural language → run loop (Phase 2)
- `GET /jobs/:id` — job status for queued tasks (Phase 4)
- `GET /health` — health check

The adapter is the framework; the ingress paths are the routes. MCP rides on
Express. MCP also rides on Azure Functions. REST API rides on Express. REST API
also rides on Azure Functions.

```
Comm adapter (Express / Azure Functions / raw-http)
  ├── POST /mcp          ← MCP protocol handler (mcp/server.mjs)
  ├── POST /task          ← Chat/task submission (Phase 2, needs run loop)
  ├── GET  /jobs/:id      ← Job status (Phase 4, needs dispatch)
  └── GET  /health        ← Health check
```

---

## Directory structure

### New files

```
workflow-kit/
  host.config.mjs                ← host configuration
  host/
    index.mjs                    ← createHost() entry point, lifecycle orchestrator
    config.mjs                   ← config loader + schema validator
    tools/
      registry.mjs               ← imports mcp/registry, wraps with extended fields
      executor.mjs               ← call tool, validate inputs, return error-as-value
  comm/
    interface.mjs                ← adapter contract definition
    express.mjs                  ← Express adapter (extracted from mcp/http.mjs)
  tests/
    host-config.test.mjs
    host-registry.test.mjs
    host-executor.test.mjs
    comm-express.test.mjs
    host-index.test.mjs          ← integration (mock fleet)
    host.live.test.mjs           ← integration (real fleet, Docker)
  .github/
    workflows/
      ci-host.yml                ← separate CI pipeline
```

### Untouched files

```
  pool/                          ← all 11 files unchanged
  transport/stdio-fleet.mjs      ← unchanged
  workflows/                     ← unchanged
  mcp/                           ← all files unchanged
    main.mjs                       (continues to work as legacy entry point)
    server.mjs                     (reads from whatever registry is passed in)
    http.mjs                       (continues to serve the mcp/main.mjs path)
    registry.mjs                   (canonical tool definitions, imported by host/)
    auth.mjs                       (unchanged, injected into comm adapter)
    fleet-text.mjs                 (unchanged)
  .github/workflows/ci.yml      ← unchanged
```

---

## Module specifications

### 1. Config loader and validator (`host/config.mjs`)

Reads `host.config.mjs` from the project root. Falls back to
`host.config.json`. If neither exists, throws with a clear message.

#### Config schema

```js
// host.config.mjs
export default {
  // === MANDATORY (validated, hard error if missing) ===
  name: 'invoice-matcher',           // non-empty string
  description: 'optional description',

  fleet: {},                         // required object, can be empty in Phase 1

  comm: {
    adapter: 'express',              // required: 'express' (Phase 1 only)
    port: 3000,                      // default: Number(process.env.PORT ?? 3000)
    host: '127.0.0.1',              // default: process.env.MCP_BIND_HOST ?? '127.0.0.1'
  },

  // === OPTIONAL (accepted, not loaded in Phase 1) ===
  modules: {
    runLoop:    { enabled: false },
    memory:     {
      workingContext: { enabled: false },
      runState: { enabled: false },
      longTerm: { enabled: false },
    },
    budgets:    { enabled: false },
    guardrails: { enabled: false },
    evals:      { enabled: false },
    dispatch:   { enabled: false },
  },
}
```

#### Validation rules

- `name` — required, non-empty string. Hard error if missing.
- `fleet` — required object. Can be empty in Phase 1. Hard error if missing.
- `comm` — required object. Hard error if missing.
- `comm.adapter` — required, must be `'express'` in Phase 1. Hard error if
  unsupported adapter.
- `comm.port` — optional, defaults to `Number(process.env.PORT ?? 3000)`.
- `comm.host` — optional, defaults to `process.env.MCP_BIND_HOST ?? '127.0.0.1'`.
- `modules` — optional object. Unknown keys log a warning.
- Any module with `enabled: true` that is not implemented in Phase 1 logs a
  warning: `"runLoop enabled but not implemented in this version — ignored"`.
- Module dependency warnings from the parent spec (e.g. budgets enabled but
  runLoop disabled) are checked and logged as warnings, not errors.

#### Loader behaviour

1. Resolve `host.config.mjs` from the project root (via dynamic `import()`),
   fall back to `host.config.json` (via `fs.readFile` + `JSON.parse`).
2. If neither exists, throw: `"host.config.mjs (or .json) not found in <dir>"`.
3. Validate against schema. Throw on mandatory field violations.
4. Merge env overrides (`PORT`, `MCP_BIND_HOST`) as defaults (config values win).
5. Return a frozen config object.

---

### 2. Extended tools registry (`host/tools/registry.mjs`)

Imports `defaultRegistry` from `mcp/registry.mjs` and wraps each entry with the
extended fields specified in the parent spec.

#### Extended fields

| Field | Type | Default | Purpose |
|---|---|---|---|
| `reversible` | `boolean` | `true` | Guardrails classify actions by this flag (Phase 2). |
| `timeout` | `number` | `300000` (5 min) | Per-tool wall-clock cap in ms. Executor enforces. |
| `retryable` | `boolean` | `false` | Whether the run loop may retry on failure (Phase 2). |
| `tags` | `string[]` | `[]` | Grouping for evals and reporting (Phase 3). |

#### Behaviour

```js
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

No tool definitions are duplicated. `mcp/registry.mjs` remains the single source
of truth for tool `name`, `description`, `inputSchema`, `annotations`, and
`run()`. Tool authors who want to set `reversible: false` do so in
`mcp/registry.mjs` (the existing file) and the extended registry picks it up.

---

### 3. Tool executor (`host/tools/executor.mjs`)

The single place a tool's `run()` is called on the host path. Wraps execution
with input validation, timeout enforcement, and error-as-value semantics.

#### Contract

```js
async function executeTool(tool, { fleetApi, args, signal, ...rest })
  → { ok: true, result }
  | { ok: false, error: string, message?: string, details?: object }
```

Never throws. The caller decides what to do with errors.

#### Behaviour

1. **Input validation.** If the tool has `inputSchema`, validate `args` against
   it via `inputSchema.safeParse(args)`. If validation fails, return
   `{ ok: false, error: 'validation_failed', details: parseError }`.

2. **Timeout enforcement.** Create `AbortSignal.timeout(tool.timeout)`. If the
   caller passed a `signal`, merge both via `AbortSignal.any([signal, timeoutSignal])`.
   Pass the merged signal to `tool.run()`.

3. **Execute.** Call `tool.run({ fleetApi, args, signal: mergedSignal, ...rest })`.

4. **Error handling.** If `run()` throws:
   - `AbortError` → `{ ok: false, error: 'timeout', message: 'exceeded <N>ms' }`
   - Any other error → `{ ok: false, error: 'tool_error', message: err.message }`

#### Relationship to `mcp/server.mjs`

The executor is a new consumer. In Phase 1, `mcp/server.mjs` continues to call
`entry.run()` directly through the existing path. The executor serves
`host/index.mjs`'s `callTool()` method, and later the run loop (Phase 2) and
eval harness (Phase 3). The two paths coexist.

---

### 4. Communication layer

#### Adapter contract (`comm/interface.mjs`)

Every adapter implements:

```js
{
  async start({ routes, port, host, authenticate }),
  async stop(),
}
```

Where `routes` is:

```js
{
  mcp:    async (req, res) => {},   // POST /mcp — MCP protocol
  task:   async (req, res) => {},   // POST /task — task submission (Phase 2)
  jobs:   async (req, res) => {},   // GET /jobs/:id — job status (Phase 4)
  health: async (req, res) => {},   // GET /health — health check
}
```

Null routes are not mounted — no 404, just absent. The adapter never knows what
the handlers do. It provides the HTTP framework; the handlers provide the logic.

`authenticate` is an Express-compatible middleware function. `host/index.mjs`
imports it from `mcp/auth.mjs` (the existing pass-through stub). The same
injection pattern applies: swap by providing a different function, not by editing
the auth file.

#### Express adapter (`comm/express.mjs`)

Extracted from the `mcp/http.mjs` pattern. Uses `createMcpExpressApp()` from
`@modelcontextprotocol/express` for DNS rebinding protection.

```js
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
        server.once('listening', () => { server.off('error', reject); resolve(); });
        server.once('error', (err) => { server.off('listening', resolve); reject(err); });
      });
    },

    async stop() {
      if (!server) return;
      await new Promise(resolve => server.close(resolve));
    },
  };
}
```

#### Adapter resolution

`host/index.mjs` resolves the adapter from config:

```js
function resolveAdapter(adapterName) {
  switch (adapterName) {
    case 'express': return createExpressAdapter();
    default: throw new Error(`unsupported comm adapter: ${adapterName}`);
  }
}
```

Phase 4 adds cases for `'azure-functions'` and `'raw-http'`.

---

### 5. Host entry point and lifecycle (`host/index.mjs`)

#### Builder API

```js
import { createHost } from './host/index.mjs';

const host = createHost()         // reads host.config.mjs
  .tools(myCustomRegistry)        // optional override
  .comm({ port: 4000 })           // optional override
  .build();

await host.start();               // boots fleet, pool, adapter — listening
await host.stop();                 // graceful shutdown
```

`createHost()` reads config. Builder methods override config values. `.build()`
validates the final configuration and returns a host instance.

#### Host instance

```js
{
  async start(),                  // boot fleet → pool → adapter. Listening.
  async stop(),                   // adapter stop → dispatcher close → fleet stop
  async callTool(name, args, { signal } = {}),  // direct tool call via executor
  config,                         // frozen config object (read-only)
  registry,                       // extended tool list (read-only)
}
```

`callTool()` leases a worker from the dispatcher, calls the tool through the
executor (validation, timeout, error-as-value), releases the lease. Same
lifecycle as the MCP path but without MCP protocol overhead. Returns the
executor's result shape: `{ ok, result }` or `{ ok, error, message }`.

#### Boot sequence

```
host.config.mjs loaded and validated (host/config.mjs)
  │
  ▼
Fleet transport spawned (transport/stdio-fleet.mjs — same as mcp/main.mjs)
  │
  ▼
Worker dispatcher created (pool/index.mjs — same as mcp/main.mjs)
  │
  ▼
Tools registry loaded and extended (host/tools/registry.mjs)
  │
  ▼
MCP server builder wired (mcp/server.mjs — gets fleetApi + dispatcher + registry)
  │
  ▼
Comm adapter resolved from config
  │
  ▼
Adapter starts with route map:
  mcp:    handler that creates MCP server per request (same as mcp/http.mjs)
  task:   null (Phase 2)
  jobs:   null (Phase 4)
  health: returns { ok: true }
  │
  ▼
Console: "host '<name>' listening on http://<host>:<port> (worker capacity N)"
  │
  ▼
SIGINT/SIGTERM → graceful shutdown
```

#### Direct mapping from `mcp/main.mjs`

Every step in `mcp/main.mjs` has a counterpart in `host/index.mjs`:

| `mcp/main.mjs` | `host/index.mjs` |
|---|---|
| `spawnFleet()` | `spawnFleet()` — identical |
| `createWorkerDispatcher({ fleetApi })` | `createWorkerDispatcher({ fleetApi })` — identical |
| `buildMcpServer({ fleetApi, dispatcher, registry })` | `buildMcpServer({ fleetApi, dispatcher, registry })` — identical |
| `createMcpHttpApp({ buildServer })` then `app.listen()` | `createExpressAdapter().start({ routes, port, host })` — **this is the change** |
| SIGINT → `close()` | SIGINT → `stop()` — identical logic |

Step 4 is the only real difference. Instead of `mcp/http.mjs` hardwiring Express
with the route and handler baked in, the comm adapter receives the handler
function from outside. Everything else — fleet spawn, worker pool creation, MCP
server building — is the same code, same imports, same pool module.

#### `npm run host` script

```json
"host": "node host/index.mjs"
```

When run as main module, `host/index.mjs` calls
`createHost().build().start()` and attaches SIGINT/SIGTERM handlers. Same
pattern as the `isMainModule()` block in `mcp/main.mjs`.

---

### 6. Graceful shutdown

Same sequence as `mcp/main.mjs`, extracted into `host.stop()`:

1. Comm adapter stops accepting new requests.
2. Dispatcher begins shutdown (fails queued waiters).
3. HTTP server drains in-flight requests.
4. Dispatcher closes (ephemeral workers cleaned up, pool closed).
5. Fleet transport stopped.
6. Process exits.

The dispatcher's `beginShutdown()` → HTTP drain → `close()` ordering is
preserved exactly from `mcp/main.mjs`.

---

## Testing

### Unit tests (`npm run test:host`)

No Fleet, no Docker. Uses `tests/helpers/mock-fleet.mjs`.

| Test file | Covers |
|---|---|
| `tests/host-config.test.mjs` | Config loader: valid config passes, missing `name` throws, missing `comm` throws, missing `fleet` throws, unknown module warns, env override merges, unimplemented `enabled: true` warns, `.mjs` preferred over `.json`. |
| `tests/host-registry.test.mjs` | Extended registry: all tools present, defaults applied, explicit values preserved, tags default to `[]`. |
| `tests/host-executor.test.mjs` | Executor: valid args pass, invalid args return validation error, timeout returns timeout error, thrown error returns error-as-value, signal abort returns abort error. |
| `tests/comm-express.test.mjs` | Adapter: start with stub handler, `GET /health` returns ok, `POST /mcp` calls handler, null routes not mounted, `stop()` closes cleanly. |
| `tests/host-index.test.mjs` | Full wiring with mock fleet: boot host, call tool via HTTP, verify response. `callTool()` direct path. Shutdown cleans up. |

### Live integration test (`npm run test:host:live`)

Real Fleet, Docker. Same pattern as `tests/mcp.live.test.mjs`.

| Test file | Covers |
|---|---|
| `tests/host.live.test.mjs` | Boot host via `createHost().build()`, start it, connect MCP client, list tools, call `inspect-members`, verify response matches live test expectations. Proves the new entry point is a full replacement for the MCP path. |

### npm scripts

```json
"test:host": "node --test tests/host-config.test.mjs tests/host-registry.test.mjs tests/host-executor.test.mjs tests/comm-express.test.mjs tests/host-index.test.mjs",
"test:host:live": "node --test tests/host.live.test.mjs"
```

Existing `test`, `test:unit`, and `test:integration` scripts are untouched.

### CI pipeline (`.github/workflows/ci-host.yml`)

Mirrors the structure of `ci.yml`:

**Job 1: `host-unit-tests`**
- `ubuntu-latest`, Node 22
- `npm ci`
- `npm run test:host`

**Job 2: `host-integration-tests`**
- Needs job 1
- Docker build (`docker build -t workflow-kit-ci .`)
- Run `test:host` + `test:host:live` inside Docker container
- Same Docker image, same Fleet binary as `ci.yml`

Triggered on: pull requests to `main`, pushes to `main`.

Existing `ci.yml` is untouched. Both pipelines run independently.

---

## Acceptance criteria

1. `npm run host` boots the server from `host.config.mjs` and logs
   `"host '<name>' listening on http://<host>:<port>"`.
2. An MCP client connecting to the host's `/mcp` endpoint lists the same tools
   as `npm run mcp`.
3. Calling `inspect-members` through the host path returns the same result as
   through the MCP path.
4. `npm run mcp` continues to work unchanged — zero regressions.
5. `host.callTool('inspect-members', {})` returns a valid result through the
   executor path.
6. Config validation rejects missing mandatory fields with clear error messages.
7. Config validation warns on unimplemented modules with `enabled: true`.
8. `npm run test:host` passes all unit tests.
9. `npm run test:host:live` passes the live integration test.
10. `ci-host.yml` runs both jobs successfully in GitHub Actions.

---

## What Phase 1 does NOT ship

- Run loop / planner (Phase 2)
- Budgets module (Phase 2)
- Guardrails module (Phase 2)
- Memory modules (Phase 3)
- Eval harness (Phase 3)
- Dispatch / job queue (Phase 4)
- Azure Functions adapter (Phase 4)
- raw-http adapter (Phase 4)
- `POST /task` route handler (Phase 2)
- `GET /jobs/:id` route handler (Phase 4)
- Redis Streams, long-term memory, concurrent tasks (Phase 5)
