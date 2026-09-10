# Tiered Worker Dispatch

Status: proposed

## Problem

The workflow-kit's MCP server shares one `fleetApi` and two hardcoded members
(`DEMO-DOER` / `DEMO-REVIEWER`) across all requests. Two parallel tool calls
collide because Fleet enforces one in-flight prompt per member, and both callers
target the same member through the same work folder.

The existing worker pool on `feat/conc-implementation` solves same-folder
collisions with a fixed roster of N doer/reviewer pairs arbitrated by file
locks. That design handles Docker and local dev but cannot serve:

- **Azure Function Apps**, where there is no persistent disk and no
  pre-provisioned roster. Workers must be created on demand in `/tmp`.
- **Burst traffic** (e.g. a `/chat` endpoint receiving many concurrent
  messages), where the fixed pool saturates and new capacity is needed beyond N.
- **Zero-config dev mode**, where a developer should not need to run a
  provisioning script before testing.

## Goal

A tiered worker dispatch system that tries pre-provisioned pool workers first
(fast, no registration overhead), creates ephemeral workers as overflow (higher
latency, self-destructing), and queues beyond that with backpressure before
rejecting.

One dispatch interface. One lease shape. Tools and workflows never know which
tier served them.

## Principles

1. **Pool is the hot path.** Pre-registered workers have zero registration
   overhead. The dispatcher always tries the pool first.
2. **Ephemeral is overflow, not the default.** Registration and teardown cost
   time. Ephemeral workers exist for when the pool is full or absent.
3. **Latency wins over efficiency.** A queued message is served by whichever
   tier frees first — pool or ephemeral — not pool-preferred.
4. **Node owns member lifecycle.** Registration, OAuth provisioning, and
   teardown happen in Node through a single `MemberManager`. No shell scripts
   in any startup path.
5. **Both tiers always available.** Set `pool.size = 0` for ephemeral-only
   (Function Apps). Set `ephemeral.maxConcurrent = 0` for pool-only (Docker).
   Both nonzero for hybrid.

---

## Architecture

```
               WorkerDispatcher
              /        |        \
        Pool      Ephemeral     Queue → 429
         |         Factory
         |            |
         └─── MemberManager ───┘
                     |
                  fleetApi
                (stdio transport)
```

### Components

| Component | Responsibility |
|---|---|
| `MemberManager` | Registers members, provisions OAuth, tears down pairs. Single source of truth for member lifecycle. |
| `WorkerPool` | Pre-provisioned roster of N pairs. Lease-based acquisition with cross-process file locks, FIFO queueing, heartbeats. Adapted from `feat/conc-implementation`. |
| `EphemeralWorkerFactory` | Creates doer/reviewer pairs on demand in `/tmp/<guid>/`. Self-destructs on release (unregister + delete). |
| `WorkerDispatcher` | Tiered dispatch chain. Tries pool → ephemeral → queue → 429. Owns the shared wait queue. |
| `PooledFleetApi` | Proxy that remaps `'doer'`/`'reviewer'` keywords to the lease's actual member names. Unchanged from `feat/conc-implementation`. |

### Dependency direction

```
mcp/ → workflows/ → pool/
```

Nothing in `pool/` imports from `mcp/` or `workflows/`. The dispatcher is
consumed by `mcp/server.mjs` (for MCP tool calls) and by workflow launchers
(for direct runs).

---

## Tiered dispatch model

```
Request arrives
  │
  ├─► Tier 1: Pool ────── tryAcquireNow() (non-blocking)
  │     Got lease? ──► return Lease
  │     All busy? ──► fall through
  │
  ├─► Tier 2: Ephemeral ── under maxConcurrent?
  │     Yes? ──► register pair in /tmp/<guid>, return Lease
  │     At cap? ──► fall through
  │
  ├─► Tier 3: Queue ────── under maxQueueSize?
  │     Yes? ──► FIFO wait, served by whichever tier frees first
  │     Full? ──► fall through
  │
  └─► 429 "all workers busy, retry later"
```

### Lease shape

Every tier returns the same object. Consumers never distinguish pool from
ephemeral.

```js
{
  workerId:  'pool-3' | 'ephemeral-a1b2c3',
  doer:      { name: 'WORKER-3-DOER',     folder: '…/worker-3/doer' },
  reviewer:  { name: 'WORKER-3-REVIEWER',  folder: '…/worker-3/reviewer' },
  signal:    AbortSignal,   // linked to caller signal + lock compromise / ttl
  release:   async () => void,
}
```

