# Tiered Worker Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every MCP tool call and CLI run exclusive use of one doer+reviewer worker pair, served first from a pre-registered pool, then from ephemeral `/tmp` workers, then from a bounded queue — with all member registration owned by Node.

**Architecture:** A `pool/` layer with no imports from `mcp/` or `workflows/`. `MemberManager` registers/authorises/removes members through `fleetApi`. `WorkerPool` (ported from `feat/conc-implementation`) leases pre-registered pairs under cross-process file locks. `EphemeralWorkerFactory` creates guid-named pairs under `os.tmpdir()` and tears them down on release. `WorkerDispatcher` tries pool → ephemeral → queue → reject and exposes one `Lease` shape. `mcp/server.mjs` wraps each tool call in `dispatch()`/`release()`, and workflows address members as `'doer'`/`'reviewer'` through `PooledFleetApi`.

**Tech Stack:** Node ≥ 22.16, ESM only, `node --test` + `node:assert/strict`, `proper-lockfile` ^4.1.2 (the one new runtime dependency), existing `@modelcontextprotocol/*` v2 and stdio Fleet transport.

**Spec:** `docs/specs/2026-09-10-tiered-worker-dispatch-design.md`

---

## Global constraints

- Dependency direction is one-way: `mcp/` → `workflows/` → `pool/` → `transport/` is **not** allowed either; `pool/` imports only Node built-ins, `proper-lockfile`, and other `pool/` files.
- Reserved role keywords are lowercase `'doer'` and `'reviewer'`. Any other `member_name` passes through `PooledFleetApi` unchanged.
- Pool members are `WORKER-{i}-DOER` / `WORKER-{i}-REVIEWER`, 1-indexed, folders `<root>/worker-{i}/{doer,reviewer}`, locks `<root>/.locks/worker-{i}`.
- Ephemeral members are `EPHEMERAL-{SHORTID}-DOER` / `-REVIEWER` where `SHORTID` is the first 8 chars of a UUID, uppercased; folders `<workRoot>/<uuid>/{doer,reviewer}`.
- Lease shape everywhere: `{ workerId, doer: { name, folder }, reviewer: { name, folder }, signal, release() }`. `workerId` is `pool-{i}` or `ephemeral-{shortid}` (lowercase shortid).
- `WorkerPool` never calls `registerMember`, `listMembers`, or any Fleet method. `MemberManager` is the only registration path.
- All new tests are offline (no Fleet binary, no token) except the one file named `*.live.test.mjs`.
- Every task ends with `node --test <the task's test files>` green and a commit. Run the full suite (`npm test`) at the end of Tasks 10–13.
- Windows: `path.join` everywhere; never hardcode `/tmp`. Default ephemeral root is `path.join(os.tmpdir(), 'workflow-kit')`.
- Source of the ported files is the branch `feat/conc-implementation`. Extract with `git show feat/conc-implementation:<path> > <path>`.

---