- **Pool lease release:** cleans folders, releases file lock, notifies
  dispatcher queue.
- **Ephemeral lease release:** cleans folders, unregisters both members from
  Fleet, deletes `/tmp/<guid>/`, decrements active count, notifies dispatcher
  queue.

### Queue behaviour

Queued waiters are served by whichever tier frees first. A pool release and an
ephemeral release both wake the dispatcher's queue. The queue emits heartbeats
(immediate, then every 30s) to keep MCP connections alive. Waiters are removed
on signal abort or queue timeout.

---

## MemberManager

Owns all member registration, OAuth provisioning, and teardown in Node.
Replaces `scripts/provision-members.sh` as the source of truth.

### Interface

```js
class MemberManager {
  constructor(fleetApi, { oauthToken })

  // Register a doer+reviewer pair, create folders, provision OAuth.
  // Idempotent: skips members that already exist (ensureRegistered).
  async provisionPair(prefix, workRoot)
    // → { doer: { name, folder }, reviewer: { name, folder } }

  // Unregister both members, delete work folders.
  async teardownPair(prefix, workRoot)

  // Provision N pool pairs at startup. Fails fast on any error.
  async provisionRoster(roster)
}
```

### Registration path

Uses `ensureRegistered()` from `transport/stdio-fleet.mjs` — calls
`fleetApi.listMembers()` to check presence, then `fleetApi.registerMember()`
if absent. Token-exact name matching from `pool/fleet-text.mjs` prevents
`WORKER-1-DOER` matching `WORKER-11-DOER`.

### OAuth path

Calls the `provision_llm_auth` MCP tool via `fleetApi` for each member, same
mechanism already proven in `spawnFleet()`. If no OAuth token is available, logs
a warning — agent prompts will fail, but tool-server mode (commands only) still
works.

### Teardown path

Calls `fleetApi.removeMember()` if the Fleet server exposes it (the stdio
transport conditionally adds this method). If `removeMember` is unavailable,
cleans folders only — the orphaned registration is harmless since the work
folder is gone.

### Error handling

- Registration failure at startup: fatal. The process exits with a message
  naming the failed member and the fix.
- Registration failure for an ephemeral worker: the dispatch attempt fails, the
  dispatcher falls through to the queue or 429. No partial state — if the doer
  registered but the reviewer failed, teardown runs immediately.
- OAuth failure: warning, not fatal. The member is registered but cannot run
  agent prompts.

---

## WorkerPool (adapted from feat/conc-implementation)

The pool code from the concurrency branch is brought in with minimal changes.

### What stays the same

- Lease-based acquisition with `proper-lockfile` (cross-process safe)
- FIFO internal queueing with heartbeats (30s interval)
- Cleanup on acquire and release (preserving `.claude/`)
- `PoolSaturatedError` when internal timeout expires
- `onCompromised` callback aborting the lease's signal
- Poll-based cross-process release detection (1s + jitter)

### What changes

| Change | Reason |
|---|---|
| Remove `#verifyRoster()` from constructor | MemberManager already registered everyone. Pool trusts its roster. |
| Expose `tryAcquireNow(signal)` as public | Dispatcher needs a non-blocking attempt that returns `null` instead of queueing. |
| Pool's internal queue bypassed by dispatcher | The dispatcher owns the shared queue across tiers. Pool's `acquire()` still exists for direct callers (CLI, tests). |
| Transport: `connectFleet()` → receive `fleetApi` from caller | The caller spawns Fleet via stdio. Pool was already parameterised on `fleetApi`; only the wiring in `mcp/main.mjs` changes. |

### Roster configuration

Unchanged from `feat/conc-implementation`:

| Variable | Default | Purpose |
|---|---|---|
| `pool.size` | `4` | Number of worker pairs |
| `pool.root` | `./workdir` | Base folder for worker dirs and locks |
| `pool.acquireTimeoutMs` | `300000` | Timeout for pool's internal `acquire()` |

Roster is built from config: `WORKER-{i}-DOER` / `WORKER-{i}-REVIEWER`,
1-indexed, with folders at `<root>/worker-{i}/doer` and
`<root>/worker-{i}/reviewer`, locks at `<root>/.locks/worker-{i}`.

---

## EphemeralWorkerFactory

Creates workers on demand for overflow and serverless deployment.

### Interface