### Task 1: Dependency, ignore rules, and workdir layout

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`
- Delete: `workdir/DEMO-DOER/.gitkeep`, `workdir/DEMO-REVIEWER/.gitkeep`
- Create: `workdir/.gitkeep`

- [ ] **Step 1: Install proper-lockfile**

Run: `npm install proper-lockfile@^4.1.2`
Expected: `package.json` dependencies now include `"proper-lockfile": "^4.1.2"`; `package-lock.json` updated.

- [ ] **Step 2: Ignore per-worker folders and locks**

Append to `.gitignore`:

```
workdir/*
!workdir/.gitkeep
```

- [ ] **Step 3: Retire the DEMO-* placeholders**

Run:
```bash
git rm -q workdir/DEMO-DOER/.gitkeep workdir/DEMO-REVIEWER/.gitkeep
mkdir -p workdir && : > workdir/.gitkeep
git add workdir/.gitkeep .gitignore package.json package-lock.json
git status --short
```
Expected: two deletions, `workdir/.gitkeep` added, `.gitignore`/`package*.json` modified. No `workdir/worker-*` will ever show up in status.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: add proper-lockfile and prepare workdir for pooled workers"
```

---

### Task 2: Port the pool foundation from feat/conc-implementation

Five modules and their tests come over verbatim, then two small edits: `roster.mjs` must accept `WORKER_POOL_SIZE=0` (ephemeral-only mode), and `fleet-text.mjs` gains `toolResultLooksFailed` so `MemberManager` need not import from `transport/`.

**Files:**
- Create (verbatim): `pool/roster.mjs`, `pool/cleanup.mjs`, `pool/worker-lock.mjs`, `pool/fleet-text.mjs`, `pool/pooled-fleet-api.mjs`
- Create (verbatim): `tests/pool-roster.test.mjs`, `tests/pool-cleanup.test.mjs`, `tests/pool-worker-lock.test.mjs`, `tests/pool-fleet-text.test.mjs`, `tests/pool-pooled-fleet-api.test.mjs`, `tests/helpers/hold-lock.mjs`
- Modify: `pool/roster.mjs`, `tests/pool-roster.test.mjs`, `pool/fleet-text.mjs`, `tests/pool-fleet-text.test.mjs`

**Interfaces produced (unchanged from the branch unless noted):**
- `roster.mjs`: `DOER`, `REVIEWER`, `ROLES`, `DEFAULT_POOL_SIZE`, `DEFAULT_ACQUIRE_TIMEOUT_MS`, `poolConfig(env) → { size, root, acquireTimeoutMs }` (**size may now be 0**), `workerDescriptor(root, id)`, `buildRoster({ size, root }) → Worker[]`, `rosterMemberNames(roster)`.
- `cleanup.mjs`: `PRESERVED_ENTRIES`, `cleanWorkerFolder(folder)`, `cleanWorker(worker)`.
- `worker-lock.mjs`: `LOCK_UPDATE_MS`, `LOCK_STALE_MS`, `tryClaim(lockTarget, { onCompromised }) → (async release) | null`, `readHolder(lockTarget)`.
- `fleet-text.mjs`: `toolText(result)`, `memberIsPresent(text, name)`, **new** `toolResultLooksFailed(result)`.
- `pooled-fleet-api.mjs`: `createPooledFleetApi(fleetApi, lease)`.

- [ ] **Step 1: Extract the files**

```bash
mkdir -p pool tests/helpers
for f in pool/roster.mjs pool/cleanup.mjs pool/worker-lock.mjs pool/fleet-text.mjs pool/pooled-fleet-api.mjs \
         tests/pool-roster.test.mjs tests/pool-cleanup.test.mjs tests/pool-worker-lock.test.mjs \
         tests/pool-fleet-text.test.mjs tests/pool-pooled-fleet-api.test.mjs tests/helpers/hold-lock.mjs; do
  git show feat/conc-implementation:$f > $f
done
```

- [ ] **Step 2: Run the ported tests as-is**

Run: `node --test tests/pool-roster.test.mjs tests/pool-cleanup.test.mjs tests/pool-worker-lock.test.mjs tests/pool-fleet-text.test.mjs tests/pool-pooled-fleet-api.test.mjs`
Expected: PASS. (If `pool-worker-lock` fails with a spawn error, confirm `tests/helpers/hold-lock.mjs` exists — it is the child process the cross-process test launches.)

- [ ] **Step 3: Write the failing roster test for size 0**

In `tests/pool-roster.test.mjs`, replace the test `'poolConfig rejects sizes that are not positive integers'` with:

```js
test('poolConfig accepts zero (ephemeral-only) but rejects negatives and non-integers', () => {
  assert.equal(poolConfig({ WORKER_POOL_SIZE: '0' }).size, 0);
  assert.throws(() => poolConfig({ WORKER_POOL_SIZE: '-1' }), /WORKER_POOL_SIZE/);
  assert.throws(() => poolConfig({ WORKER_POOL_SIZE: 'four' }), /WORKER_POOL_SIZE/);
  assert.throws(() => poolConfig({ WORKER_POOL_SIZE: '2.5' }), /WORKER_POOL_SIZE/);
  assert.throws(() => poolConfig({ WORKER_POOL_ACQUIRE_TIMEOUT_MS: '0' }), /WORKER_POOL_ACQUIRE_TIMEOUT_MS/);
});

test('buildRoster with size 0 is empty', () => {
  assert.deepEqual(buildRoster({ size: 0, root: '/root' }), []);
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `node --test tests/pool-roster.test.mjs`
Expected: FAIL — `poolConfig({ WORKER_POOL_SIZE: '0' })` throws.

- [ ] **Step 5: Allow size 0 in roster.mjs**

In `pool/roster.mjs`, add this helper below `positiveInt` and switch the `size` line in `poolConfig` to use it:

```js
function nonNegativeInt(raw, name, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got: ${String(raw)}`);
  }
  return value;
}
```

```js
    size: nonNegativeInt(env.WORKER_POOL_SIZE, 'WORKER_POOL_SIZE', DEFAULT_POOL_SIZE),
```

`acquireTimeoutMs` keeps `positiveInt`.

- [ ] **Step 6: Run to verify it passes**

Run: `node --test tests/pool-roster.test.mjs`
Expected: PASS, 7 tests.

- [ ] **Step 7: Write the failing fleet-text test**

Append to `tests/pool-fleet-text.test.mjs` (and add `toolResultLooksFailed` to the import line):

```js
test('toolResultLooksFailed recognises isError and Fleet error prefixes', () => {
  assert.equal(toolResultLooksFailed({ isError: true, content: [] }), true);
  assert.equal(toolResultLooksFailed({ content: [{ type: 'text', text: '❌ host is required' }] }), true);
  assert.equal(toolResultLooksFailed({ content: [{ type: 'text', text: 'ERROR: nope' }] }), true);
  assert.equal(toolResultLooksFailed({ content: [{ type: 'text', text: 'registered X' }] }), false);
  assert.equal(toolResultLooksFailed(null), false);
});
```

- [ ] **Step 8: Run to verify it fails**

Run: `node --test tests/pool-fleet-text.test.mjs`
Expected: FAIL — `toolResultLooksFailed` is not exported.

- [ ] **Step 9: Add toolResultLooksFailed**

Append to `pool/fleet-text.mjs`:

```js
// Fleet reports failures two ways: an MCP isError envelope, or a text body
// starting with ❌ / ERROR:. Both mean the call did not do what it was asked.
export function toolResultLooksFailed(result) {
  if (result?.isError) return true;
  return /^\s*(❌|ERROR:)/m.test(toolText(result));
}
```

- [ ] **Step 10: Run to verify it passes**

Run: `node --test tests/pool-fleet-text.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 11: Commit**

```bash
git add pool/roster.mjs pool/cleanup.mjs pool/worker-lock.mjs pool/fleet-text.mjs pool/pooled-fleet-api.mjs \
        tests/pool-roster.test.mjs tests/pool-cleanup.test.mjs tests/pool-worker-lock.test.mjs \
        tests/pool-fleet-text.test.mjs tests/pool-pooled-fleet-api.test.mjs tests/helpers/hold-lock.mjs
git commit -m "feat: port the worker pool foundation and allow a zero-size pool"
```

---

### Task 3: WorkerPool adapted for the dispatcher

Port `pool/worker-pool.mjs`, then: drop `fleetApi` and roster verification (MemberManager owns registration), make `tryAcquireNow` public, prefix `workerId` with `pool-`, and add `onRelease()` so the dispatcher hears releases. `acquire()` and its internal queue stay for direct callers and tests.

**Files:**
- Create: `pool/worker-pool.mjs` (adapted — full file below)
- Create: `tests/helpers/mock-fleet.mjs` (new version — full file below)
- Create: `tests/pool-worker-pool.test.mjs` (new — full file below)

**Interfaces produced:**
- `WorkerPool.create({ config?, roster?, env? }) → WorkerPool` (synchronous; `await` is harmless).
- `pool.size`, `pool.roster`, `pool.config`.
- `pool.tryAcquireNow(signal?) → Promise<Lease | null>`.
- `pool.acquire({ signal?, reportPhase? }) → Promise<Lease>` (queues; throws `PoolSaturatedError` after `config.acquireTimeoutMs`).
- `pool.onRelease(listener) → unsubscribe`.
- `pool.close()`.
- `HEARTBEAT_MS`, `POLL_MS`, `PoolSaturatedError`.
- Test helper `createMockFleetApi({ members?, tools?, registerFails?, commandPayload? })` exposing `present` (Set), `registerCalls`, `removeCalls`, `authCalls`, `commandCalls`, `promptCalls`; `rosterNames(size)`.

- [ ] **Step 1: Write the shared mock**

```js
// tests/helpers/mock-fleet.mjs
// One mock for every offline test. Returns realistic MCP envelopes so the
// text-extraction paths run for real, and records every mutating call so
// tests can assert on registration, teardown, and auth.
export function createMockFleetApi({
  members = [],
  tools = ['remove_member', 'provision_llm_auth'],
  registerFails = [],
  commandPayload = 'hello-from-python',
} = {}) {
  const present = new Set(members);
  const registerCalls = [];
  const removeCalls = [];
  const authCalls = [];
  const commandCalls = [];
  const promptCalls = [];

  const api = {
    present,
    registerCalls,
    removeCalls,
    authCalls,
    commandCalls,
    promptCalls,
    async listMembers() {
      return { content: [{ type: 'text', text: [...present].join('\n') }] };
    },
    async fleetStatus() {
      return { content: [{ type: 'text', text: 'fleet server: running' }] };
    },
    async registerMember(options) {
      registerCalls.push(options);
      if (registerFails.includes(options.friendly_name)) {
        return { content: [{ type: 'text', text: `❌ cannot register ${options.friendly_name}` }] };
      }
      present.add(options.friendly_name);
      return { content: [{ type: 'text', text: `registered ${options.friendly_name}` }] };
    },
    async executeCommand(options) {
      commandCalls.push(options);
      const payload =
        typeof commandPayload === 'function' ? commandPayload(options) : commandPayload;
      return {
        content: [{ type: 'text', text: payload }],
        structuredContent: { stdout: payload, exitCode: 0 },
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

  if (tools.includes('remove_member')) {
    api.removeMember = async (options) => {
      removeCalls.push(options);
      present.delete(options.member_name);
      return { content: [{ type: 'text', text: `removed ${options.member_name}` }] };
    };
  }
  if (tools.includes('provision_llm_auth')) {
    api.provisionLlmAuth = async (options) => {
      authCalls.push(options);
      return { content: [{ type: 'text', text: `auth ok ${options.member_name}` }] };
    };
  }
  return api;
}

export function rosterNames(size) {
  return Array.from({ length: size }, (_, index) => index + 1).flatMap((id) => [
    `WORKER-${id}-DOER`,
    `WORKER-${id}-REVIEWER`,
  ]);
}
```

- [ ] **Step 2: Write the failing pool test**

```js
// tests/pool-worker-pool.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PoolSaturatedError, WorkerPool } from '../pool/worker-pool.mjs';

async function makePool({ size = 1, acquireTimeoutMs = 300000 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-pool-'));
  const pool = WorkerPool.create({ config: { size, root, acquireTimeoutMs } });
  return { pool, root };
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

test('create needs no fleetApi and never touches Fleet', async () => {
  const { pool } = await makePool({ size: 2 });
  assert.equal(pool.size, 2);
  assert.equal(pool.roster[0].doer.name, 'WORKER-1-DOER');
  await pool.close();
});

test('leases are prefixed pool- and carry both roles', async () => {
  const { pool } = await makePool({ size: 1 });
  const lease = await pool.acquire();
  assert.equal(lease.workerId, 'pool-1');
  assert.equal(lease.doer.name, 'WORKER-1-DOER');
  assert.equal(lease.reviewer.name, 'WORKER-1-REVIEWER');
  assert.ok(lease.signal instanceof AbortSignal);
  await lease.release();
  await pool.close();
});

test('concurrent acquires get different workers', async () => {
  const { pool } = await makePool({ size: 2 });
  const [first, second] = await Promise.all([pool.acquire(), pool.acquire()]);
  assert.notEqual(first.workerId, second.workerId);
  await first.release();
  await second.release();
  await pool.close();
});

test('tryAcquireNow returns null instead of queueing when all workers are held', async () => {
  const { pool } = await makePool({ size: 1 });
  const held = await pool.tryAcquireNow();
  assert.equal(held.workerId, 'pool-1');
  assert.equal(await pool.tryAcquireNow(), null);
  await held.release();
  assert.equal((await pool.tryAcquireNow()).workerId, 'pool-1');
  await pool.close();
});

test('onRelease fires after the worker is free again', async () => {
  const { pool } = await makePool({ size: 1 });
  let fired = 0;
  let freeAtFire = null;
  const unsubscribe = pool.onRelease(() => {
    fired += 1;
    freeAtFire = pool.tryAcquireNow();
  });
  const lease = await pool.acquire();
  await lease.release();
  assert.equal(fired, 1);
  const reacquired = await freeAtFire;
  assert.equal(reacquired.workerId, 'pool-1', 'listener must observe the worker as free');
  await reacquired.release();
  assert.equal(fired, 2);
  unsubscribe();
  const again = await pool.acquire();
  await again.release();
  assert.equal(fired, 2, 'unsubscribed listener must not fire');
  await pool.close();
});

test('a saturated pool queues and hands off on release', async () => {
  const { pool } = await makePool({ size: 1 });
  const held = await pool.acquire();
  let waitingResolved = false;
  const waiting = pool.acquire().then((lease) => {
    waitingResolved = true;
    return lease;
  });
  await tick();
  assert.equal(waitingResolved, false, 'must not hand out a held worker');
  await held.release();
  const lease = await waiting;
  assert.equal(lease.workerId, 'pool-1');
  await lease.release();
  await pool.close();
});

test('a queued caller gets an immediate heartbeat with its position', async () => {
  const { pool } = await makePool({ size: 1 });
  const held = await pool.acquire();
  const phases = [];
  const waiting = pool.acquire({ reportPhase: (message) => phases.push(message) });
  await tick();
  assert.equal(phases.length, 1);
  assert.match(phases[0], /position 1/);
  assert.match(phases[0], /pool size 1/);
  await held.release();
  await (await waiting).release();
  await pool.close();
});

test('a queued caller fails with a readable error after the timeout', async () => {
  const { pool } = await makePool({ size: 1, acquireTimeoutMs: 100 });
  const held = await pool.acquire();
  await assert.rejects(() => pool.acquire(), (err) => {
    assert.ok(err instanceof PoolSaturatedError);
    assert.match(err.message, /all 1 workers busy/);
    return true;
  });
  await held.release();
  await pool.close();
});

test('aborting while queued dequeues the waiter', async () => {
  const { pool } = await makePool({ size: 1 });
  const held = await pool.acquire();
  const controller = new AbortController();
  const waiting = pool.acquire({ signal: controller.signal });
  await tick();
  controller.abort(new Error('caller went away'));
  await assert.rejects(() => waiting, /caller went away/);
  await held.release();
  const lease = await pool.acquire();
  assert.equal(lease.workerId, 'pool-1');
  await lease.release();
  await pool.close();
});

test('acquire cleans a folder left dirty by a crashed holder', async () => {
  const { pool, root } = await makePool({ size: 1 });
  const doerFolder = path.join(root, 'worker-1', 'doer');
  await fs.mkdir(doerFolder, { recursive: true });
  const stale = path.join(doerFolder, 'left-behind.txt');
  await fs.writeFile(stale, 'from a crashed run');
  const lease = await pool.acquire();
  await assert.rejects(() => fs.access(stale), 'acquire must wipe inherited files');
  await lease.release();
  await pool.close();
});

test('release is idempotent and a closed pool refuses new leases', async () => {
  const { pool } = await makePool({ size: 1 });
  const lease = await pool.acquire();
  await lease.release();
  await lease.release();
  await pool.close();
  assert.equal(await pool.tryAcquireNow(), null);
  await assert.rejects(() => pool.acquire(), /closed/);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test tests/pool-worker-pool.test.mjs`
Expected: FAIL — `Cannot find module '../pool/worker-pool.mjs'`.

- [ ] **Step 4: Write the adapted pool**

```js
// pool/worker-pool.mjs
import { cleanWorker } from './cleanup.mjs';
import { buildRoster, poolConfig } from './roster.mjs';
import { tryClaim } from './worker-lock.mjs';

// Beats the 60s first-response-byte timer immediately, then the 5-minute idle
// timer every 30s. See docs/mcp-interface.md for the timer inventory.
export const HEARTBEAT_MS = 30000;
// Cross-process releases cannot notify us, so waiting degrades to polling.
export const POLL_MS = 1000;

export class PoolSaturatedError extends Error {}

export class WorkerPool {
  #config;
  #roster;
  #held = new Set();
  #waiters = [];
  #pollTimer = null;
  #servicing = false;
  #closed = false;
  #releaseListeners = new Set();

  constructor(config, roster) {
    this.#config = config;
    this.#roster = roster;
  }

  // The pool schedules; it does not register. MemberManager has already put
  // every roster member on the Fleet server before this is called.
  static create({ config, roster, env = process.env } = {}) {
    const resolved = config ?? poolConfig(env);
    return new WorkerPool(resolved, roster ?? buildRoster(resolved));
  }

  get size() { return this.#roster.length; }
  get roster() { return this.#roster; }
  get config() { return this.#config; }

  onRelease(listener) {
    this.#releaseListeners.add(listener);
    return () => this.#releaseListeners.delete(listener);
  }

  async acquire({ signal, reportPhase } = {}) {
    if (this.#closed) throw new Error('WorkerPool is closed');
    signal?.throwIfAborted();
    const lease = await this.tryAcquireNow(signal);
    if (lease) return lease;
    return await this.#queue({ signal, reportPhase });
  }

  // Non-blocking. The dispatcher calls this and runs its own queue, so it
  // never enters #queue(); direct callers go through acquire().
  async tryAcquireNow(signal) {
    if (this.#closed) return null;
    for (const worker of this.#roster) {
      if (this.#held.has(worker.id)) continue;
      // Reserve in-process before awaiting, so two local callers never race
      // for the same lock file.
      this.#held.add(worker.id);

      const controller = new AbortController();
      let releaseLock;
      try {
        releaseLock = await tryClaim(worker.lockTarget, {
          onCompromised: (err) =>
            controller.abort(new Error(`worker-${worker.id} lock compromised: ${err?.message ?? err}`)),
        });
      } catch (err) {
        this.#held.delete(worker.id);
        throw err;
      }
      if (!releaseLock) {
        this.#held.delete(worker.id);
        continue;
      }

      if (signal) {
        if (signal.aborted) controller.abort(signal.reason);
        else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
      }

      // Load-bearing: a crashed holder's lock goes stale and is stolen, but its
      // files remain. Wipe before handing the worker to the next run.
      try {
        await cleanWorker(worker);
      } catch (err) {
        console.warn(`[pool] cleanup on acquire failed for worker-${worker.id}: ${err.message}`);
      }

      return this.#lease(worker, controller, releaseLock);
    }
    return null;
  }

  #lease(worker, controller, releaseLock) {
    let released = false;
    return {
      workerId: `pool-${worker.id}`,
      doer: worker.doer,
      reviewer: worker.reviewer,
      signal: controller.signal,
      release: async () => {
        if (released) return;
        released = true;
        try {
          await cleanWorker(worker);
        } catch (err) {
          console.warn(`[pool] cleanup on release failed for worker-${worker.id}: ${err.message}`);
        }
        try {
          await releaseLock();
        } catch (err) {
          console.warn(`[pool] releasing worker-${worker.id} lock failed: ${err.message}`);
        }
        // A cleanup or unlock failure must never wedge a worker as busy.
        this.#held.delete(worker.id);
        void this.#serviceWaiters();
        for (const listener of this.#releaseListeners) {
          try {
            listener();
          } catch (err) {
            console.warn(`[pool] release listener threw: ${err?.message ?? err}`);
          }
        }
      },
    };
  }

  #queue({ signal, reportPhase }) {
    return new Promise((resolve, reject) => {
      const waiter = { signal, settled: false };
      this.#waiters.push(waiter);

      const settle = (done, value) => {
        if (waiter.settled) return;
        waiter.settled = true;
        clearInterval(heartbeat);
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        if (this.#waiters.length === 0) this.#stopPolling();
        done(value);
      };
      waiter.grant = (lease) => settle(resolve, lease);

      const announce = () => {
        const position = this.#waiters.indexOf(waiter) + 1;
        Promise.resolve(
          reportPhase?.(`queued for a worker: position ${position}, pool size ${this.size}`),
        ).catch(() => {});
      };
      announce();
      const heartbeat = setInterval(announce, HEARTBEAT_MS);
      heartbeat.unref?.();

      // Keep this timer referenced: an outstanding acquire is real work, and
      // unref() would let the event loop drain before the timeout can reject.
      const timeout = setTimeout(
        () =>
          settle(
            reject,
            new PoolSaturatedError(
              `all ${this.size} workers busy after ${this.#config.acquireTimeoutMs}ms; try again`,
            ),
          ),
        this.#config.acquireTimeoutMs,
      );

      const onAbort = () => settle(reject, signal.reason ?? new Error('acquire aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });

      this.#startPolling();
    });
  }

  // Serves waiters in FIFO order. Re-entrancy guard: an await inside the loop
  // would otherwise let a concurrent release start a second pass.
  async #serviceWaiters() {
    if (this.#servicing) return;
    this.#servicing = true;
    try {
      while (this.#waiters.length > 0) {
        const waiter = this.#waiters[0];
        const lease = await this.tryAcquireNow(waiter.signal);
        if (!lease) return;
        if (waiter.settled) {
          await lease.release();
          continue;
        }
        waiter.grant(lease);
      }
    } finally {
      this.#servicing = false;
    }
  }

  #startPolling() {
    if (this.#pollTimer) return;
    this.#pollTimer = setInterval(
      () => void this.#serviceWaiters(),
      POLL_MS + Math.floor(Math.random() * 250),
    );
    this.#pollTimer.unref?.();
  }

  #stopPolling() {
    if (!this.#pollTimer) return;
    clearInterval(this.#pollTimer);
    this.#pollTimer = null;
  }

  async close() {
    this.#closed = true;
    this.#stopPolling();
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test tests/pool-worker-pool.test.mjs`
Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add pool/worker-pool.mjs tests/pool-worker-pool.test.mjs tests/helpers/mock-fleet.mjs
git commit -m "feat: adapt the worker pool for dispatcher use with public tryAcquireNow and onRelease"
```

---

### Task 4: Workers configuration

One place turns environment into `{ pool, ephemeral, dispatch }` and enforces "at least one tier".

**Files:**
- Create: `pool/config.mjs`
- Test: `tests/pool-config.test.mjs`

**Interfaces produced:**
- `ephemeralConfig(env) → { maxConcurrent, workRoot, ttlMs }`
- `dispatchConfig(env) → { maxQueueSize, queueTimeoutMs }`
- `workersConfig(env) → { pool, ephemeral, dispatch }` — throws if `pool.size === 0 && ephemeral.maxConcurrent === 0`.
- Constants `DEFAULT_EPHEMERAL_MAX = 10`, `DEFAULT_EPHEMERAL_TTL_MS = 600000`, `DEFAULT_QUEUE_SIZE = 20`, `DEFAULT_QUEUE_TIMEOUT_MS = 300000`.

- [ ] **Step 1: Write the failing test**

```js
// tests/pool-config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { dispatchConfig, ephemeralConfig, workersConfig } from '../pool/config.mjs';

test('ephemeralConfig defaults to 10 workers under the OS tmpdir with a 10 minute ttl', () => {
  const config = ephemeralConfig({});
  assert.equal(config.maxConcurrent, 10);
  assert.equal(config.workRoot, path.join(os.tmpdir(), 'workflow-kit'));
  assert.equal(config.ttlMs, 600000);
});

test('ephemeralConfig reads the environment', () => {
  const config = ephemeralConfig({
    WORKER_EPHEMERAL_MAX: '3',
    WORKER_EPHEMERAL_ROOT: '/scratch',
    WORKER_EPHEMERAL_TTL_MS: '5000',
  });
  assert.equal(config.maxConcurrent, 3);
  assert.equal(config.workRoot, path.resolve('/scratch'));
  assert.equal(config.ttlMs, 5000);
});

test('ephemeralConfig accepts zero workers but rejects bad numbers', () => {
  assert.equal(ephemeralConfig({ WORKER_EPHEMERAL_MAX: '0' }).maxConcurrent, 0);
  assert.throws(() => ephemeralConfig({ WORKER_EPHEMERAL_MAX: '-1' }), /WORKER_EPHEMERAL_MAX/);
  assert.throws(() => ephemeralConfig({ WORKER_EPHEMERAL_TTL_MS: '0' }), /WORKER_EPHEMERAL_TTL_MS/);
});

test('dispatchConfig defaults and env', () => {
  assert.deepEqual(dispatchConfig({}), { maxQueueSize: 20, queueTimeoutMs: 300000 });
  assert.deepEqual(
    dispatchConfig({ WORKER_DISPATCH_QUEUE_SIZE: '0', WORKER_DISPATCH_QUEUE_TIMEOUT_MS: '1' }),
    { maxQueueSize: 0, queueTimeoutMs: 1 },
  );
});

test('workersConfig combines all three sections', () => {
  const config = workersConfig({ WORKER_POOL_SIZE: '2', WORKER_EPHEMERAL_MAX: '1' });
  assert.equal(config.pool.size, 2);
  assert.equal(config.ephemeral.maxConcurrent, 1);
  assert.equal(config.dispatch.maxQueueSize, 20);
});

test('workersConfig refuses a configuration with no workers at all', () => {
  assert.throws(
    () => workersConfig({ WORKER_POOL_SIZE: '0', WORKER_EPHEMERAL_MAX: '0' }),
    /no workers configured/,
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/pool-config.test.mjs`
Expected: FAIL — `Cannot find module '../pool/config.mjs'`.

- [ ] **Step 3: Write the config module**

```js
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/pool-config.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add pool/config.mjs tests/pool-config.test.mjs
git commit -m "feat: add workers configuration with ephemeral and dispatch sections"
```

---

### Task 5: Expose provision_llm_auth on fleetApi

`spawnFleet()` already calls the `provision_llm_auth` tool directly on the MCP client for its single member. `MemberManager` needs the same call through `fleetApi`, so add it as an optional method, mirroring how `removeMember` is exposed.

**Files:**
- Modify: `transport/stdio-fleet.mjs:78-81`
- Modify: `tests/transport-stdio-fleet.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `tests/transport-stdio-fleet.test.mjs`:

```js
test('createFleetApi exposes provisionLlmAuth and removeMember only when Fleet has them', async () => {
  const withBoth = await createFleetApi(
    createMockClient({ tools: [...FLEET_TOOLS, 'remove_member'] }),
  );
  assert.equal(typeof withBoth.provisionLlmAuth, 'function');
  assert.equal(typeof withBoth.removeMember, 'function');

  const client = createMockClient({ tools: [...FLEET_TOOLS, 'remove_member'] });
  const api = await createFleetApi(client);
  await api.provisionLlmAuth({ member_name: 'WORKER-1-DOER' });
  await api.removeMember({ member_name: 'WORKER-1-DOER' });
  assert.equal(client.calls[0].name, 'provision_llm_auth');
  assert.deepEqual(client.calls[0].arguments, { member_name: 'WORKER-1-DOER' });
  assert.equal(client.calls[1].name, 'remove_member');

  const minimal = await createFleetApi(
    createMockClient({ tools: FLEET_TOOLS.filter((name) => name !== 'provision_llm_auth') }),
  );
  assert.equal(minimal.provisionLlmAuth, undefined);
  assert.equal(minimal.removeMember, undefined);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/transport-stdio-fleet.test.mjs`
Expected: FAIL — `withBoth.provisionLlmAuth` is `undefined`.

- [ ] **Step 3: Add the optional method**

In `transport/stdio-fleet.mjs`, directly after the `remove_member` block inside `createFleetApi`:

```js
  if (available.has('provision_llm_auth')) {
    api.provisionLlmAuth = (opts) => call('provision_llm_auth', opts);
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/transport-stdio-fleet.test.mjs`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add transport/stdio-fleet.mjs tests/transport-stdio-fleet.test.mjs
git commit -m "feat: expose provisionLlmAuth on the stdio fleetApi"
```

---

### Task 6: MemberManager

The only code that registers, authorises, or removes Fleet members.

**Files:**
- Create: `pool/member-manager.mjs`
- Test: `tests/pool-member-manager.test.mjs`

**Interfaces produced:**
- `new MemberManager(fleetApi, { oauthToken? })`
- `provisionPair(prefix, workRoot) → Promise<{ doer: { name, folder }, reviewer: { name, folder } }>`
- `teardownPair(prefix, workRoot) → Promise<void>`
- `provisionRoster(roster) → Promise<void>`

- [ ] **Step 1: Write the failing test**

```js
// tests/pool-member-manager.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemberManager } from '../pool/member-manager.mjs';
import { buildRoster } from '../pool/roster.mjs';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'member-manager-'));

test('provisionPair registers both roles, creates folders, and authorises both', async () => {
  const fleetApi = createMockFleetApi();
  const manager = new MemberManager(fleetApi, { oauthToken: 'tok' });
  const workRoot = path.join(await tmp(), 'pair');

  const pair = await manager.provisionPair('EPHEMERAL-ABCDEF12', workRoot);

  assert.deepEqual(pair, {
    doer: { name: 'EPHEMERAL-ABCDEF12-DOER', folder: path.join(workRoot, 'doer') },
    reviewer: { name: 'EPHEMERAL-ABCDEF12-REVIEWER', folder: path.join(workRoot, 'reviewer') },
  });
  assert.deepEqual(
    fleetApi.registerCalls.map((call) => call.friendly_name),
    ['EPHEMERAL-ABCDEF12-DOER', 'EPHEMERAL-ABCDEF12-REVIEWER'],
  );
  assert.equal(fleetApi.registerCalls[0].member_type, 'local');
  assert.equal(fleetApi.registerCalls[0].work_folder, pair.doer.folder);
  assert.deepEqual(
    fleetApi.authCalls.map((call) => call.member_name),
    ['EPHEMERAL-ABCDEF12-DOER', 'EPHEMERAL-ABCDEF12-REVIEWER'],
  );
  assert.deepEqual((await fs.readdir(workRoot)).sort(), ['doer', 'reviewer']);
});

test('provisionPair skips members that Fleet already lists', async () => {
  const fleetApi = createMockFleetApi({ members: ['WORKER-1-DOER'] });
  const manager = new MemberManager(fleetApi, { oauthToken: 'tok' });
  await manager.provisionPair('WORKER-1', path.join(await tmp(), 'worker-1'));
  assert.deepEqual(fleetApi.registerCalls.map((call) => call.friendly_name), ['WORKER-1-REVIEWER']);
  assert.equal(fleetApi.authCalls.length, 2, 'auth still runs for both roles');
});

test('provisionPair matches names token-exactly', async () => {
  const fleetApi = createMockFleetApi({ members: ['WORKER-11-DOER', 'WORKER-11-REVIEWER'] });
  const manager = new MemberManager(fleetApi, { oauthToken: 'tok' });
  await manager.provisionPair('WORKER-1', path.join(await tmp(), 'worker-1'));
  assert.deepEqual(
    fleetApi.registerCalls.map((call) => call.friendly_name),
    ['WORKER-1-DOER', 'WORKER-1-REVIEWER'],
  );
});

test('provisionPair rolls back the doer when the reviewer fails to register', async () => {
  const fleetApi = createMockFleetApi({ registerFails: ['EPHEMERAL-BAD00000-REVIEWER'] });
  const manager = new MemberManager(fleetApi, { oauthToken: 'tok' });
  await assert.rejects(
    () => manager.provisionPair('EPHEMERAL-BAD00000', path.join(await tmp(), 'pair')),
    /register_member failed for EPHEMERAL-BAD00000-REVIEWER/,
  );
  assert.deepEqual(fleetApi.removeCalls.map((call) => call.member_name), ['EPHEMERAL-BAD00000-DOER']);
  assert.equal(fleetApi.authCalls.length, 0, 'no auth for a half-provisioned pair');
});

test('provisionPair without a token registers but never calls provisionLlmAuth', async () => {
  const fleetApi = createMockFleetApi();
  const manager = new MemberManager(fleetApi, {});
  await manager.provisionPair('WORKER-1', path.join(await tmp(), 'worker-1'));
  assert.equal(fleetApi.registerCalls.length, 2);
  assert.equal(fleetApi.authCalls.length, 0);
});

test('provisionPair tolerates a Fleet without provision_llm_auth', async () => {
  const fleetApi = createMockFleetApi({ tools: ['remove_member'] });
  const manager = new MemberManager(fleetApi, { oauthToken: 'tok' });
  const pair = await manager.provisionPair('WORKER-1', path.join(await tmp(), 'worker-1'));
  assert.equal(pair.doer.name, 'WORKER-1-DOER');
});

test('teardownPair removes both members and deletes the work root', async () => {
  const fleetApi = createMockFleetApi();
  const manager = new MemberManager(fleetApi, { oauthToken: 'tok' });
  const workRoot = path.join(await tmp(), 'pair');
  await manager.provisionPair('EPHEMERAL-ABCDEF12', workRoot);
  await fs.writeFile(path.join(workRoot, 'doer', 'artifact.txt'), 'x');

  await manager.teardownPair('EPHEMERAL-ABCDEF12', workRoot);

  assert.deepEqual(
    fleetApi.removeCalls.map((call) => call.member_name),
    ['EPHEMERAL-ABCDEF12-DOER', 'EPHEMERAL-ABCDEF12-REVIEWER'],
  );
  assert.equal(fleetApi.present.has('EPHEMERAL-ABCDEF12-DOER'), false);
  await assert.rejects(() => fs.access(workRoot));
});

test('teardownPair still deletes the folder when Fleet has no remove_member', async () => {
  const fleetApi = createMockFleetApi({ tools: ['provision_llm_auth'] });
  const manager = new MemberManager(fleetApi, { oauthToken: 'tok' });
  const workRoot = path.join(await tmp(), 'pair');
  await manager.provisionPair('EPHEMERAL-ABCDEF12', workRoot);
  await manager.teardownPair('EPHEMERAL-ABCDEF12', workRoot);
  await assert.rejects(() => fs.access(workRoot));
});

test('provisionRoster registers and authorises every roster member in order', async () => {
  const fleetApi = createMockFleetApi();
  const manager = new MemberManager(fleetApi, { oauthToken: 'tok' });
  const root = await tmp();
  const roster = buildRoster({ size: 2, root });

  await manager.provisionRoster(roster);

  assert.deepEqual(fleetApi.registerCalls.map((call) => call.friendly_name), rosterNames(2));
  assert.deepEqual(fleetApi.authCalls.map((call) => call.member_name), rosterNames(2));
  assert.deepEqual((await fs.readdir(path.join(root, 'worker-2'))).sort(), ['doer', 'reviewer']);
});

test('provisionRoster fails fast on the first member that cannot register', async () => {
  const fleetApi = createMockFleetApi({ registerFails: ['WORKER-1-REVIEWER'] });
  const manager = new MemberManager(fleetApi, { oauthToken: 'tok' });
  await assert.rejects(
    () => manager.provisionRoster(buildRoster({ size: 2, root: await tmp() })),
    /WORKER-1-REVIEWER/,
  );
  assert.equal(fleetApi.registerCalls.length, 2, 'must not continue to worker-2');
});

test('constructor requires fleetApi', () => {
  assert.throws(() => new MemberManager(undefined, {}), /requires fleetApi/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/pool-member-manager.test.mjs`
Expected: FAIL — `Cannot find module '../pool/member-manager.mjs'`.

- [ ] **Step 3: Write MemberManager**

```js
// pool/member-manager.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { memberIsPresent, toolResultLooksFailed, toolText } from './fleet-text.mjs';

// The single owner of member lifecycle. Nothing else in the kit may call
// registerMember, removeMember, or provisionLlmAuth.
export class MemberManager {
  #fleetApi;
  #oauthToken;
  #warnedNoAuth = false;

  constructor(fleetApi, { oauthToken } = {}) {
    if (!fleetApi) throw new Error('MemberManager requires fleetApi');
    this.#fleetApi = fleetApi;
    this.#oauthToken = oauthToken ?? null;
  }

  async provisionPair(prefix, workRoot) {
    const doer = { name: `${prefix}-DOER`, folder: path.join(workRoot, 'doer') };
    const reviewer = { name: `${prefix}-REVIEWER`, folder: path.join(workRoot, 'reviewer') };

    await this.#ensureRegistered(doer);
    try {
      await this.#ensureRegistered(reviewer);
    } catch (err) {
      // Never leave half a pair behind: a run holding only a doer cannot work.
      await this.#tryRemove(doer.name);
      throw err;
    }

    await this.#provisionAuth(doer.name);
    await this.#provisionAuth(reviewer.name);
    return { doer, reviewer };
  }

  async teardownPair(prefix, workRoot) {
    await this.#tryRemove(`${prefix}-DOER`);
    await this.#tryRemove(`${prefix}-REVIEWER`);
    await fs.rm(workRoot, { recursive: true, force: true });
  }

  // Fails on the first problem. A pool that started with a missing member
  // would fail later inside a run with an error that looks unrelated.
  async provisionRoster(roster) {
    for (const worker of roster) {
      await this.#ensureRegistered(worker.doer);
      await this.#ensureRegistered(worker.reviewer);
      await this.#provisionAuth(worker.doer.name);
      await this.#provisionAuth(worker.reviewer.name);
    }
  }

  async #ensureRegistered({ name, folder }) {
    await fs.mkdir(folder, { recursive: true });
    if (await this.#isPresent(name)) return;

    const result = await this.#fleetApi.registerMember({
      friendly_name: name,
      work_folder: folder,
      member_type: 'local',
    });
    if (!toolResultLooksFailed(result)) return;

    // Fleet may report an already-present member as an error; re-check before failing.
    if (await this.#isPresent(name)) return;
    throw new Error(`register_member failed for ${name}: ${toolText(result)}`);
  }

  async #isPresent(name) {
    return memberIsPresent(toolText(await this.#fleetApi.listMembers({})), name);
  }

  async #provisionAuth(name) {
    if (!this.#oauthToken) {
      if (!this.#warnedNoAuth) {
        this.#warnedNoAuth = true;
        console.warn('[member-manager] no OAuth token; members cannot run agent prompts');
      }
      return;
    }
    if (typeof this.#fleetApi.provisionLlmAuth !== 'function') {
      if (!this.#warnedNoAuth) {
        this.#warnedNoAuth = true;
        console.warn('[member-manager] Fleet exposes no provision_llm_auth; members cannot run agent prompts');
      }
      return;
    }
    try {
      const result = await this.#fleetApi.provisionLlmAuth({ member_name: name });
      if (toolResultLooksFailed(result)) {
        console.warn(`[member-manager] OAuth provisioning failed for ${name}: ${toolText(result)}`);
      }
    } catch (err) {
      console.warn(`[member-manager] OAuth provisioning failed for ${name}: ${err?.message ?? err}`);
    }
  }

  // An orphaned registration whose folder is gone is harmless; a thrown
  // teardown that wedges a release is not.
  async #tryRemove(name) {
    if (typeof this.#fleetApi.removeMember !== 'function') return;
    try {
      await this.#fleetApi.removeMember({ member_name: name });
    } catch (err) {
      console.warn(`[member-manager] remove_member failed for ${name}: ${err?.message ?? err}`);
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/pool-member-manager.test.mjs`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add pool/member-manager.mjs tests/pool-member-manager.test.mjs
git commit -m "feat: add MemberManager as the single owner of Fleet member lifecycle"
```

---

### Task 7: EphemeralWorkerFactory

**Files:**
- Create: `pool/ephemeral-factory.mjs`
- Test: `tests/pool-ephemeral-factory.test.mjs`

**Interfaces produced:**
- `new EphemeralWorkerFactory({ memberManager, config: { maxConcurrent, workRoot, ttlMs } })`
- `factory.active → number`, `factory.maxConcurrent → number`
- `factory.onRelease(listener) → unsubscribe`
- `factory.create({ signal? }) → Promise<Lease | null>` (null at cap or after close; throws if provisioning throws)
- `factory.close() → Promise<void>` (tears down every active lease)

- [ ] **Step 1: Write the failing test**

```js
// tests/pool-ephemeral-factory.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EphemeralWorkerFactory } from '../pool/ephemeral-factory.mjs';
import { MemberManager } from '../pool/member-manager.mjs';
import { createMockFleetApi } from './helpers/mock-fleet.mjs';

async function makeFactory({ maxConcurrent = 2, ttlMs = 600000, fleetApi = createMockFleetApi() } = {}) {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ephemeral-'));
  const memberManager = new MemberManager(fleetApi, { oauthToken: 'tok' });
  const factory = new EphemeralWorkerFactory({
    memberManager,
    config: { maxConcurrent, workRoot, ttlMs },
  });
  return { factory, fleetApi, workRoot };
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

test('create registers a guid-named pair under workRoot and returns a lease', async () => {
  const { factory, fleetApi, workRoot } = await makeFactory();
  const lease = await factory.create();

  assert.match(lease.workerId, /^ephemeral-[0-9a-f]{8}$/);
  const shortId = lease.workerId.slice('ephemeral-'.length).toUpperCase();
  assert.equal(lease.doer.name, `EPHEMERAL-${shortId}-DOER`);
  assert.equal(lease.reviewer.name, `EPHEMERAL-${shortId}-REVIEWER`);
  assert.equal(path.dirname(path.dirname(lease.doer.folder)), workRoot);
  assert.equal(path.basename(lease.doer.folder), 'doer');
  assert.equal(fleetApi.registerCalls.length, 2);
  assert.equal(factory.active, 1);
  await lease.release();
  await factory.close();
});

test('release unregisters both members, deletes the folder, and frees the slot', async () => {
  const { factory, fleetApi } = await makeFactory();
  const lease = await factory.create();
  const pairRoot = path.dirname(lease.doer.folder);
  await fs.writeFile(path.join(lease.doer.folder, 'out.txt'), 'x');

  let fired = 0;
  factory.onRelease(() => { fired += 1; });
  await lease.release();
  await lease.release();

  assert.deepEqual(
    fleetApi.removeCalls.map((call) => call.member_name),
    [lease.doer.name, lease.reviewer.name],
  );
  await assert.rejects(() => fs.access(pairRoot));
  assert.equal(factory.active, 0);
  assert.equal(fired, 1, 'release is idempotent and notifies once');
  await factory.close();
});

test('create returns null at maxConcurrent and resumes after a release', async () => {
  const { factory } = await makeFactory({ maxConcurrent: 1 });
  const first = await factory.create();
  assert.equal(await factory.create(), null);
  await first.release();
  const second = await factory.create();
  assert.notEqual(second, null);
  await second.release();
  await factory.close();
});

test('concurrent creates never overshoot maxConcurrent', async () => {
  const { factory } = await makeFactory({ maxConcurrent: 2 });
  const leases = await Promise.all([factory.create(), factory.create(), factory.create()]);
  assert.equal(leases.filter(Boolean).length, 2);
  assert.equal(leases.filter((lease) => lease === null).length, 1);
  await Promise.all(leases.filter(Boolean).map((lease) => lease.release()));
  await factory.close();
});

test('a provisioning failure frees the slot and propagates', async () => {
  const fleetApi = createMockFleetApi({ registerFails: [] });
  const { factory } = await makeFactory({ maxConcurrent: 1, fleetApi });
  fleetApi.registerMember = async () => ({ content: [{ type: 'text', text: '❌ fleet is full' }] });
  await assert.rejects(() => factory.create(), /fleet is full/);
  assert.equal(factory.active, 0);
  await factory.close();
});

test('the lease signal follows the caller signal', async () => {
  const { factory } = await makeFactory();
  const controller = new AbortController();
  const lease = await factory.create({ signal: controller.signal });
  assert.equal(lease.signal.aborted, false);
  controller.abort(new Error('caller cancelled'));
  assert.equal(lease.signal.aborted, true);
  assert.match(String(lease.signal.reason?.message), /caller cancelled/);
  await lease.release();
  await factory.close();
});

test('the ttl aborts the lease and tears the worker down', async () => {
  const { factory, fleetApi } = await makeFactory({ ttlMs: 40 });
  const lease = await factory.create();
  await tick(120);
  assert.equal(lease.signal.aborted, true);
  assert.match(String(lease.signal.reason?.message), /ttl/);
  assert.equal(fleetApi.removeCalls.length, 2);
  assert.equal(factory.active, 0);
  await lease.release();
  await factory.close();
});

test('close tears down every active lease and refuses new ones', async () => {
  const { factory, fleetApi } = await makeFactory({ maxConcurrent: 2 });
  await factory.create();
  await factory.create();
  await factory.close();
  assert.equal(fleetApi.removeCalls.length, 4);
  assert.equal(factory.active, 0);
  assert.equal(await factory.create(), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/pool-ephemeral-factory.test.mjs`
Expected: FAIL — `Cannot find module '../pool/ephemeral-factory.mjs'`.

- [ ] **Step 3: Write the factory**

```js
// pool/ephemeral-factory.mjs
import crypto from 'node:crypto';
import path from 'node:path';

// On-demand doer+reviewer pairs for overflow and serverless deployment. Each
// pair has a unique id, so no two callers can ever share one -- no lock needed.
export class EphemeralWorkerFactory {
  #manager;
  #config;
  #active = new Set();
  #releaseListeners = new Set();
  #closed = false;

  constructor({ memberManager, config } = {}) {
    if (!memberManager) throw new Error('EphemeralWorkerFactory requires memberManager');
    if (!config) throw new Error('EphemeralWorkerFactory requires config');
    this.#manager = memberManager;
    this.#config = config;
  }

  get active() { return this.#active.size; }
  get maxConcurrent() { return this.#config.maxConcurrent; }

  onRelease(listener) {
    this.#releaseListeners.add(listener);
    return () => this.#releaseListeners.delete(listener);
  }

  async create({ signal } = {}) {
    if (this.#closed) return null;
    if (this.#active.size >= this.#config.maxConcurrent) return null;
    signal?.throwIfAborted();

    const id = crypto.randomUUID();
    const shortId = id.slice(0, 8);
    const prefix = `EPHEMERAL-${shortId.toUpperCase()}`;
    const workRoot = path.join(this.#config.workRoot, id);

    // Reserve the slot before the slow registration so concurrent creates
    // cannot overshoot maxConcurrent.
    const entry = { release: null };
    this.#active.add(entry);

    let pair;
    try {
      pair = await this.#manager.provisionPair(prefix, workRoot);
    } catch (err) {
      this.#active.delete(entry);
      throw err;
    }

    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }

    let ttl = null;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      if (ttl) clearTimeout(ttl);
      try {
        await this.#manager.teardownPair(prefix, workRoot);
      } catch (err) {
        console.warn(`[ephemeral] teardown failed for ${prefix}: ${err?.message ?? err}`);
      }
      this.#active.delete(entry);
      for (const listener of this.#releaseListeners) {
        try {
          listener();
        } catch (err) {
          console.warn(`[ephemeral] release listener threw: ${err?.message ?? err}`);
        }
      }
    };
    entry.release = release;

    // Safety net: a task that never releases would leak a Fleet member and a
    // folder under tmpdir. Abort it cooperatively, then tear down regardless.
    ttl = setTimeout(() => {
      controller.abort(new Error(`ephemeral worker ${shortId} exceeded ttl ${this.#config.ttlMs}ms`));
      void release();
    }, this.#config.ttlMs);
    ttl.unref?.();

    return {
      workerId: `ephemeral-${shortId}`,
      doer: pair.doer,
      reviewer: pair.reviewer,
      signal: controller.signal,
      release,
    };
  }

  async close() {
    this.#closed = true;
    await Promise.all([...this.#active].map((entry) => entry.release?.()));
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/pool-ephemeral-factory.test.mjs`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add pool/ephemeral-factory.mjs tests/pool-ephemeral-factory.test.mjs
git commit -m "feat: add EphemeralWorkerFactory for on-demand tmpdir worker pairs"
```

---

### Task 8: WorkerDispatcher

**Files:**
- Create: `pool/worker-dispatcher.mjs`
- Test: `tests/pool-worker-dispatcher.test.mjs`

**Interfaces produced:**
- `new WorkerDispatcher({ pool: WorkerPool | null, ephemeral: EphemeralWorkerFactory | null, config: { maxQueueSize, queueTimeoutMs } })` — throws if both tiers are null.
- `dispatcher.capacity → number` (pool size + ephemeral max).
- `dispatcher.queued → number`.
- `dispatcher.dispatch({ signal?, reportPhase? }) → Promise<Lease>` — throws `DispatchOverflowError` when the queue is full or the queue wait times out; rethrows the signal reason on abort.
- `dispatcher.close() → Promise<void>` — rejects queued waiters, closes both tiers.
- `DispatchOverflowError`, `HEARTBEAT_MS`.

The tests use a real `WorkerPool` over a tmpdir plus a small fake ephemeral tier, so tier ordering is observable without a MemberManager.

- [ ] **Step 1: Write the failing test**

```js
// tests/pool-worker-dispatcher.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DispatchOverflowError, WorkerDispatcher } from '../pool/worker-dispatcher.mjs';
import { WorkerPool } from '../pool/worker-pool.mjs';

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

async function makePool(size) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatcher-pool-'));
  return WorkerPool.create({ config: { size, root, acquireTimeoutMs: 5000 } });
}

// Same contract as EphemeralWorkerFactory, minus Fleet.
function fakeEphemeral({ maxConcurrent = 1, failWith = null } = {}) {
  const listeners = new Set();
  let active = 0;
  let counter = 0;
  return {
    get active() { return active; },
    maxConcurrent,
    created: [],
    onRelease(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async create({ signal } = {}) {
      if (failWith) throw failWith;
      if (active >= maxConcurrent) return null;
      active += 1;
      counter += 1;
      const id = `ephemeral-${String(counter).padStart(8, '0')}`;
      this.created.push(id);
      const controller = new AbortController();
      signal?.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
      let released = false;
      return {
        workerId: id,
        doer: { name: `${id}-DOER`, folder: `/tmp/${id}/doer` },
        reviewer: { name: `${id}-REVIEWER`, folder: `/tmp/${id}/reviewer` },
        signal: controller.signal,
        release: async () => {
          if (released) return;
          released = true;
          active -= 1;
          for (const listener of listeners) listener();
        },
      };
    },
    async close() {},
  };
}

function makeDispatcher({ pool = null, ephemeral = null, maxQueueSize = 10, queueTimeoutMs = 5000 } = {}) {
  return new WorkerDispatcher({ pool, ephemeral, config: { maxQueueSize, queueTimeoutMs } });
}

test('constructor refuses a dispatcher with no tiers', () => {
  assert.throws(() => makeDispatcher(), /no workers configured/);
});

test('capacity is pool size plus ephemeral max', async () => {
  const dispatcher = makeDispatcher({ pool: await makePool(2), ephemeral: fakeEphemeral({ maxConcurrent: 3 }) });
  assert.equal(dispatcher.capacity, 5);
  await dispatcher.close();
});

test('tier 1: the pool serves first', async () => {
  const ephemeral = fakeEphemeral();
  const dispatcher = makeDispatcher({ pool: await makePool(1), ephemeral });
  const lease = await dispatcher.dispatch();
  assert.equal(lease.workerId, 'pool-1');
  assert.deepEqual(ephemeral.created, []);
  await lease.release();
  await dispatcher.close();
});

test('tier 2: ephemeral serves when the pool is full', async () => {
  const ephemeral = fakeEphemeral({ maxConcurrent: 1 });
  const dispatcher = makeDispatcher({ pool: await makePool(1), ephemeral });
  const first = await dispatcher.dispatch();
  const second = await dispatcher.dispatch();
  assert.equal(first.workerId, 'pool-1');
  assert.match(second.workerId, /^ephemeral-/);
  await first.release();
  await second.release();
  await dispatcher.close();
});

test('tier 3: the queue holds callers and a pool release serves the head', async () => {
  const dispatcher = makeDispatcher({ pool: await makePool(1), ephemeral: fakeEphemeral({ maxConcurrent: 1 }) });
  const first = await dispatcher.dispatch();
  const second = await dispatcher.dispatch();
  let settled = false;
  const third = dispatcher.dispatch().then((lease) => { settled = true; return lease; });
  await tick();
  assert.equal(settled, false);
  assert.equal(dispatcher.queued, 1);

  await first.release();
  const lease = await third;
  assert.equal(lease.workerId, 'pool-1', 'the freed pool worker serves the queued caller');
  assert.equal(dispatcher.queued, 0);
  await second.release();
  await lease.release();
  await dispatcher.close();
});

test('an ephemeral release also serves the queue', async () => {
  const ephemeral = fakeEphemeral({ maxConcurrent: 1 });
  const dispatcher = makeDispatcher({ pool: await makePool(1), ephemeral });
  const first = await dispatcher.dispatch();
  const second = await dispatcher.dispatch();
  const third = dispatcher.dispatch();
  await tick();
  await second.release();
  const lease = await third;
  assert.match(lease.workerId, /^ephemeral-/, 'whichever tier frees first serves');
  await first.release();
  await lease.release();
  await dispatcher.close();
});

test('queued callers are served in FIFO order', async () => {
  const dispatcher = makeDispatcher({ pool: await makePool(1) });
  const held = await dispatcher.dispatch();
  const order = [];
  const a = dispatcher.dispatch().then((lease) => { order.push('a'); return lease; });
  const b = dispatcher.dispatch().then((lease) => { order.push('b'); return lease; });
  await tick();
  await held.release();
  const leaseA = await a;
  await leaseA.release();
  const leaseB = await b;
  await leaseB.release();
  assert.deepEqual(order, ['a', 'b']);
  await dispatcher.close();
});

test('a full queue rejects with DispatchOverflowError', async () => {
  const dispatcher = makeDispatcher({ pool: await makePool(1), maxQueueSize: 0 });
  const held = await dispatcher.dispatch();
  await assert.rejects(() => dispatcher.dispatch(), (err) => {
    assert.ok(err instanceof DispatchOverflowError);
    assert.match(err.message, /busy/);
    return true;
  });
  await held.release();
  await dispatcher.close();
});

test('a queue wait that times out rejects with DispatchOverflowError', async () => {
  const dispatcher = makeDispatcher({ pool: await makePool(1), queueTimeoutMs: 60 });
  const held = await dispatcher.dispatch();
  await assert.rejects(() => dispatcher.dispatch(), DispatchOverflowError);
  await held.release();
  await dispatcher.close();
});

test('an ephemeral creation failure falls through to the queue', async () => {
  const ephemeral = fakeEphemeral({ failWith: new Error('registration exploded') });
  const dispatcher = makeDispatcher({ pool: await makePool(1), ephemeral, queueTimeoutMs: 60 });
  const held = await dispatcher.dispatch();
  await assert.rejects(() => dispatcher.dispatch(), DispatchOverflowError);
  await held.release();
  await dispatcher.close();
});

test('aborting while queued removes the waiter', async () => {
  const dispatcher = makeDispatcher({ pool: await makePool(1) });
  const held = await dispatcher.dispatch();
  const controller = new AbortController();
  const waiting = dispatcher.dispatch({ signal: controller.signal });
  await tick();
  controller.abort(new Error('caller went away'));
  await assert.rejects(() => waiting, /caller went away/);
  assert.equal(dispatcher.queued, 0);
  await held.release();
  const next = await dispatcher.dispatch();
  assert.equal(next.workerId, 'pool-1');
  await next.release();
  await dispatcher.close();
});

test('a queued caller receives heartbeats with position and capacity', async () => {
  const dispatcher = makeDispatcher({ pool: await makePool(1), ephemeral: fakeEphemeral({ maxConcurrent: 1 }) });
  const first = await dispatcher.dispatch();
  const second = await dispatcher.dispatch();
  const phases = [];
  const third = dispatcher.dispatch({ reportPhase: (message) => phases.push(message) });
  await tick();
  assert.equal(phases.length, 1);
  assert.match(phases[0], /position 1/);
  assert.match(phases[0], /capacity 2/);
  await first.release();
  await (await third).release();
  await second.release();
  await dispatcher.close();
});

test('ephemeral-only dispatch works with no pool', async () => {
  const dispatcher = makeDispatcher({ ephemeral: fakeEphemeral({ maxConcurrent: 1 }) });
  const lease = await dispatcher.dispatch();
  assert.match(lease.workerId, /^ephemeral-/);
  await lease.release();
  await dispatcher.close();
});

test('close rejects queued waiters and refuses new dispatches', async () => {
  const dispatcher = makeDispatcher({ pool: await makePool(1) });
  const held = await dispatcher.dispatch();
  const waiting = dispatcher.dispatch();
  await tick();
  await dispatcher.close();
  await assert.rejects(() => waiting, /shutting down/);
  await assert.rejects(() => dispatcher.dispatch(), /closed/);
  await held.release();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/pool-worker-dispatcher.test.mjs`
Expected: FAIL — `Cannot find module '../pool/worker-dispatcher.mjs'`.

- [ ] **Step 3: Write the dispatcher**

```js
// pool/worker-dispatcher.mjs

// Beats the 60s first-response-byte timer immediately, then the 5-minute idle
// timer every 30s. See docs/mcp-interface.md for the timer inventory.
export const HEARTBEAT_MS = 30000;

export class DispatchOverflowError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DispatchOverflowError';
  }
}

// Tries pool -> ephemeral -> queue -> reject. Owns the one queue shared by both
// tiers; a release from either tier wakes the head of the queue.
export class WorkerDispatcher {
  #pool;
  #ephemeral;
  #config;
  #waiters = [];
  #servicing = false;
  #rerun = false;
  #closed = false;
  #unsubscribe = [];

  constructor({ pool = null, ephemeral = null, config } = {}) {
    if (!pool && !ephemeral) {
      throw new Error(
        'no workers configured — set WORKER_POOL_SIZE > 0, WORKER_EPHEMERAL_MAX > 0, or both',
      );
    }
    if (!config) throw new Error('WorkerDispatcher requires config');
    this.#pool = pool;
    this.#ephemeral = ephemeral;
    this.#config = config;
    if (pool) this.#unsubscribe.push(pool.onRelease(() => void this.#serviceWaiters()));
    if (ephemeral) this.#unsubscribe.push(ephemeral.onRelease(() => void this.#serviceWaiters()));
  }

  get capacity() {
    return (this.#pool?.size ?? 0) + (this.#ephemeral?.maxConcurrent ?? 0);
  }

  get queued() {
    return this.#waiters.length;
  }

  async dispatch({ signal, reportPhase } = {}) {
    if (this.#closed) throw new Error('WorkerDispatcher is closed');
    signal?.throwIfAborted();

    const lease = await this.#tryTiers(signal);
    if (lease) return lease;

    if (this.#waiters.length >= this.#config.maxQueueSize) {
      throw new DispatchOverflowError(
        `all ${this.capacity} workers busy and the queue is full (${this.#config.maxQueueSize}); retry later`,
      );
    }
    return this.#enqueue({ signal, reportPhase });
  }

  // Pool first: zero registration cost. Ephemeral second: pays registration
  // but still serves. A failing ephemeral tier is treated as "no capacity",
  // never surfaced to the caller as a registration error.
  async #tryTiers(signal) {
    if (this.#pool) {
      const lease = await this.#pool.tryAcquireNow(signal);
      if (lease) return lease;
    }
    if (this.#ephemeral) {
      try {
        const lease = await this.#ephemeral.create({ signal });
        if (lease) return lease;
      } catch (err) {
        console.warn(`[dispatcher] ephemeral worker creation failed: ${err?.message ?? err}`);
      }
    }
    return null;
  }

  #enqueue({ signal, reportPhase }) {
    return new Promise((resolve, reject) => {
      const waiter = { signal, settled: false };
      this.#waiters.push(waiter);

      const settle = (done, value) => {
        if (waiter.settled) return;
        waiter.settled = true;
        clearInterval(heartbeat);
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        done(value);
      };
      waiter.grant = (lease) => settle(resolve, lease);
      waiter.fail = (err) => settle(reject, err);

      const announce = () => {
        const position = this.#waiters.indexOf(waiter) + 1;
        Promise.resolve(
          reportPhase?.(`queued for a worker: position ${position}, capacity ${this.capacity}`),
        ).catch(() => {});
      };
      announce();
      const heartbeat = setInterval(announce, HEARTBEAT_MS);
      heartbeat.unref?.();

      // Referenced on purpose: a queued dispatch is real work and must be able
      // to reject even if nothing else keeps the event loop alive.
      const timeout = setTimeout(
        () =>
          settle(
            reject,
            new DispatchOverflowError(
              `all ${this.capacity} workers busy after ${this.#config.queueTimeoutMs}ms; retry later`,
            ),
          ),
        this.#config.queueTimeoutMs,
      );

      const onAbort = () => settle(reject, signal.reason ?? new Error('dispatch aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  // FIFO. Guarded against re-entry; a release that lands mid-pass sets #rerun
  // so the freed capacity is not missed.
  async #serviceWaiters() {
    if (this.#servicing) {
      this.#rerun = true;
      return;
    }
    this.#servicing = true;
    try {
      do {
        this.#rerun = false;
        while (this.#waiters.length > 0) {
          const waiter = this.#waiters[0];
          if (waiter.settled) {
            this.#waiters.shift();
            continue;
          }
          const lease = await this.#tryTiers(waiter.signal);
          if (!lease) break;
          if (waiter.settled) {
            await lease.release();
            continue;
          }
          waiter.grant(lease);
        }
      } while (this.#rerun);
    } finally {
      this.#servicing = false;
    }
  }

  async close() {
    this.#closed = true;
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    for (const waiter of [...this.#waiters]) {
      waiter.fail?.(new Error('dispatcher is shutting down'));
    }
    await this.#ephemeral?.close();
    await this.#pool?.close();
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/pool-worker-dispatcher.test.mjs`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add pool/worker-dispatcher.mjs tests/pool-worker-dispatcher.test.mjs
git commit -m "feat: add WorkerDispatcher with pool, ephemeral, and queue tiers"
```

---

### Task 9: createWorkerDispatcher — the startup recipe

One async factory performs the startup lifecycle from the spec: MemberManager → provision roster (if pool.size > 0) → WorkerPool → EphemeralWorkerFactory (if maxConcurrent > 0) → WorkerDispatcher.

**Files:**
- Create: `pool/index.mjs`
- Test: `tests/pool-index.test.mjs`

**Interfaces produced:**
- `createWorkerDispatcher({ fleetApi, env?, config?, oauthToken? }) → Promise<WorkerDispatcher>`
- Re-exports: `WorkerDispatcher`, `DispatchOverflowError`, `WorkerPool`, `EphemeralWorkerFactory`, `MemberManager`, `createPooledFleetApi`, `workersConfig`.

- [ ] **Step 1: Write the failing test**

```js
// tests/pool-index.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkerDispatcher } from '../pool/index.mjs';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';

async function roots() {
  return {
    pool: await fs.mkdtemp(path.join(os.tmpdir(), 'index-pool-')),
    ephemeral: await fs.mkdtemp(path.join(os.tmpdir(), 'index-eph-')),
  };
}

test('hybrid: provisions the roster, then serves pool before ephemeral', async () => {
  const fleetApi = createMockFleetApi();
  const { pool, ephemeral } = await roots();
  const dispatcher = await createWorkerDispatcher({
    fleetApi,
    oauthToken: 'tok',
    config: {
      pool: { size: 1, root: pool, acquireTimeoutMs: 1000 },
      ephemeral: { maxConcurrent: 1, workRoot: ephemeral, ttlMs: 60000 },
      dispatch: { maxQueueSize: 2, queueTimeoutMs: 1000 },
    },
  });

  assert.deepEqual(fleetApi.registerCalls.map((call) => call.friendly_name), rosterNames(1));
  assert.equal(fleetApi.authCalls.length, 2);
  assert.equal(dispatcher.capacity, 2);

  const first = await dispatcher.dispatch();
  const second = await dispatcher.dispatch();
  assert.equal(first.workerId, 'pool-1');
  assert.match(second.workerId, /^ephemeral-/);
  assert.equal(fleetApi.registerCalls.length, 4, 'the ephemeral pair registered on demand');

  await second.release();
  assert.equal(fleetApi.removeCalls.length, 2, 'ephemeral pair removed on release');
  await first.release();
  assert.equal(fleetApi.removeCalls.length, 2, 'pool members are never removed');
  await dispatcher.close();
});

test('ephemeral-only: pool.size 0 registers nothing at startup', async () => {
  const fleetApi = createMockFleetApi();
  const { pool, ephemeral } = await roots();
  const dispatcher = await createWorkerDispatcher({
    fleetApi,
    config: {
      pool: { size: 0, root: pool, acquireTimeoutMs: 1000 },
      ephemeral: { maxConcurrent: 2, workRoot: ephemeral, ttlMs: 60000 },
      dispatch: { maxQueueSize: 2, queueTimeoutMs: 1000 },
    },
  });
  assert.equal(fleetApi.registerCalls.length, 0);
  const lease = await dispatcher.dispatch();
  assert.match(lease.workerId, /^ephemeral-/);
  await lease.release();
  await dispatcher.close();
});

test('pool-only: maxConcurrent 0 never creates ephemeral workers', async () => {
  const fleetApi = createMockFleetApi();
  const { pool, ephemeral } = await roots();
  const dispatcher = await createWorkerDispatcher({
    fleetApi,
    config: {
      pool: { size: 1, root: pool, acquireTimeoutMs: 1000 },
      ephemeral: { maxConcurrent: 0, workRoot: ephemeral, ttlMs: 60000 },
      dispatch: { maxQueueSize: 0, queueTimeoutMs: 1000 },
    },
  });
  const held = await dispatcher.dispatch();
  await assert.rejects(() => dispatcher.dispatch(), /busy/);
  assert.equal(fleetApi.registerCalls.length, 2, 'only the roster was registered');
  await held.release();
  await dispatcher.close();
});

test('reads env when no config is given and forwards CLAUDE_CODE_OAUTH_TOKEN', async () => {
  const fleetApi = createMockFleetApi();
  const { pool, ephemeral } = await roots();
  const dispatcher = await createWorkerDispatcher({
    fleetApi,
    env: {
      WORKER_POOL_SIZE: '1',
      WORKER_POOL_ROOT: pool,
      WORKER_EPHEMERAL_MAX: '0',
      WORKER_EPHEMERAL_ROOT: ephemeral,
      CLAUDE_CODE_OAUTH_TOKEN: 'from-env',
    },
  });
  assert.equal(fleetApi.authCalls.length, 2);
  await dispatcher.close();
});

test('a roster member that cannot register is fatal', async () => {
  const fleetApi = createMockFleetApi({ registerFails: ['WORKER-1-REVIEWER'] });
  const { pool, ephemeral } = await roots();
  await assert.rejects(
    () =>
      createWorkerDispatcher({
        fleetApi,
        config: {
          pool: { size: 1, root: pool, acquireTimeoutMs: 1000 },
          ephemeral: { maxConcurrent: 0, workRoot: ephemeral, ttlMs: 60000 },
          dispatch: { maxQueueSize: 0, queueTimeoutMs: 1000 },
        },
      }),
    /WORKER-1-REVIEWER/,
  );
});

test('requires fleetApi', async () => {
  await assert.rejects(() => createWorkerDispatcher({}), /requires fleetApi/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/pool-index.test.mjs`
Expected: FAIL — `Cannot find module '../pool/index.mjs'`.

- [ ] **Step 3: Write the factory**

```js
// pool/index.mjs
import { workersConfig } from './config.mjs';
import { EphemeralWorkerFactory } from './ephemeral-factory.mjs';
import { MemberManager } from './member-manager.mjs';
import { buildRoster } from './roster.mjs';
import { WorkerDispatcher } from './worker-dispatcher.mjs';
import { WorkerPool } from './worker-pool.mjs';

export { DispatchOverflowError, WorkerDispatcher } from './worker-dispatcher.mjs';
export { WorkerPool } from './worker-pool.mjs';
export { EphemeralWorkerFactory } from './ephemeral-factory.mjs';
export { MemberManager } from './member-manager.mjs';
export { createPooledFleetApi } from './pooled-fleet-api.mjs';
export { workersConfig } from './config.mjs';

// The startup lifecycle from the spec, in dependency order. A roster failure
// here is deliberately fatal: better a loud startup error than an agent()
// call failing deep inside a run.
export async function createWorkerDispatcher({ fleetApi, env = process.env, config, oauthToken } = {}) {
  if (!fleetApi) throw new Error('createWorkerDispatcher requires fleetApi');
  const resolved = config ?? workersConfig(env);
  const memberManager = new MemberManager(fleetApi, {
    oauthToken: oauthToken ?? env.CLAUDE_CODE_OAUTH_TOKEN,
  });

  let pool = null;
  if (resolved.pool.size > 0) {
    const roster = buildRoster(resolved.pool);
    await memberManager.provisionRoster(roster);
    pool = WorkerPool.create({ config: resolved.pool, roster });
  }

  let ephemeral = null;
  if (resolved.ephemeral.maxConcurrent > 0) {
    ephemeral = new EphemeralWorkerFactory({ memberManager, config: resolved.ephemeral });
  }

  return new WorkerDispatcher({ pool, ephemeral, config: resolved.dispatch });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/pool-index.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add pool/index.mjs tests/pool-index.test.mjs
git commit -m "feat: add createWorkerDispatcher startup recipe"
```

---

### Task 10: Wire the dispatcher into mcp/server.mjs

Every tool call takes a lease, runs with a `PooledFleetApi`, and releases in `finally`. Tools receive a new `workspace` argument. The MCP test suite switches to the shared mock and a real dispatcher over a tmpdir pool, so it stays offline.

**Files:**
- Modify: `mcp/server.mjs`
- Modify: `tests/mcp.test.mjs`

Tool `run()` contract after this task: `run({ fleetApi, args, signal, reportPhase, workspace })` where `fleetApi` already resolves `'doer'`/`'reviewer'`, `signal` is the lease signal, and `workspace` is `{ workerId, doer: { name, folder }, reviewer: { name, folder } }`.

- [ ] **Step 1: Update the MCP test harness (failing)**

In `tests/mcp.test.mjs`:

1. Replace the imports block at the top with:

```js
import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { WorkerDispatcher } from '../pool/worker-dispatcher.mjs';
import { WorkerPool } from '../pool/worker-pool.mjs';
import { createMockFleetApi as createSharedMock, rosterNames } from './helpers/mock-fleet.mjs';

const { buildMcpServer } = await import('../mcp/server.mjs');
const { createMcpHttpApp } = await import('../mcp/http.mjs');
const { startMcpServer } = await import('../mcp/main.mjs');
```

2. Delete the local `createMockFleetApi()` function (lines 37–61) and replace it with:

```js
function createMockFleetApi() {
  return createSharedMock({
    members: rosterNames(2),
    commandPayload: (options) => mockPayloadForCommand(options.command ?? ''),
  });
}

async function makeDispatcher() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-test-pool-'));
  return new WorkerDispatcher({
    pool: WorkerPool.create({ config: { size: 2, root, acquireTimeoutMs: 5000 } }),
    ephemeral: null,
    config: { maxQueueSize: 4, queueTimeoutMs: 5000 },
  });
}
```

3. Replace `withServer` with:

```js
async function withServer(registryOverride, run) {
  const fleetApi = createMockFleetApi();
  const dispatcher = await makeDispatcher();
  const app = createMcpHttpApp({
    buildServer: () => buildMcpServer({ fleetApi, dispatcher, registry: registryOverride }),
  });
  const httpServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
  });
  const url = new URL(`http://127.0.0.1:${httpServer.address().port}/mcp`);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      await run({ client, fleetApi, dispatcher });
    } finally {
      await client.close();
    }
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
    await dispatcher.close();
  }
}
```

4. In the two `startMcpServer` tests, pass a dispatcher:

```js
      within(
        startMcpServer({ fleetApi: createMockFleetApi(), dispatcher: await makeDispatcher(), port }),
```
and
```js
  const { server, close } = await startMcpServer({
    fleetApi: createMockFleetApi(),
    dispatcher: await makeDispatcher(),
    port: 0,
  });
```

5. In the test `'disconnecting a client closes the request server and aborts its workflow'`, add `const dispatcher = await makeDispatcher();` after `const fleetApi = createMockFleetApi();`, pass `dispatcher` into `buildMcpServer({ fleetApi, dispatcher, registry })`, and add `await dispatcher.close();` as the last line of its `finally`.

6. Update member assertions — the first lease always lands on worker 1:
   - `calling weather returns parsed weather data`: `assert.equal(fleetApi.commandCalls[0].member_name, 'WORKER-1-DOER');`
   - `calling inspect-members with one member touches only that member` becomes:

```js
test('calling inspect-members with one role touches only that role', async () => {
  await withServer(undefined, async ({ client, fleetApi }) => {
    const result = await client.callTool({
      name: 'inspect-members',
      arguments: { roles: ['doer'] },
    });
    assert.equal(result.isError, undefined);
    assert.equal(fleetApi.commandCalls.length, 1);
    assert.equal(fleetApi.commandCalls[0].member_name, 'WORKER-1-DOER');

    const report = JSON.parse(result.content[0].text);
    assert.equal(report.workerId, 'pool-1');
    assert.deepEqual(report.members.map((entry) => entry.name), ['WORKER-1-DOER']);
  });
});
```
   - In `'advertises exactly the registry tools…'`, replace the `inspect` assertions with:

```js
    const inspect = tools.find((tool) => tool.name === 'inspect-members');
    assert.deepEqual(Object.keys(inspect.inputSchema.properties).sort(), ['includeFiles', 'roles']);
    assert.deepEqual(inspect.inputSchema.properties.roles.items.enum, ['doer', 'reviewer']);
    assert.equal(inspect.annotations.readOnlyHint, true);
```

7. Add two new tests at the end of the file:

```js
test('every tool call releases its lease, even when the tool throws', async () => {
  const registry = [
    { name: 'boom', description: 'throws', async run() { throw new Error('nope'); } },
    { name: 'ok', description: 'works', async run({ workspace }) { return workspace.workerId; } },
  ];
  await withServer(registry, async ({ client, dispatcher }) => {
    for (let i = 0; i < 3; i += 1) {
      const failed = await client.callTool({ name: 'boom' });
      assert.equal(failed.isError, true);
    }
    const ok = await client.callTool({ name: 'ok' });
    assert.equal(ok.content[0].text, 'pool-1', 'worker 1 must be free again after failures');
    assert.equal(dispatcher.queued, 0);
  });
});

test('tools see a pooled fleetApi that resolves role keywords', async () => {
  const registry = [
    {
      name: 'who',
      description: 'runs a command as the doer',
      async run({ fleetApi, workspace }) {
        await fleetApi.executeCommand({ member_name: 'doer', command: 'echo hi' });
        return workspace.doer.name;
      },
    },
  ];
  await withServer(registry, async ({ client, fleetApi }) => {
    const result = await client.callTool({ name: 'who' });
    assert.equal(result.content[0].text, 'WORKER-1-DOER');
    assert.equal(fleetApi.commandCalls[0].member_name, 'WORKER-1-DOER');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/mcp.test.mjs`
Expected: FAIL — `buildMcpServer` ignores `dispatcher`; `workspace` is undefined in tools; role assertions fail.

- [ ] **Step 3: Rewrite buildMcpServer**

Replace `mcp/server.mjs` with:

```js
import { McpServer } from '@modelcontextprotocol/server';
import { createPooledFleetApi } from '../pool/pooled-fleet-api.mjs';
import { defaultRegistry } from './registry.mjs';

const SERVER_INFO = { name: 'workflow-kit', version: '1.0.0' };

function toToolResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

// Progress notifications are only legal when the client sent a progressToken,
// and `progress` must increase on every one. With no token this is a no-op, so
// workflow bodies can call reportPhase unconditionally.
function makePhaseReporter(ctx) {
  const progressToken = ctx.mcpReq._meta?.progressToken;
  let progress = 0;
  return async (message) => {
    if (progressToken === undefined) return;
    progress += 1;
    await ctx.mcpReq.notify({
      method: 'notifications/progress',
      params: { progressToken, progress, message },
    });
  };
}

export function buildMcpServer({ fleetApi, dispatcher, registry = defaultRegistry } = {}) {
  if (!fleetApi) throw new Error('buildMcpServer requires fleetApi');
  if (!dispatcher) throw new Error('buildMcpServer requires dispatcher');
  const server = new McpServer(SERVER_INFO);

  for (const entry of registry) {
    const config = { description: entry.description };
    if (entry.inputSchema) config.inputSchema = entry.inputSchema;
    if (entry.annotations) config.annotations = entry.annotations;

    // Every call holds exactly one worker pair for its duration. A thrown
    // error is turned into an isError result by the SDK, so there is
    // deliberately no try/catch -- only the finally that returns the lease.
    const invoke = async (args, ctx) => {
      const reportPhase = makePhaseReporter(ctx);
      const lease = await dispatcher.dispatch({ signal: ctx.mcpReq.signal, reportPhase });
      try {
        return toToolResult(
          await entry.run({
            fleetApi: createPooledFleetApi(fleetApi, lease),
            args,
            signal: lease.signal,
            reportPhase,
            workspace: { workerId: lease.workerId, doer: lease.doer, reviewer: lease.reviewer },
          }),
        );
      } finally {
        await lease.release();
      }
    };

    // The SDK passes (args, ctx) only when inputSchema is declared; without one
    // the context arrives as the single argument.
    server.registerTool(
      entry.name,
      config,
      entry.inputSchema ? (args, ctx) => invoke(args ?? {}, ctx) : (ctx) => invoke({}, ctx),
    );
  }

  return server;
}
```

- [ ] **Step 4: Run to check progress**

Run: `node --test tests/mcp.test.mjs`
Expected: the two new tests and `'every tool call releases…'` PASS; `weather`, `inspect-members`, `demo` tests still FAIL because the registry and workflows still say `'DEMO-DOER'`. Task 11 fixes those. The `startMcpServer` tests still FAIL because `main.mjs` does not accept `dispatcher` yet — Task 12.

- [ ] **Step 5: Commit**

```bash
git add mcp/server.mjs tests/mcp.test.mjs
git commit -m "feat: lease a worker pair around every MCP tool call"
```

---

### Task 11: Registry and workflows speak in roles

All hardcoded `'DEMO-DOER'` become `'doer'`. `inspect-members` inspects the leased pair (`roles`) instead of a fixed member list, and presence is checked with `listMembers()` + token-exact matching. Launchers accept and forward `workspace`. Direct CLI runs (no injected `fleetApi`) go through a shared helper that spawns Fleet, builds a dispatcher, and takes one lease.

**Files:**
- Create: `workflows/standalone.mjs`
- Modify: `mcp/registry.mjs`
- Modify: `workflows/demo/main.mjs`, `workflows/demo/demo.js`
- Modify: `workflows/inspect-members/main.mjs`, `workflows/inspect-members/inspect-members.js`
- Modify: `workflows/city-briefing/main.mjs`
- Modify: `tests/demo.test.mjs`, `tests/inspect-members.test.mjs`

- [ ] **Step 1: Update the demo test (failing)**

In `tests/demo.test.mjs`, replace the local `createMockFleetApi` with an import and add a `workspace` fixture:

```js
import { createMockFleetApi } from './helpers/mock-fleet.mjs';

const workspace = {
  workerId: 'pool-1',
  doer: { name: 'WORKER-1-DOER', folder: '/tmp/worker-1/doer' },
  reviewer: { name: 'WORKER-1-REVIEWER', folder: '/tmp/worker-1/reviewer' },
};
```

Then in every `runDemo({ fleetApi, ... })` call add `workspace`, e.g. `runDemo({ fleetApi, workspace })`, and change the first test's member assertion:

```js
  assert.equal(fleetApi.commandCalls[0].member_name, 'doer', 'bodies address roles, not members');
  assert.equal(fleetApi.promptCalls[0].member_name, 'doer');
```

Delete the test `'the workflow does not register members'` (the shared mock has `registerMember`; the guarantee now lives in the pool tests) and replace it with:

```js
test('the workflow never registers members', async () => {
  const fleetApi = createMockFleetApi();
  await runDemo({ fleetApi, workspace });
  assert.deepEqual(fleetApi.registerCalls, []);
});
```

- [ ] **Step 2: Update the inspect-members test (failing)**

Replace `tests/inspect-members.test.mjs` entirely:

```js
import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockFleetApi as createSharedMock } from './helpers/mock-fleet.mjs';

const { runInspectMembers } = await import('../workflows/inspect-members/main.mjs');

const workspace = {
  workerId: 'pool-1',
  doer: { name: 'WORKER-1-DOER', folder: '/tmp/worker-1/doer' },
  reviewer: { name: 'WORKER-1-REVIEWER', folder: '/tmp/worker-1/reviewer' },
};

function createMockFleetApi({ present = ['WORKER-1-DOER', 'WORKER-1-REVIEWER'], commandFails = false } = {}) {
  const api = createSharedMock({
    members: present,
    commandPayload: JSON.stringify({ root: '/tmp/x', exists: true, fileCount: 2, totalBytes: 10 }),
  });
  if (commandFails) {
    api.executeCommand = async (options) => {
      api.commandCalls.push(options);
      return {
        content: [{ type: 'text', text: 'python3: command not found' }],
        structuredContent: { stdout: '', exitCode: 127 },
      };
    };
  }
  return api;
}

test('inspects both roles of the leased worker by default', async () => {
  const fleetApi = createMockFleetApi();
  const result = await runInspectMembers({ fleetApi, workspace });

  assert.equal(typeof result.generatedAt, 'string');
  assert.equal(result.workerId, 'pool-1');
  assert.deepEqual(result.members.map((entry) => entry.role), ['doer', 'reviewer']);
  assert.deepEqual(result.members.map((entry) => entry.name), ['WORKER-1-DOER', 'WORKER-1-REVIEWER']);
  assert.equal(result.members[0].present, true);
  assert.equal(result.members[0].report.fileCount, 2);
  assert.equal(fleetApi.commandCalls.length, 2);
  assert.match(fleetApi.commandCalls[0].command, /inspect\.py/);
  assert.match(fleetApi.commandCalls[0].command, /--root "\/tmp\/worker-1\/doer"/);
  assert.equal(fleetApi.commandCalls[0].member_name, 'doer');
  assert.equal(fleetApi.commandCalls[0].failSoft, true);
});

test('honors an explicit roles list', async () => {
  const fleetApi = createMockFleetApi();
  const result = await runInspectMembers({ fleetApi, workspace, roles: ['reviewer'] });
  assert.deepEqual(result.members.map((entry) => entry.name), ['WORKER-1-REVIEWER']);
  assert.equal(fleetApi.commandCalls.length, 1);
  assert.equal(fleetApi.commandCalls[0].member_name, 'reviewer');
});

test('rejects unknown roles before command dispatch', async () => {
  const fleetApi = createMockFleetApi();
  await assert.rejects(
    () => runInspectMembers({ fleetApi, workspace, roles: ['OTHER"; touch /tmp/x; #'] }),
    /unsupported role/i,
  );
  assert.equal(fleetApi.commandCalls.length, 0);
});

test('requires a workspace', async () => {
  await assert.rejects(() => runInspectMembers({ fleetApi: createMockFleetApi() }), /workspace/);
});

test('reports an unregistered member as absent without running a command', async () => {
  const fleetApi = createMockFleetApi({ present: ['WORKER-1-DOER'] });
  const result = await runInspectMembers({ fleetApi, workspace });
  const reviewer = result.members.find((entry) => entry.role === 'reviewer');
  assert.equal(reviewer.present, false);
  assert.equal(reviewer.report, undefined);
  assert.equal(fleetApi.commandCalls.length, 1, 'absent members must not be probed');
});

test('presence matching is token-exact', async () => {
  const fleetApi = createMockFleetApi({ present: ['WORKER-11-DOER', 'WORKER-11-REVIEWER'] });
  const result = await runInspectMembers({ fleetApi, workspace });
  assert.deepEqual(result.members.map((entry) => entry.present), [false, false]);
  assert.equal(fleetApi.commandCalls.length, 0);
});

test('includeFiles adds the --files flag', async () => {
  const fleetApi = createMockFleetApi();
  await runInspectMembers({ fleetApi, workspace, includeFiles: true });
  assert.match(fleetApi.commandCalls[0].command, /--files/);

  const plain = createMockFleetApi();
  await runInspectMembers({ fleetApi: plain, workspace });
  assert.doesNotMatch(plain.commandCalls[0].command, /--files/);
});

test('a failSoft command failure becomes a per-member error, not a throw', async () => {
  const fleetApi = createMockFleetApi({ commandFails: true });
  const result = await runInspectMembers({ fleetApi, workspace });
  assert.equal(result.members[0].present, true);
  assert.equal(result.members[0].report, undefined);
  assert.match(result.members[0].error, /command not found/);
});

test('an aborted signal stops before the next role', async () => {
  const fleetApi = createMockFleetApi();
  const controller = new AbortController();
  controller.abort();
  const result = await runInspectMembers({ fleetApi, workspace, signal: controller.signal });
  assert.equal(fleetApi.commandCalls.length, 0);
  assert.deepEqual(result.members, []);
});

test('reportPhase is called and is optional', async () => {
  const phases = [];
  await runInspectMembers({
    fleetApi: createMockFleetApi(),
    workspace,
    reportPhase: (message) => phases.push(message),
  });
  assert.ok(phases.length >= 1);
  await runInspectMembers({ fleetApi: createMockFleetApi(), workspace });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `node --test tests/demo.test.mjs tests/inspect-members.test.mjs`
Expected: FAIL — `member_name` is `'DEMO-DOER'`; `roles`/`workspace` unsupported.

- [ ] **Step 4: Add the standalone helper**

```js
// workflows/standalone.mjs
import { createPooledFleetApi, createWorkerDispatcher } from '../pool/index.mjs';

// CLI runs (`node workflows/<name>/main.mjs`) get the same lease discipline as
// MCP calls: spawn Fleet over stdio, build a dispatcher, take one lease, run,
// release, tear everything down. Members are MemberManager's job, so
// spawnFleet is called without a memberName.
export async function withStandaloneLease(run, { env = process.env } = {}) {
  const { spawnFleet } = await import('../transport/stdio-fleet.mjs');
  const fleet = await spawnFleet({ env });
  try {
    const dispatcher = await createWorkerDispatcher({ fleetApi: fleet.fleetApi, env });
    try {
      const lease = await dispatcher.dispatch({});
      try {
        return await run({
          fleetApi: createPooledFleetApi(fleet.fleetApi, lease),
          signal: lease.signal,
          workspace: { workerId: lease.workerId, doer: lease.doer, reviewer: lease.reviewer },
        });
      } finally {
        await lease.release();
      }
    } finally {
      await dispatcher.close();
    }
  } finally {
    await fleet.stop();
  }
}
```

- [ ] **Step 5: Rewrite the demo launcher and body**

`workflows/demo/main.mjs`:

```js
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withStandaloneLease } from '../standalone.mjs';
import { ensureApralabs } from './ensure-apralabs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineScript = path.join(here, 'demo.js');

export const selfExecuting = true;

// fleetApi must already resolve 'doer'/'reviewer' (a PooledFleetApi) and
// workspace must describe the leased pair. With no fleetApi this is a CLI run
// and the standalone helper provides both.
export async function runDemo({ fleetApi, workspace, signal, reportPhase } = {}) {
  ensureApralabs();
  if (!fleetApi) {
    return withStandaloneLease((ctx) => runDemo({ ...ctx, reportPhase }));
  }
  const { FleetWorkflow } = await import('@apralabs/apra-fleet-workflow');
  const { WorkflowEngine } = await import('@apralabs/apra-fleet-workflow/engine');

  const workflow = new FleetWorkflow(fleetApi);
  const engine = new WorkflowEngine(workflow);
  return await engine.executeFile(engineScript, { fleetApi, workspace, signal, reportPhase });
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  try {
    await runDemo();
    process.exit(0);
  } catch (err) {
    console.error(err?.message ?? err);
    process.exit(1);
  }
}
```

`workflows/demo/demo.js` — three edits:

```js
  // 'doer' and 'reviewer' are reserved keywords resolved by PooledFleetApi to
  // this run's own leased members. Never name a member directly.
  log(`running on ${args.workspace?.workerId ?? 'unknown worker'} as ${args.workspace?.doer?.name ?? 'doer'}`);
```
(insert directly after `const cancelled = …`), then
```js
    member_name: 'doer',
```
(in the `command()` call) and
```js
  const reply = await agent('Reply with exactly: pong', { member_name: 'doer' });
```

- [ ] **Step 6: Rewrite the inspect-members launcher and body**

`workflows/inspect-members/main.mjs`:

```js
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withStandaloneLease } from '../standalone.mjs';
// Shared with the demo workflow on purpose: duplicating the symlink
// logic would mean two places to fix when the Fleet install layout changes.
import { ensureApralabs } from '../demo/ensure-apralabs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineScript = path.join(here, 'inspect-members.js');

export const selfExecuting = true;

export async function runInspectMembers({
  fleetApi,
  workspace,
  roles,
  includeFiles,
  signal,
  reportPhase,
} = {}) {
  ensureApralabs();
  if (!fleetApi) {
    return withStandaloneLease((ctx) =>
      runInspectMembers({ ...ctx, roles, includeFiles, reportPhase }),
    );
  }
  if (!workspace?.doer || !workspace?.reviewer) {
    throw new Error('runInspectMembers requires a workspace with doer and reviewer');
  }
  const { FleetWorkflow } = await import('@apralabs/apra-fleet-workflow');
  const { WorkflowEngine } = await import('@apralabs/apra-fleet-workflow/engine');

  const workflowApi = {
    executeCommand(options) {
      Object.defineProperty(options, 'failSoft', { value: true, enumerable: false });
      return fleetApi.executeCommand(options);
    },
  };
  const workflow = new FleetWorkflow(workflowApi);
  const engine = new WorkflowEngine(workflow);
  return await engine.executeFile(engineScript, {
    fleetApi,
    workspace,
    roles,
    includeFiles,
    signal,
    reportPhase,
  });
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  try {
    const report = await runInspectMembers();
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(err?.message ?? err);
    process.exit(1);
  }
}
```

`workflows/inspect-members/inspect-members.js` — replace the header (everything above `function toolText`) and `main()`; keep `commandText` and `parseReport` exactly as they are, and delete `toolText` and `memberListedInStatus`:

```js
import { fileURLToPath } from 'node:url';
import { memberIsPresent, toolText } from '../../pool/fleet-text.mjs';

export const meta = { name: 'inspect-members' };

// A run may only inspect the pair it holds. Reporting on another run's worker
// would be the same-member collision the pool exists to prevent.
export const ROLES = Object.freeze(['doer', 'reviewer']);

const INSPECT_PY = fileURLToPath(new URL('./inspect.py', import.meta.url));
```

```js
export async function main(context) {
  const { phase, command, log, args } = context;
  const fleetApi = args.fleetApi;
  if (!fleetApi) {
    throw new Error('inspect-members.js requires args.fleetApi');
  }
  const workspace = args.workspace;
  if (!workspace?.doer || !workspace?.reviewer) {
    throw new Error('inspect-members.js requires args.workspace with doer and reviewer');
  }
  const signal = args.signal;
  const reportPhase = args.reportPhase ?? (() => {});
  const includeFiles = args.includeFiles === true;
  const requestedRoles = Array.isArray(args.roles) && args.roles.length > 0 ? args.roles : ROLES;
  const targets = requestedRoles.map((role) => {
    if (!ROLES.includes(role)) {
      throw new Error(`Unsupported role: ${String(role)}`);
    }
    return { role, name: workspace[role].name, folder: workspace[role].folder };
  });

  phase('members');
  await reportPhase('listing fleet members');
  const listed = toolText(await fleetApi.listMembers({}));

  const members = [];
  for (const { role, name, folder } of targets) {
    if (signal?.aborted) {
      log(`cancelled before inspecting ${role}`);
      break;
    }

    if (!memberIsPresent(listed, name)) {
      log(`${name} is not registered`);
      members.push({ role, name, present: false });
      continue;
    }

    phase(`inspect ${role}`);
    await reportPhase(`inspecting ${role} (${name})`);
    const flags = includeFiles ? ' --files' : '';
    const raw = await command(
      `python3 "${INSPECT_PY}" --root "${folder}"${flags}`,
      { member_name: role, failSoft: true },
    );
    const text = commandText(raw);
    const report = parseReport(text);
    if (report) {
      members.push({ role, name, present: true, report });
    } else {
      members.push({ role, name, present: true, error: text.trim() || 'no report produced' });
    }
  }

  return { generatedAt: new Date().toISOString(), workerId: workspace.workerId, members };
}
```

- [ ] **Step 7: Update the city-briefing launcher**

`workflows/city-briefing/main.mjs` — replace `runCityBriefing` and add the import:

```js
import { withStandaloneLease } from '../standalone.mjs';
```

```js
export async function runCityBriefing({ fleetApi, workspace, city, signal, reportPhase } = {}) {
  ensureApralabs();
  if (!fleetApi) {
    return withStandaloneLease((ctx) => runCityBriefing({ ...ctx, city, reportPhase }));
  }
  const { FleetWorkflow } = await import('@apralabs/apra-fleet-workflow');
  const { WorkflowEngine } = await import('@apralabs/apra-fleet-workflow/engine');

  const workflow = new FleetWorkflow(fleetApi);
  const engine = new WorkflowEngine(workflow);
  return await engine.executeFile(engineScript, {
    fleetApi,
    workspace,
    city: city || 'London',
    signal,
    reportPhase,
  });
}
```

Then in `workflows/city-briefing/city-briefing.js`, replace all four `member_name: 'DEMO-DOER'` occurrences (lines 47, 58, 80, 89 — two `command()` calls, one `agent()` call, one more `command()`) with `member_name: 'doer'`:

Run: `grep -n "DEMO-DOER" workflows/city-briefing/city-briefing.js`
Expected after the edit: no output.

- [ ] **Step 8: Update the registry**

In `mcp/registry.mjs`:

1. `demo`:
```js
    async run({ fleetApi, workspace, signal, reportPhase }) {
      const result = await runDemo({ fleetApi, workspace, signal, reportPhase });
      return `demo workflow completed: ${JSON.stringify(result)}`;
    },
```

2. `inspect-members` — description, schema, and run:
```js
    description:
      "Reports on the worker pair this call is running on: whether each role's member is " +
      'registered, and what is in its work folder. Choose this to check fleet health or to see ' +
      'what a worker has been doing. Read-only and spends no LLM tokens.',
    inputSchema: z.object({
      roles: z
        .array(z.enum(['doer', 'reviewer']))
        .optional()
        .describe('Roles to inspect on the leased worker. Defaults to both.'),
      includeFiles: z
        .boolean()
        .optional()
        .describe('Include a capped listing of top-level entries in each work folder.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args, signal, reportPhase, workspace }) {
      return await runInspectMembers({
        fleetApi,
        workspace,
        roles: args.roles,
        includeFiles: args.includeFiles,
        signal,
        reportPhase,
      });
    },
```

3. `city-briefing`:
```js
    async run({ fleetApi, args, signal, reportPhase, workspace }) {
      const result = await runCityBriefing({
        fleetApi,
        workspace,
        city: args.city,
        signal,
        reportPhase,
      });
      return `city briefing completed: ${JSON.stringify(result)}`;
    },
```

4. `weather`, `timezone`, `textstats`: change each `member_name: 'DEMO-DOER',` to `member_name: 'doer',`.

Run: `grep -rn "DEMO-" mcp/ workflows/ | grep -v "\.py:"`
Expected: no output.

- [ ] **Step 9: Run the workflow and MCP suites**

Run: `node --test tests/demo.test.mjs tests/inspect-members.test.mjs tests/mcp.test.mjs`
Expected: demo and inspect-members PASS; in mcp.test.mjs everything passes **except** the two `startMcpServer` tests (Task 12).

- [ ] **Step 10: Commit**

```bash
git add workflows/standalone.mjs mcp/registry.mjs \
        workflows/demo/main.mjs workflows/demo/demo.js \
        workflows/inspect-members/main.mjs workflows/inspect-members/inspect-members.js \
        workflows/city-briefing/main.mjs workflows/city-briefing/city-briefing.js \
        tests/demo.test.mjs tests/inspect-members.test.mjs
git commit -m "refactor: address members by role and inspect the leased pair"
```

---

### Task 12: Startup lifecycle in mcp/main.mjs

`startMcpServer` spawns Fleet with no member, builds the dispatcher (which provisions the roster), and tears both down on error or shutdown.

**Files:**
- Modify: `mcp/main.mjs`

- [ ] **Step 1: Confirm the failing tests**

Run: `node --test tests/mcp.test.mjs`
Expected: `'startMcpServer rejects a real port collision'` and `'startMcpServer removes its startup error listener after listening'` FAIL (they pass `dispatcher`, which `main.mjs` ignores; `buildMcpServer` then throws `requires dispatcher`).

- [ ] **Step 2: Rewrite startMcpServer**

Replace the `startMcpServer` function and its imports in `mcp/main.mjs`:

```js
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWorkerDispatcher } from '../pool/index.mjs';
import { ensureApralabs } from '../workflows/demo/ensure-apralabs.mjs';
import { createMcpHttpApp } from './http.mjs';
import { buildMcpServer } from './server.mjs';

export async function startMcpServer({ fleetApi, dispatcher, port, env = process.env } = {}) {
  ensureApralabs();

  let api = fleetApi;
  let stopFleet = null;
  if (!api) {
    const { spawnFleet } = await import('../transport/stdio-fleet.mjs');
    // No memberName: registration and OAuth are MemberManager's job.
    const fleet = await spawnFleet({ env });
    api = fleet.fleetApi;
    stopFleet = fleet.stop;
  }

  // One dispatcher per process, built once at startup. A roster failure here
  // is deliberately fatal: better a loud startup error than an agent() call
  // failing deep inside a run.
  let ownDispatcher = null;
  let activeDispatcher = dispatcher;
  if (!activeDispatcher) {
    try {
      activeDispatcher = ownDispatcher = await createWorkerDispatcher({ fleetApi: api, env });
    } catch (err) {
      try {
        await stopFleet?.();
      } catch {
        // Preserve the dispatcher error after best-effort Fleet cleanup.
      }
      throw err;
    }
  }

  const app = createMcpHttpApp({
    buildServer: () => buildMcpServer({ fleetApi: api, dispatcher: activeDispatcher }),
  });
  const listenPort = port ?? Number(env.PORT ?? 3000);
  const bindHost = env.MCP_BIND_HOST || '127.0.0.1';
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
      await ownDispatcher?.close();
    } catch {
      // Preserve the listener error after best-effort dispatcher cleanup.
    }
    try {
      await stopFleet?.();
    } catch {
      // Preserve the listener error after best-effort Fleet cleanup.
    }
    throw err;
  }
  console.log(
    `MCP server listening on http://${bindHost}:${server.address().port}/mcp ` +
      `(worker capacity ${activeDispatcher.capacity})`,
  );

  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    await ownDispatcher?.close();
    await stopFleet?.();
  };
  return { server, close };
}
```

Keep `isMainModule()` and the `if (isMainModule())` block unchanged.

- [ ] **Step 3: Run the MCP suite**

Run: `node --test tests/mcp.test.mjs`
Expected: PASS, all tests.

- [ ] **Step 4: Commit**

```bash
git add mcp/main.mjs
git commit -m "feat: build the worker dispatcher at MCP server startup"
```

---

### Task 13: Docker, npm scripts, and the live test

The container no longer registers members; Node does. `npm test` covers every offline suite. One live test proves pool → ephemeral → queue against a real Fleet.

**Files:**
- Modify: `scripts/docker-entrypoint.sh`
- Modify: `docker-compose.yml`
- Modify: `package.json`
- Create: `tests/dispatch.live.test.mjs`
- Modify: `README.md` (one section), `docs/mcp-interface.md` (one section)

- [ ] **Step 1: Strip provisioning from the entrypoint**

Replace `scripts/docker-entrypoint.sh` with:

```sh
#!/bin/sh
set -eu

echo "[entrypoint] starting..."

# Ensure project deps exist — the named volume starts empty on first run.
if [ ! -d /workspace/node_modules/@modelcontextprotocol ]; then
  echo "[entrypoint] installing project dependencies..."
  npm ci --omit=dev
fi

# Symlink @apralabs packages so workflows can resolve them.
echo "[entrypoint] linking @apralabs packages..."
node -e "import('./workflows/demo/ensure-apralabs.mjs').then(m => m.ensureApralabs())" 2>/dev/null || true

# Members, folders, and OAuth are provisioned by Node at startup
# (pool/member-manager.mjs) from WORKER_POOL_SIZE and CLAUDE_CODE_OAUTH_TOKEN.
echo "[entrypoint] exec: $*"
exec "$@"
```

- [ ] **Step 2: Pass worker settings through compose**

In `docker-compose.yml`, replace the `environment:` block with:

```yaml
    environment:
      CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN:-}
      MCP_BIND_HOST: "0.0.0.0"
      WORKER_POOL_SIZE: ${WORKER_POOL_SIZE:-4}
      WORKER_EPHEMERAL_MAX: ${WORKER_EPHEMERAL_MAX:-10}
```

- [ ] **Step 3: Update the npm test script**

In `package.json`, set:

```json
    "test": "node --test tests/transport-stdio-fleet.test.mjs tests/pool-roster.test.mjs tests/pool-cleanup.test.mjs tests/pool-worker-lock.test.mjs tests/pool-fleet-text.test.mjs tests/pool-pooled-fleet-api.test.mjs tests/pool-worker-pool.test.mjs tests/pool-config.test.mjs tests/pool-member-manager.test.mjs tests/pool-ephemeral-factory.test.mjs tests/pool-worker-dispatcher.test.mjs tests/pool-index.test.mjs tests/demo.test.mjs tests/inspect-members.test.mjs tests/mcp.test.mjs",
```

- [ ] **Step 4: Run the whole offline suite**

Run: `npm test`
Expected: PASS, every file green, no Fleet binary or token needed.

- [ ] **Step 5: Write the live test**

```js
// tests/dispatch.live.test.mjs
import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Spawns a real Fleet over stdio. Needs the apra-fleet binary and
// CLAUDE_CODE_OAUTH_TOKEN. Not part of `npm test`.
//   node --test tests/dispatch.live.test.mjs

const { spawnFleet } = await import('../transport/stdio-fleet.mjs');
const { createWorkerDispatcher, createPooledFleetApi } = await import('../pool/index.mjs');
const { memberIsPresent, toolText } = await import('../pool/fleet-text.mjs');

test(
  'live: two pool workers, two ephemeral, two queued — all six calls complete on distinct pairs',
  { timeout: 600_000 },
  async () => {
    const poolRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'live-pool-'));
    const ephemeralRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'live-eph-'));
    const fleet = await spawnFleet({});
    try {
      const dispatcher = await createWorkerDispatcher({
        fleetApi: fleet.fleetApi,
        config: {
          pool: { size: 2, root: poolRoot, acquireTimeoutMs: 120_000 },
          ephemeral: { maxConcurrent: 2, workRoot: ephemeralRoot, ttlMs: 300_000 },
          dispatch: { maxQueueSize: 10, queueTimeoutMs: 300_000 },
        },
      });
      try {
        const listed = toolText(await fleet.fleetApi.listMembers({}));
        for (const name of ['WORKER-1-DOER', 'WORKER-1-REVIEWER', 'WORKER-2-DOER', 'WORKER-2-REVIEWER']) {
          assert.ok(memberIsPresent(listed, name), `${name} must be registered by MemberManager`);
        }

        const runOne = async () => {
          const lease = await dispatcher.dispatch({});
          try {
            const api = createPooledFleetApi(fleet.fleetApi, lease);
            const result = await api.executeCommand({ member_name: 'doer', command: 'echo live-ok' });
            assert.match(toolText(result), /live-ok/);
            // Hold the worker briefly so all six calls overlap.
            await new Promise((resolve) => setTimeout(resolve, 2_000));
            return { workerId: lease.workerId, doer: lease.doer.name };
          } finally {
            await lease.release();
          }
        };

        const results = await Promise.all(Array.from({ length: 6 }, runOne));
        const ids = results.map((r) => r.workerId);
        assert.equal(ids.filter((id) => id.startsWith('pool-')).length >= 2, true);
        assert.equal(ids.filter((id) => id.startsWith('ephemeral-')).length >= 2, true);
        assert.equal(new Set(results.slice(0, 4).map((r) => r.doer)).size, 4, 'first four run on distinct pairs');

        const after = toolText(await fleet.fleetApi.listMembers({}));
        for (const { doer } of results.filter((r) => r.workerId.startsWith('ephemeral-'))) {
          assert.equal(memberIsPresent(after, doer), false, `${doer} must be removed after release`);
        }
        assert.deepEqual(await fs.readdir(ephemeralRoot), [], 'ephemeral folders are deleted');
      } finally {
        await dispatcher.close();
      }
    } finally {
      await fleet.stop();
    }
  },
);
```

- [ ] **Step 6: Run the live test against a real Fleet**

Run: `node --test tests/dispatch.live.test.mjs`
Expected: PASS. If `remove_member` is not exposed by this Fleet version, the "must be removed after release" assertions fail — record the Fleet version and open a follow-up; the design tolerates orphaned registrations but the test documents the intended contract.

- [ ] **Step 7: Update the two docs that name DEMO members**

In `README.md`, replace the paragraph(s) that describe `DEMO-DOER` / `DEMO-REVIEWER` and `provision-members.sh` with:

```markdown
### Workers

Every MCP tool call and CLI run holds one **doer + reviewer** pair for its
duration. Workflows address them as `'doer'` and `'reviewer'`; the kit resolves
those to the members of the pair the call was given.

Pairs come from two tiers, tried in order:

| Tier | Members | Configured by | Default |
|---|---|---|---|
| Pool | `WORKER-{i}-DOER` / `-REVIEWER`, pre-registered at startup | `WORKER_POOL_SIZE` | 4 |
| Ephemeral | `EPHEMERAL-{id}-DOER` / `-REVIEWER`, created under `os.tmpdir()` and removed on release | `WORKER_EPHEMERAL_MAX` | 10 |

When both are busy, calls queue (`WORKER_DISPATCH_QUEUE_SIZE`, default 20) and
then fail with "all workers busy". Set `WORKER_POOL_SIZE=0` for an ephemeral-only
deployment (Function Apps) or `WORKER_EPHEMERAL_MAX=0` for pool-only.

Node registers members and provisions OAuth at startup from
`CLAUDE_CODE_OAUTH_TOKEN`; there is no provisioning script to run.
```

In `docs/mcp-interface.md`, replace the `inspect-members` parameter description (`members: ['DEMO-DOER', 'DEMO-REVIEWER']`) with `roles: ['doer', 'reviewer']` and note that it reports on the pair the call is running on.

Run: `grep -rn "DEMO-DOER\|provision-members" README.md docs/mcp-interface.md docs/architecture.md docs/development.md`
Expected: only historical references, if any, in `docs/architecture.md` / `docs/development.md`. Update any that describe current behaviour; leave changelog-style history alone.

- [ ] **Step 8: Commit**

```bash
git add scripts/docker-entrypoint.sh docker-compose.yml package.json tests/dispatch.live.test.mjs README.md docs/mcp-interface.md docs/architecture.md docs/development.md
git commit -m "chore: provision workers from Node, cover dispatch tiers live, document the worker model"
```

---

## Self-review against the spec

**Spec coverage**

| Spec section | Task |
|---|---|
| Tiered dispatch (pool → ephemeral → queue → reject) | 8 |
| Lease shape, `pool-`/`ephemeral-` ids | 3, 7 |
| Queue served by whichever tier frees first; heartbeats | 8 |
| MemberManager: provisionPair / teardownPair / provisionRoster, idempotent, rollback, OAuth warning, removeMember optional | 6 |
| provision_llm_auth via fleetApi | 5 |
| WorkerPool changes: no verifyRoster, public tryAcquireNow, dispatcher owns queue, fleetApi from caller (now: none needed) | 3 |
| Roster naming/folders/locks | 2 |
| EphemeralWorkerFactory: guid pairs, tmpdir, ttl, active cap, onRelease, no locking | 7 |
| Dispatcher error handling: ephemeral throw → queue | 8 |
| Overflow → `DispatchOverflowError` (surfaces as an MCP tool error; a true HTTP 429 belongs to the future `/chat` REST door) | 8, 10 |
| Config + env mapping + "at least one tier" validation | 4 |
| Startup lifecycle (Docker and Function App shapes) | 9, 12 |
| Shutdown: reject waiters, tear down ephemeral, close pool, stop Fleet | 8 (`close`), 7 (`close`), 12 |
| mcp/server.mjs dispatch/release per call, `workspace` | 10 |
| mcp/registry.mjs → roles | 11 |
| Launchers simplified, CLI builds its own dispatcher | 11 |
| provision-members.sh out of the startup path; Docker entrypoint | 13 |
| Unit tests (MemberManager, Ephemeral, Dispatcher, Pool) | 6, 7, 8, 3 |
| Live integration: 2 pool + 2 ephemeral + 2 queued, teardown verified | 13 |
| Migration: DEMO-* retired, workdir ignored | 1, 11 |

**Deviations from the spec, and why**
- `WorkerPool.create` takes no `fleetApi`: after removing roster verification the pool made no Fleet calls, so the parameter was dead.
- `EphemeralWorkerFactory` takes `{ memberManager, config }`, not `(fleetApi, memberManager, config)`: it never calls Fleet directly.
- Default ephemeral root is `path.join(os.tmpdir(), 'workflow-kit')` rather than a literal `/tmp`, so the kit runs on Windows dev machines; on Linux and Function Apps that is `/tmp/workflow-kit`.
- `inspect-members` inspects the leased pair (`roles`) instead of a fixed member list — the spec only said "stop hardcoding DEMO-DOER"; inspecting another run's worker would recreate the collision the pool prevents.
- `inspect-members` presence uses `listMembers()` + token-exact matching instead of `fleetStatus()` text, applying concurrency-spec decision #1 that the current branch never adopted.
- `provisionRoster` registers roster members directly rather than through `provisionPair`, so roster names come from `roster.mjs` alone.

**Type consistency check**
- `Lease` fields `{ workerId, doer, reviewer, signal, release }` are produced identically in Task 3 (`#lease`) and Task 7 (`create`) and consumed in Tasks 8, 10, 11.
- `onRelease(listener) → unsubscribe` on both `WorkerPool` (Task 3) and `EphemeralWorkerFactory` (Task 7); `WorkerDispatcher` (Task 8) subscribes to both and unsubscribes in `close()`.
- `pool.size` / `ephemeral.maxConcurrent` feed `dispatcher.capacity` (Tasks 3, 7, 8); the fake ephemeral in Task 8's test exposes `maxConcurrent` for this reason.
- `createMockFleetApi` options `{ members, tools, registerFails, commandPayload }` and fields `present, registerCalls, removeCalls, authCalls, commandCalls, promptCalls` (Task 3) are what Tasks 6, 7, 9, 10, 11 use.
- `workspace` `{ workerId, doer, reviewer }` is built in Task 10 (`server.mjs`) and Task 11 (`standalone.mjs`) and consumed by `demo.js`, `inspect-members.js`, and the registry.
- `run({ fleetApi, args, signal, reportPhase, workspace })` is the registry contract in Tasks 10 and 11.