```js
class EphemeralWorkerFactory {
  constructor(fleetApi, memberManager, config)

  // Create an ephemeral pair. Returns null if at maxConcurrent.
  async create({ signal }) → Lease | null

  // Number of currently active ephemeral workers.
  get active() → number

  // Register a callback for when an ephemeral worker is released.
  onRelease(callback)

  async close()
}
```

### Lifecycle of one ephemeral worker

```
create({ signal })
  │
  ├─ Generate guid (crypto.randomUUID())
  ├─ prefix = EPHEMERAL-<first 8 chars uppercase>
  ├─ workRoot = /tmp/<guid>/  (or config.workRoot/<guid>/)
  ├─ MemberManager.provisionPair(prefix, workRoot)
  │    ├─ Register EPHEMERAL-A1B2C3D4-DOER
  │    ├─ Register EPHEMERAL-A1B2C3D4-REVIEWER
  │    └─ Provision OAuth for both
  ├─ Start TTL timer (config.ttlMs)
  ├─ Link AbortController to caller signal + TTL
  └─ Return Lease

  ... task runs using PooledFleetApi(fleetApi, lease) ...

release()
  │
  ├─ Clear TTL timer
  ├─ MemberManager.teardownPair(prefix, workRoot)
  │    ├─ Unregister both members (if removeMember available)
  │    └─ rm -rf /tmp/<guid>/
  ├─ Decrement active count
  └─ Notify dispatcher queue (onRelease callback)
```

### No locking needed

Each ephemeral worker has a unique guid. No two callers can target the same
pair. Cross-process contention does not apply — ephemeral workers are exclusive
by construction.

### TTL safety net

If a task hangs and never calls `release()`, the TTL timer fires after
`config.ttlMs`, aborts the lease's signal (the task stops cooperatively), and
runs teardown. This prevents leaked Fleet members and orphaned `/tmp` folders.

---

## WorkerDispatcher

The glue that implements the tiered dispatch chain.

### Interface

```js
class WorkerDispatcher {
  constructor({ pool, ephemeral, config })

  // Try pool → ephemeral → queue → 429. Returns a Lease.
  async dispatch({ signal, reportPhase }) → Lease

  async close()
}
```

### Internal queue

The dispatcher owns a single FIFO queue shared across both tiers. When a pool
worker releases or an ephemeral worker releases, the dispatcher wakes the next
queued waiter and tries to serve it from whichever tier has capacity.

```
Wake from release
  │
  ├─ Try pool.tryAcquireNow()
  │    Got lease? ──► grant to waiter
  │
  ├─ Try ephemeral.create()
  │    Got lease? ──► grant to waiter
  │
  └─ Neither available? ──► waiter stays queued, wait for next release
```

### Heartbeats

Queued waiters emit progress heartbeats (immediate, then every 30s) carrying
queue position and total capacity. This keeps MCP connections alive past the
60s first-byte and 5-minute idle timers.

### Error handling in dispatch

If `ephemeral.create()` throws (e.g. registration failure), the dispatcher
catches the error, logs it, and falls through to the queue — same as if
the ephemeral tier returned `null`. The caller sees a queued wait or a 429,
not a registration error.

### Overflow rejection

When the queue reaches `maxQueueSize`, `dispatch()` throws a
`DispatchOverflowError`. The MCP layer translates this to a 429 response.

---

## Changes to existing code

### mcp/main.mjs

```
Before:
  spawnFleet(memberName: 'DEMO-DOER') → fleetApi
  buildMcpServer({ fleetApi })

After:
  spawnFleet(memberName: null) → fleetApi (Fleet running, no member registered)
  MemberManager.provisionRoster(fleetApi, roster)
  WorkerPool.create(fleetApi, roster)
  EphemeralWorkerFactory(fleetApi, memberManager, config)
  WorkerDispatcher(pool, ephemeral, config)
  buildMcpServer({ fleetApi, dispatcher })
```

### mcp/server.mjs

Each tool call acquires a lease from the dispatcher, wraps `fleetApi` with
`PooledFleetApi`, runs the tool, and releases the lease in a `finally`.

```
Before:
  tool.run({ fleetApi, args, signal })
  // All tools share one fleetApi, one member

After:
  const lease = await dispatcher.dispatch({ signal, reportPhase })
  try {
    const wrappedApi = createPooledFleetApi(fleetApi, lease)
    tool.run({ fleetApi: wrappedApi, args, signal: lease.signal })
  } finally {
    await lease.release()
  }
```

### mcp/registry.mjs

Tools stop hardcoding `member_name: 'DEMO-DOER'`. They use the `'doer'` /
`'reviewer'` keywords, which `PooledFleetApi` resolves to the lease's actual
member names. Most tools already pass `member_name: 'DEMO-DOER'` — the change
is replacing that string with `'doer'`.

### transport/stdio-fleet.mjs

Unchanged. `spawnFleet()` gains the ability to be called without `memberName`
(skip registration, just start Fleet and return `fleetApi`). This is already
supported — both parameters are optional.

### workflows/demo/main.mjs

Simplified. No longer builds its own pool or calls `connectFleet()`. Receives
a dispatcher or lease from the caller. Direct CLI execution (`node
workflows/demo/main.mjs`) builds a minimal dispatcher internally.

### scripts/provision-members.sh

Kept for manual debugging. Not in any startup path. Not called by Docker
entrypoint.

---

## Startup lifecycle

### Docker / local dev (pool.size > 0)

```
node mcp/main.mjs
  │
  ├─ 1. Load config (agent.config.mjs or defaults from env)
  ├─ 2. spawnFleet({ memberName: null }) → fleetApi
  ├─ 3. MemberManager(fleetApi, { oauthToken })
  ├─ 4. memberManager.provisionRoster(roster)
  │       Register N doer/reviewer pairs, OAuth all
  │       Fail fast on any error
  ├─ 5. WorkerPool.create(fleetApi, roster)
  ├─ 6. EphemeralWorkerFactory(fleetApi, memberManager, ephemeralConfig)
  ├─ 7. WorkerDispatcher({ pool, ephemeral, dispatchConfig })
  ├─ 8. Start Express on configured port
  └─ Ready
```

### Function App (pool.size = 0)

```
Cold start
  │
  ├─ 1. Load config
  ├─ 2. spawnFleet({ memberName: null }) → fleetApi
  ├─ 3. MemberManager(fleetApi, { oauthToken })
  ├─ 4. Skip pool provisioning (size = 0)
  ├─ 5. EphemeralWorkerFactory(fleetApi, memberManager, ephemeralConfig)
  ├─ 6. WorkerDispatcher({ pool: null, ephemeral, dispatchConfig })
  ├─ 7. Azure Functions adapter ready
  └─ Ready. Fleet lives with the function instance.
```

### Shutdown

```
SIGINT / SIGTERM
  │
  ├─ Comm adapter stops accepting new requests
  ├─ Queued waiters rejected with "shutting down"
  ├─ In-flight tasks finish (up to drain timeout)
  ├─ Active ephemeral workers tear down (unregister + delete)
  ├─ Pool closes (release locks)
  └─ Fleet child process stops (spawnFleet stop())
```

---

## Configuration

```js
// agent.config.mjs
export default {
  name: 'my-agent',

  fleet: {
    bin: 'apra-fleet',
    oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  },

  comm: {
    adapter: 'express',       // 'express' | 'azure-functions'
    port: 3000,
    host: '127.0.0.1',
  },

  workers: {
    pool: {
      size: 4,                // 0 = no pool (Function App mode)
      root: './workdir',
      acquireTimeoutMs: 300000,
    },
    ephemeral: {
      maxConcurrent: 10,      // 0 = no ephemeral (pool-only mode)
      workRoot: '/tmp',       // os.tmpdir() on Function Apps
      ttlMs: 600000,          // force-teardown safety net
    },
    dispatch: {
      maxQueueSize: 20,
      queueTimeoutMs: 300000,
    },
  },
}
```

### Validation

At startup, if `pool.size = 0` and `ephemeral.maxConcurrent = 0`, the kit
refuses to start: "no workers configured — set pool.size > 0,
ephemeral.maxConcurrent > 0, or both." At least one tier must be available.

All `workers.*` settings can be overridden by environment variables for
Docker deployment without changing the config file:

| Env var | Maps to |
|---|---|
| `WORKER_POOL_SIZE` | `workers.pool.size` |
| `WORKER_POOL_ROOT` | `workers.pool.root` |
| `WORKER_POOL_ACQUIRE_TIMEOUT_MS` | `workers.pool.acquireTimeoutMs` |
| `WORKER_EPHEMERAL_MAX` | `workers.ephemeral.maxConcurrent` |
| `WORKER_EPHEMERAL_ROOT` | `workers.ephemeral.workRoot` |
| `WORKER_EPHEMERAL_TTL_MS` | `workers.ephemeral.ttlMs` |
| `WORKER_DISPATCH_QUEUE_SIZE` | `workers.dispatch.maxQueueSize` |
| `WORKER_DISPATCH_QUEUE_TIMEOUT_MS` | `workers.dispatch.queueTimeoutMs` |

---

## File structure

```
pool/
  member-manager.mjs         ← NEW
  ephemeral-factory.mjs      ← NEW
  worker-dispatcher.mjs      ← NEW
  worker-pool.mjs            ← FROM feat/conc-implementation, adapted
  roster.mjs                 ← FROM feat/conc-implementation, unchanged
  worker-lock.mjs            ← FROM feat/conc-implementation, unchanged
  cleanup.mjs                ← FROM feat/conc-implementation, unchanged
  fleet-text.mjs             ← FROM feat/conc-implementation, unchanged
  pooled-fleet-api.mjs       ← FROM feat/conc-implementation, unchanged
```

## Testing

### Unit tests (no Fleet, no token)

- **MemberManager:** mock fleetApi, verify registration calls, OAuth calls,
  teardown calls. Test idempotent provisioning (member already exists). Test
  partial failure rollback (doer registered, reviewer fails → teardown doer).
- **EphemeralWorkerFactory:** mock MemberManager, verify create/release cycle,
  maxConcurrent enforcement, TTL teardown, onRelease callback.
- **WorkerDispatcher:** mock pool + ephemeral, verify tier ordering (pool
  first, then ephemeral, then queue), queue FIFO, overflow rejection,
  queue drain from either tier, signal abort removes waiter.
- **WorkerPool:** existing tests from `feat/conc-implementation` adapted to
  not depend on `#verifyRoster()`.

### Integration tests (live Fleet)

- Start Fleet, provision 2 pool workers + allow 2 ephemeral.
- Two concurrent requests → both served by pool.
- Four concurrent requests → 2 pool + 2 ephemeral.
- Six concurrent requests → 2 pool + 2 ephemeral + 2 queued, served as
  workers free.
- Ephemeral teardown verified: member no longer in `listMembers()` after
  release, `/tmp` folder deleted.

---

## Relationship to existing specs

### Concurrency spec (`docs/specs/concurrency-spec.md`)

This design supersedes the concurrency spec's pool-only model. The pool
component is preserved wholesale. The additions are: MemberManager (Node-side
registration), EphemeralWorkerFactory, WorkerDispatcher (tiered dispatch), and
the configuration to run in pool-only, ephemeral-only, or hybrid mode.

### Agent kit spec (`docs/specs/2026-09-09-fleet-agent-kit-spec.md`)

This design implements parts of:
- **Phase 1** — The comm adapter split and config loader (partially; this spec
  focuses on workers, not the full modular framework).
- **Phase 4** — The dispatch/job queue module. `WorkerDispatcher` is the
  dispatch layer. The in-process queue is the dispatcher's internal queue.
- **Phase 5** — Concurrent task processing with multiple Fleet members per
  agent. The pool + ephemeral model provides this.

The agent kit spec's `dispatch.backend: 'in-process'` maps to
`WorkerDispatcher`. A future `'redis'` backend would replace the dispatcher's
internal queue with Redis Streams, keeping the same tiered dispatch logic.

---

## Non-goals

- **Redis Streams dispatch.** The internal queue is in-process. Redis is a
  future backend swap.
- **Cross-host locking.** Pool file locks require a shared local filesystem.
- **Preemptive termination.** Cancellation stays cooperative.
- **Multi-agent orchestration.** One container = one agent.
- **The full agent kit framework.** This spec covers worker dispatch only. The
  run loop, memory, budgets, guardrails, and eval harness are separate work
  under the agent kit spec.
- **The `/chat` endpoint.** This spec provides the worker dispatch that `/chat`
  will use. The chat ingress, session management, and agent run loop are
  separate.

---

## Migration from current code

- `DEMO-DOER` / `DEMO-REVIEWER` retire as hardcoded names.
- `mcp/registry.mjs` tools switch from `'DEMO-DOER'` to `'doer'` keyword.
- `mcp/main.mjs` builds a dispatcher at startup instead of passing bare
  `fleetApi` to `buildMcpServer`.
- `mcp/server.mjs` wraps each tool call in a dispatch/release cycle.
- `scripts/provision-members.sh` exits the startup path.
- Pool code from `feat/conc-implementation` is cherry-picked (6 files, all new)
  and adapted as described above.
- `docker-compose.yml` drops the provision script call from the entrypoint.
