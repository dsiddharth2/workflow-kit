# Shared Worker Pool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make concurrent workflow runs safe by giving each run exclusive use of one doer+reviewer worker pair, shared across processes through file locks.

**Architecture:** A new dependency-free `pool/` layer owns worker identity, cross-process locking, cleanup, and lease handout. Launchers (`workflows/*/main.mjs`) acquire a lease and wrap `fleetApi` so workflow bodies address members by the role keywords `'doer'`/`'reviewer'` instead of hardcoded names. The MCP server builds one pool at startup; direct CLI runs and tests build their own.

**Tech Stack:** Node ≥22.16, ESM, `node --test`, `proper-lockfile`, existing `@apralabs/apra-fleet-client` and `@apralabs/apra-fleet-workflow`.

**Spec:** `docs/specs/concurrency-spec.md`

## Global Constraints

- Node ≥ 22.16, ESM only (`"type": "module"`). No TypeScript.
- Tests use `node --test` with `node:test` and `node:assert/strict`.
- Exactly one new runtime dependency: `proper-lockfile` (^4.1.2). No others.
- Dependency direction is one-way: `mcp/` → `workflows/` → `pool/`. Nothing in `pool/` may import from `mcp/` or `workflows/`.
- Members are `WORKER-{i}-DOER` / `WORKER-{i}-REVIEWER`, **1-indexed**.
- Folders are `<root>/worker-{i}/doer` and `<root>/worker-{i}/reviewer`.
- Lock targets are `<root>/.locks/worker-{i}`.
- Reserved role keywords are lowercase `'doer'` and `'reviewer'`. Any other `member_name` passes through unchanged.
- `WORKER_POOL_SIZE` default `4`; `WORKER_POOL_ROOT` default `<repo>/workdir`; `WORKER_POOL_ACQUIRE_TIMEOUT_MS` default `300000`.
- Lock heartbeat `update: 5000`, `stale: 15000`. Queue heartbeat immediate then every `30000`. Poll interval `1000` plus jitter.
- Cleanup preserves `.claude/` and nothing else.
- Member presence is checked with `listMembers()`, never `fleetStatus()`, and matching is token-exact.
- The pool never calls `registerMember`. Provisioning owns registration.
- Commit after every task.

---

### Task 1: Pool configuration and roster

**Files:**
- Create: `pool/roster.mjs`
- Test: `tests/pool-roster.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `DOER`, `REVIEWER` (string constants `'doer'`/`'reviewer'`); `ROLES` (frozen `['doer','reviewer']`); `poolConfig(env) -> { size: number, root: string, acquireTimeoutMs: number }`; `workerDescriptor(root, id) -> { id, doer: { name, folder }, reviewer: { name, folder }, lockTarget }`; `buildRoster({ size, root }) -> Worker[]`; `rosterMemberNames(roster) -> string[]`.

- [ ] **Step 1: Write the failing test**

```js
// tests/pool-roster.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  DOER,
  REVIEWER,
  buildRoster,
  poolConfig,
  rosterMemberNames,
  workerDescriptor,
} from '../pool/roster.mjs';

test('role keywords are the reserved lowercase strings', () => {
  assert.equal(DOER, 'doer');
  assert.equal(REVIEWER, 'reviewer');
});

test('poolConfig falls back to documented defaults', () => {
  const config = poolConfig({});
  assert.equal(config.size, 4);
  assert.equal(config.acquireTimeoutMs, 300000);
  assert.equal(path.basename(config.root), 'workdir');
});

test('poolConfig reads the environment', () => {
  const config = poolConfig({
    WORKER_POOL_SIZE: '8',
    WORKER_POOL_ROOT: '/tmp/pool-root',
    WORKER_POOL_ACQUIRE_TIMEOUT_MS: '1000',
  });
  assert.equal(config.size, 8);
  assert.equal(config.root, '/tmp/pool-root');
  assert.equal(config.acquireTimeoutMs, 1000);
});

test('poolConfig rejects sizes that are not positive integers', () => {
  assert.throws(() => poolConfig({ WORKER_POOL_SIZE: '0' }), /WORKER_POOL_SIZE/);
  assert.throws(() => poolConfig({ WORKER_POOL_SIZE: 'four' }), /WORKER_POOL_SIZE/);
  assert.throws(() => poolConfig({ WORKER_POOL_SIZE: '2.5' }), /WORKER_POOL_SIZE/);
});

test('workerDescriptor is 1-indexed and pairs names with folders', () => {
  const worker = workerDescriptor('/root', 2);
  assert.equal(worker.id, 2);
  assert.equal(worker.doer.name, 'WORKER-2-DOER');
  assert.equal(worker.reviewer.name, 'WORKER-2-REVIEWER');
  assert.equal(worker.doer.folder, path.join('/root', 'worker-2', 'doer'));
  assert.equal(worker.reviewer.folder, path.join('/root', 'worker-2', 'reviewer'));
  assert.equal(worker.lockTarget, path.join('/root', '.locks', 'worker-2'));
});

test('buildRoster produces size workers starting at 1', () => {
  const roster = buildRoster({ size: 3, root: '/root' });
  assert.deepEqual(roster.map((worker) => worker.id), [1, 2, 3]);
  assert.deepEqual(rosterMemberNames(roster).slice(0, 2), ['WORKER-1-DOER', 'WORKER-1-REVIEWER']);
  assert.equal(rosterMemberNames(roster).length, 6);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/pool-roster.test.mjs`
Expected: FAIL — `Cannot find module '../pool/roster.mjs'`

- [ ] **Step 3: Write minimal implementation**

```js
// pool/roster.mjs
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

export function poolConfig(env = process.env) {
  return {
    size: positiveInt(env.WORKER_POOL_SIZE, 'WORKER_POOL_SIZE', DEFAULT_POOL_SIZE),
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/pool-roster.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add pool/roster.mjs tests/pool-roster.test.mjs
git commit -m "feat: add worker pool roster and configuration"
```

---

### Task 2: Worker folder cleanup

**Files:**
- Create: `pool/cleanup.mjs`
- Test: `tests/pool-cleanup.test.mjs`

**Interfaces:**
- Consumes: `workerDescriptor` shape from Task 1 (`{ doer: { folder }, reviewer: { folder } }`).
- Produces: `PRESERVED_ENTRIES` (frozen `['.claude']`); `cleanWorkerFolder(folder) -> Promise<string[]>` returning removed entry names; `cleanWorker(worker) -> Promise<string[]>`.

- [ ] **Step 1: Write the failing test**

```js
// tests/pool-cleanup.test.mjs
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/pool-cleanup.test.mjs`
Expected: FAIL — `Cannot find module '../pool/cleanup.mjs'`

- [ ] **Step 3: Write minimal implementation**

```js
// pool/cleanup.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROLES } from './roster.mjs';

// Fleet writes its own permission state here at registration. Wiping it makes
// the member re-prompt or fail on the next run, so it is the one exception.
export const PRESERVED_ENTRIES = Object.freeze(['.claude']);

export async function cleanWorkerFolder(folder) {
  await fs.mkdir(folder, { recursive: true });
  const entries = await fs.readdir(folder);
  const removed = [];
  for (const entry of entries) {
    if (PRESERVED_ENTRIES.includes(entry)) continue;
    await fs.rm(path.join(folder, entry), { recursive: true, force: true });
    removed.push(entry);
  }
  return removed;
}

export async function cleanWorker(worker) {
  const removed = [];
  for (const role of ROLES) {
    removed.push(...(await cleanWorkerFolder(worker[role].folder)));
  }
  return removed;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/pool-cleanup.test.mjs`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add pool/cleanup.mjs tests/pool-cleanup.test.mjs
git commit -m "feat: add worker folder cleanup preserving .claude"
```

---

### Task 3: Cross-process worker lock

**Files:**
- Create: `pool/worker-lock.mjs`
- Create: `tests/helpers/hold-lock.mjs`
- Modify: `package.json` (add `proper-lockfile` dependency)
- Test: `tests/pool-worker-lock.test.mjs`

**Interfaces:**
- Consumes: `lockTarget` string from Task 1.
- Produces: `LOCK_UPDATE_MS` (5000); `LOCK_STALE_MS` (15000); `tryClaim(lockTarget, { onCompromised }) -> Promise<(() => Promise<void>) | null>` (null means already held); `readHolder(lockTarget) -> Promise<{ locked: boolean, heldSince: string | null }>`.

- [ ] **Step 1: Add the dependency**

```bash
npm install proper-lockfile@^4.1.2
```

- [ ] **Step 2: Write the failing test**

```js
// tests/pool-worker-lock.test.mjs
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
```

- [ ] **Step 3: Write the child-process helper**

```js
// tests/helpers/hold-lock.mjs
// Claims a worker lock, announces it on stdout, and holds until SIGTERM.
// Used by tests/pool-worker-lock.test.mjs to prove cross-process exclusion.
import { tryClaim } from '../../pool/worker-lock.mjs';

const target = process.argv[2];
const release = await tryClaim(target);
if (!release) {
  console.log('busy');
  process.exit(1);
}
console.log('locked');

const shutdown = async () => {
  await release();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Keep the event loop alive without spinning.
setInterval(() => {}, 60000);
```

- [ ] **Step 4: Run test to verify it fails**

Run: `node --test tests/pool-worker-lock.test.mjs`
Expected: FAIL — `Cannot find module '../pool/worker-lock.mjs'`

- [ ] **Step 5: Write minimal implementation**

```js
// pool/worker-lock.mjs
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
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test tests/pool-worker-lock.test.mjs`
Expected: PASS, 5 tests

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json pool/worker-lock.mjs tests/pool-worker-lock.test.mjs tests/helpers/hold-lock.mjs
git commit -m "feat: add cross-process worker lock over proper-lockfile"
```

---

### Task 4: Fleet result text and token-exact member matching

**Files:**
- Create: `pool/fleet-text.mjs`
- Test: `tests/pool-fleet-text.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `toolText(result) -> string`; `memberIsPresent(text, name) -> boolean`.

- [ ] **Step 1: Write the failing test**

```js
// tests/pool-fleet-text.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memberIsPresent, toolText } from '../pool/fleet-text.mjs';

test('toolText reads MCP content envelopes', () => {
  assert.equal(toolText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(toolText('plain'), 'plain');
  assert.equal(toolText(null), '');
});

test('memberIsPresent matches a whole name', () => {
  assert.equal(memberIsPresent('WORKER-1-DOER\nWORKER-1-REVIEWER', 'WORKER-1-DOER'), true);
  assert.equal(memberIsPresent('WORKER-2-DOER', 'WORKER-1-DOER'), false);
});

test('memberIsPresent does not match a name that is only a prefix', () => {
  // The bug this exists to prevent: WORKER-1-DOER is a substring of
  // WORKER-11-DOER, so a naive includes() reports a missing worker present.
  assert.equal(memberIsPresent('WORKER-11-DOER', 'WORKER-1-DOER'), false);
  assert.equal(memberIsPresent('WORKER-11-DOER\nWORKER-1-DOER', 'WORKER-1-DOER'), true);
});

test('memberIsPresent matches names inside JSON output', () => {
  const json = '{"members":[{"friendly_name":"WORKER-1-DOER"}]}';
  assert.equal(memberIsPresent(json, 'WORKER-1-DOER'), true);
  assert.equal(memberIsPresent(json, 'WORKER-1-REVIEWER'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/pool-fleet-text.test.mjs`
Expected: FAIL — `Cannot find module '../pool/fleet-text.mjs'`

- [ ] **Step 3: Write minimal implementation**

```js
// pool/fleet-text.mjs

// Every Fleet call returns an MCP envelope (content[] / structuredContent),
// so text extraction is a shared helper rather than inline property access.
export function toolText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  const response = result.structuredContent?.response;
  if (typeof response === 'string' && response.length > 0) return response;
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

// Matching must be token-exact. `WORKER-1-DOER` is a substring of
// `WORKER-11-DOER`, so includes() would report a missing worker as present
// once the pool size reaches double digits.
const BOUNDARY = '[^A-Za-z0-9_-]';

export function memberIsPresent(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|${BOUNDARY})${escaped}($|${BOUNDARY})`).test(String(text));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/pool-fleet-text.test.mjs`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add pool/fleet-text.mjs tests/pool-fleet-text.test.mjs
git commit -m "feat: add token-exact member matching for roster checks"
```

---

### Task 5: Role-keyword remapping wrapper

**Files:**
- Create: `pool/pooled-fleet-api.mjs`
- Test: `tests/pool-pooled-fleet-api.test.mjs`

**Interfaces:**
- Consumes: `DOER`/`REVIEWER` from Task 1; a lease shape `{ doer: { name }, reviewer: { name } }` from Task 6.
- Produces: `createPooledFleetApi(fleetApi, lease) -> fleetApi`.

- [ ] **Step 1: Write the failing test**

```js
// tests/pool-pooled-fleet-api.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPooledFleetApi } from '../pool/pooled-fleet-api.mjs';

function fixture() {
  const calls = [];
  const fleetApi = {
    calls,
    async executeCommand(options) { calls.push(['command', options]); return 'ok'; },
    async executePrompt(options) { calls.push(['prompt', options]); return 'ok'; },
    async listMembers() { return { content: [{ type: 'text', text: 'roster' }] }; },
  };
  const lease = {
    workerId: 2,
    doer: { name: 'WORKER-2-DOER', folder: '/root/worker-2/doer' },
    reviewer: { name: 'WORKER-2-REVIEWER', folder: '/root/worker-2/reviewer' },
  };
  return { fleetApi, lease, api: createPooledFleetApi(fleetApi, lease) };
}

test('role keywords resolve to this lease-s members', async () => {
  const { api, fleetApi } = fixture();
  await api.executeCommand({ command: 'ls', member_name: 'doer' });
  await api.executePrompt({ prompt: 'hi', member_name: 'reviewer' });
  assert.equal(fleetApi.calls[0][1].member_name, 'WORKER-2-DOER');
  assert.equal(fleetApi.calls[1][1].member_name, 'WORKER-2-REVIEWER');
});

test('a literal member name passes through unchanged', async () => {
  const { api, fleetApi } = fixture();
  await api.executeCommand({ command: 'ls', member_name: 'SOME-OTHER-MEMBER' });
  assert.equal(fleetApi.calls[0][1].member_name, 'SOME-OTHER-MEMBER');
});

test('other options and other methods are untouched', async () => {
  const { api, fleetApi } = fixture();
  await api.executeCommand({ command: 'ls', member_name: 'doer', failSoft: true });
  assert.equal(fleetApi.calls[0][1].command, 'ls');
  assert.equal(fleetApi.calls[0][1].failSoft, true);
  assert.equal(await api.listMembers().then((r) => r.content[0].text), 'roster');
});

test('non-function properties stay readable through the wrapper', async () => {
  const { api, fleetApi } = fixture();
  await api.executeCommand({ command: 'ls', member_name: 'doer' });
  assert.equal(api.calls, fleetApi.calls, 'test mocks expose recorded calls as arrays');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/pool-pooled-fleet-api.test.mjs`
Expected: FAIL — `Cannot find module '../pool/pooled-fleet-api.mjs'`

- [ ] **Step 3: Write minimal implementation**

```js
// pool/pooled-fleet-api.mjs
import { DOER, REVIEWER } from './roster.mjs';

// Only the two member-addressed calls are remapped. registerMember,
// fleetStatus, listMembers and everything else pass straight through, and so
// does any member_name that is not a reserved keyword -- diagnostics can still
// target a literal member. Existing members are uppercase by convention, so
// the two namespaces cannot collide.
const REMAPPED = new Set(['executeCommand', 'executePrompt']);

export function createPooledFleetApi(fleetApi, lease) {
  const resolve = (name) => {
    if (name === DOER) return lease.doer.name;
    if (name === REVIEWER) return lease.reviewer.name;
    return name;
  };

  return new Proxy(fleetApi, {
    get(target, prop, receiver) {
      if (REMAPPED.has(prop) && typeof target[prop] === 'function') {
        return (options = {}) =>
          target[prop]({ ...options, member_name: resolve(options.member_name) });
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/pool-pooled-fleet-api.test.mjs`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add pool/pooled-fleet-api.mjs tests/pool-pooled-fleet-api.test.mjs
git commit -m "feat: add role-keyword remapping fleetApi wrapper"
```

---

### Task 6: The worker pool

**Files:**
- Create: `pool/worker-pool.mjs`
- Create: `tests/helpers/mock-fleet.mjs`
- Test: `tests/pool-worker-pool.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces: `WorkerPool` with `static create({ fleetApi, env, config }) -> Promise<WorkerPool>`, `acquire({ signal, reportPhase }) -> Promise<Lease>`, `close() -> Promise<void>`, getters `size` and `roster`; `PoolSaturatedError`; `RosterError`; `HEARTBEAT_MS`; `POLL_MS`. A `Lease` is `{ workerId, doer: { name, folder }, reviewer: { name, folder }, signal, release() }`.
- Produces (test helper): `createMockFleetApi({ members, missing }) -> mock` exposing `registerCalls`, `commandCalls`, `promptCalls`.

- [ ] **Step 1: Write the shared test mock**

```js
// tests/helpers/mock-fleet.mjs
// One mock for every test file. listMembers is the call the pool verifies its
// roster with -- fleetStatus reports server info, not members, so a mock that
// answers member names from fleetStatus would hide a real bug.
export function createMockFleetApi({ members = [], missing = [] } = {}) {
  const registerCalls = [];
  const commandCalls = [];
  const promptCalls = [];
  const present = members.filter((name) => !missing.includes(name));

  return {
    registerCalls,
    commandCalls,
    promptCalls,
    async listMembers() {
      return { content: [{ type: 'text', text: present.join('\n') }] };
    },
    async fleetStatus() {
      return { content: [{ type: 'text', text: 'fleet server: running' }] };
    },
    async registerMember(options) {
      registerCalls.push(options);
      return { content: [{ type: 'text', text: `registered ${options.friendly_name}` }] };
    },
    async executeCommand(options) {
      commandCalls.push(options);
      const payload = 'hello-from-python';
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
}

export function rosterNames(size) {
  return Array.from({ length: size }, (_, index) => index + 1).flatMap((id) => [
    `WORKER-${id}-DOER`,
    `WORKER-${id}-REVIEWER`,
  ]);
}
```

- [ ] **Step 2: Write the failing test**

```js
// tests/pool-worker-pool.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PoolSaturatedError, RosterError, WorkerPool } from '../pool/worker-pool.mjs';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';

async function makePool({ size = 1, acquireTimeoutMs = 300000, missing = [] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-pool-'));
  const fleetApi = createMockFleetApi({ members: rosterNames(size), missing });
  const pool = await WorkerPool.create({
    fleetApi,
    config: { size, root, acquireTimeoutMs },
  });
  return { pool, fleetApi, root };
}

test('create fails loudly when a worker is not registered', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-pool-'));
  const fleetApi = createMockFleetApi({
    members: rosterNames(2),
    missing: ['WORKER-2-REVIEWER'],
  });
  await assert.rejects(
    () => WorkerPool.create({ fleetApi, config: { size: 2, root, acquireTimeoutMs: 1000 } }),
    (err) => {
      assert.ok(err instanceof RosterError);
      assert.match(err.message, /WORKER-2-REVIEWER/);
      assert.match(err.message, /provision-members\.sh/);
      return true;
    },
  );
});

test('create never registers members itself', async () => {
  const { fleetApi } = await makePool({ size: 2 });
  assert.deepEqual(fleetApi.registerCalls, [], 'provisioning owns registration');
});

test('create makes every worker folder', async () => {
  const { root } = await makePool({ size: 2 });
  for (const id of [1, 2]) {
    assert.deepEqual(
      (await fs.readdir(path.join(root, `worker-${id}`))).sort(),
      ['doer', 'reviewer'],
    );
  }
});

test('concurrent acquires get different workers', async () => {
  const { pool } = await makePool({ size: 2 });
  const [first, second] = await Promise.all([pool.acquire(), pool.acquire()]);
  assert.notEqual(first.workerId, second.workerId);
  assert.equal(first.doer.name, `WORKER-${first.workerId}-DOER`);
  await first.release();
  await second.release();
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
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(waitingResolved, false, 'must not hand out a held worker');

  await held.release();
  const lease = await waiting;
  assert.equal(lease.workerId, 1);
  await lease.release();
  await pool.close();
});

test('a queued caller gets an immediate heartbeat with its position', async () => {
  const { pool } = await makePool({ size: 1 });
  const held = await pool.acquire();
  const phases = [];

  const waiting = pool.acquire({ reportPhase: (message) => phases.push(message) });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(phases.length, 1, 'one heartbeat on entering the queue');
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
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort(new Error('caller went away'));
  await assert.rejects(() => waiting, /caller went away/);

  // The dangling waiter must be gone: releasing hands off to nobody, and the
  // next acquire succeeds immediately.
  await held.release();
  const lease = await pool.acquire();
  assert.equal(lease.workerId, 1);
  await lease.release();
  await pool.close();
});

test('acquire cleans a folder left dirty by a crashed holder', async () => {
  const { pool, root } = await makePool({ size: 1 });
  const stale = path.join(root, 'worker-1', 'doer', 'left-behind.txt');
  await fs.writeFile(stale, 'from a crashed run');

  const lease = await pool.acquire();
  await assert.rejects(() => fs.access(stale), 'acquire must wipe inherited files');
  await lease.release();
  await pool.close();
});

test('release is idempotent', async () => {
  const { pool } = await makePool({ size: 1 });
  const lease = await pool.acquire();
  await lease.release();
  await lease.release();
  const second = await pool.acquire();
  assert.equal(second.workerId, 1);
  await second.release();
  await pool.close();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/pool-worker-pool.test.mjs`
Expected: FAIL — `Cannot find module '../pool/worker-pool.mjs'`

- [ ] **Step 4: Write minimal implementation**

```js
// pool/worker-pool.mjs
import fs from 'node:fs/promises';
import { cleanWorker } from './cleanup.mjs';
import { memberIsPresent, toolText } from './fleet-text.mjs';
import { buildRoster, poolConfig, rosterMemberNames } from './roster.mjs';
import { tryClaim } from './worker-lock.mjs';

// Beats the 60s first-response-byte timer immediately, then the 5-minute idle
// timer every 30s. See docs/mcp-interface.md for the timer inventory.
export const HEARTBEAT_MS = 30000;
// Cross-process releases cannot notify us, so waiting degrades to polling.
export const POLL_MS = 1000;

export class RosterError extends Error {}
export class PoolSaturatedError extends Error {}

export class WorkerPool {
  #fleetApi;
  #config;
  #roster;
  #held = new Set();
  #waiters = [];
  #pollTimer = null;
  #servicing = false;
  #closed = false;

  constructor(fleetApi, config, roster) {
    this.#fleetApi = fleetApi;
    this.#config = config;
    this.#roster = roster;
  }

  static async create({ fleetApi, env = process.env, config } = {}) {
    if (!fleetApi) throw new Error('WorkerPool.create requires fleetApi');
    const resolved = config ?? poolConfig(env);
    const pool = new WorkerPool(fleetApi, resolved, buildRoster(resolved));
    await pool.#verifyRoster();
    return pool;
  }

  get size() { return this.#roster.length; }
  get roster() { return this.#roster; }
  get config() { return this.#config; }

  // Verify, never register. Provisioning owns registration and OAuth; a pool
  // that self-registered would hide the drift this check exists to catch, and
  // the member it created would still have no credentials.
  async #verifyRoster() {
    const text = toolText(await this.#fleetApi.listMembers({ format: 'json' }));
    const missing = rosterMemberNames(this.#roster).filter((name) => !memberIsPresent(text, name));
    if (missing.length > 0) {
      throw new RosterError(
        `These worker members are not registered: ${missing.join(', ')}.\n` +
          `Run scripts/provision-members.sh with WORKER_POOL_SIZE=${this.size}, ` +
          'or in Docker: docker compose up --build.',
      );
    }
    for (const worker of this.#roster) {
      await fs.mkdir(worker.doer.folder, { recursive: true });
      await fs.mkdir(worker.reviewer.folder, { recursive: true });
    }
  }

  async acquire({ signal, reportPhase } = {}) {
    if (this.#closed) throw new Error('WorkerPool is closed');
    signal?.throwIfAborted();
    const lease = await this.#tryAcquireNow(signal);
    if (lease) return lease;
    return await this.#queue({ signal, reportPhase });
  }

  async #tryAcquireNow(signal) {
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
      workerId: worker.id,
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
      timeout.unref?.();

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
        const lease = await this.#tryAcquireNow(waiter.signal);
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

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/pool-worker-pool.test.mjs`
Expected: PASS, 10 tests

- [ ] **Step 6: Commit**

```bash
git add pool/worker-pool.mjs tests/pool-worker-pool.test.mjs tests/helpers/mock-fleet.mjs
git commit -m "feat: add the shared worker pool with leases and queueing"
```

---

### Task 7: Wire the demo workflow to the pool

**Files:**
- Modify: `workflows/demo/demo.js` (delete lines 7-13 and 29-57; rewrite `main`)
- Modify: `workflows/demo/main.mjs:10-44`
- Modify: `tests/demo.test.mjs` (replace the local mock; update assertions)
- Modify: `package.json` (test script)

**Interfaces:**
- Consumes: `WorkerPool` and `Lease` from Task 6; `createPooledFleetApi` from Task 5; `createMockFleetApi`/`rosterNames` from Task 6.
- Produces: `runDemo({ fleetApi, pool, signal, reportPhase }) -> Promise<result>`; workflow bodies receive `args.workspace = { workerId, doer: { name, folder }, reviewer: { name, folder } }`.

- [ ] **Step 1: Update the test to the new contract**

```js
// tests/demo.test.mjs — replace the whole file
import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';

const { runDemo } = await import('../workflows/demo/main.mjs');
const { WorkerPool } = await import('../pool/worker-pool.mjs');

const dummyPy = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../workflows/demo/dummy.py',
);

async function withPool(fleetApi, size = 1) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'demo-pool-'));
  return await WorkerPool.create({
    fleetApi,
    config: { size, root, acquireTimeoutMs: 5000 },
  });
}

test('runDemo runs the python command and smokes the agent on its worker', async () => {
  const fleetApi = createMockFleetApi({ members: rosterNames(1) });
  const pool = await withPool(fleetApi);

  const result = await runDemo({ fleetApi, pool });
  assert.match(String(result.command?.output ?? result.command), /hello-from-python/);
  assert.deepEqual(result.transform, { ok: true, source: 'transform' });
  assert.match(String(result.agent?.response ?? result.agent), /\bpong\b/i);

  assert.equal(fleetApi.commandCalls.length, 1);
  assert.equal(fleetApi.commandCalls[0].member_name, 'WORKER-1-DOER');
  assert.match(fleetApi.commandCalls[0].command, /python3/);
  assert.ok(fleetApi.commandCalls[0].command.includes(dummyPy));

  assert.equal(fleetApi.promptCalls.length, 1);
  assert.equal(fleetApi.promptCalls[0].member_name, 'WORKER-1-DOER');

  await pool.close();
});

test('the workflow registers nothing', async () => {
  const fleetApi = createMockFleetApi({ members: rosterNames(1) });
  const pool = await withPool(fleetApi);
  await runDemo({ fleetApi, pool });
  assert.deepEqual(fleetApi.registerCalls, [], 'provisioning owns registration');
  await pool.close();
});

test('the worker is released back to the pool after a run', async () => {
  const fleetApi = createMockFleetApi({ members: rosterNames(1) });
  const pool = await withPool(fleetApi);
  await runDemo({ fleetApi, pool });
  await runDemo({ fleetApi, pool });
  assert.equal(fleetApi.commandCalls.length, 2, 'a second run must get the worker back');
  await pool.close();
});

test('an aborted signal prevents the agent phase from spending tokens', async () => {
  const fleetApi = createMockFleetApi({ members: rosterNames(1) });
  const pool = await withPool(fleetApi);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(() => runDemo({ fleetApi, pool, signal: controller.signal }));
  assert.equal(fleetApi.promptCalls.length, 0, 'executePrompt must not run after abort');
  await pool.close();
});

test('aborting on the final progress notification prevents the agent call', async () => {
  const fleetApi = createMockFleetApi({ members: rosterNames(1) });
  const pool = await withPool(fleetApi);
  const controller = new AbortController();

  const result = await runDemo({
    fleetApi,
    pool,
    signal: controller.signal,
    reportPhase(message) {
      if (message === 'dispatching the agent prompt') controller.abort();
    },
  });

  assert.equal(result.cancelled, true);
  assert.equal(fleetApi.promptCalls.length, 0, 'executePrompt must not run after final progress');
  await pool.close();
});

test('reportPhase receives one message per phase and is optional', async () => {
  const fleetApi = createMockFleetApi({ members: rosterNames(1) });
  const pool = await withPool(fleetApi);
  const phases = [];
  await runDemo({ fleetApi, pool, reportPhase: (message) => phases.push(message) });
  assert.ok(phases.length >= 4, `expected a message per phase, got ${phases.length}`);

  // Omitting reportPhase must not throw.
  await runDemo({ fleetApi, pool });
  await pool.close();
});

test('runDemo builds its own pool when none is injected', async () => {
  const fleetApi = createMockFleetApi({ members: rosterNames(1) });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'demo-own-pool-'));
  const previous = { size: process.env.WORKER_POOL_SIZE, root: process.env.WORKER_POOL_ROOT };
  process.env.WORKER_POOL_SIZE = '1';
  process.env.WORKER_POOL_ROOT = root;
  try {
    const result = await runDemo({ fleetApi });
    assert.match(String(result.agent?.response ?? result.agent), /\bpong\b/i);
    assert.equal(fleetApi.commandCalls[0].member_name, 'WORKER-1-DOER');
  } finally {
    process.env.WORKER_POOL_SIZE = previous.size;
    process.env.WORKER_POOL_ROOT = previous.root;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/demo.test.mjs`
Expected: FAIL — the mock has no `fleetStatus` listing members, `runDemo` does not accept `pool`, and `member_name` is still `DEMO-DOER`

- [ ] **Step 3: Rewrite the workflow body**

```js
// workflows/demo/demo.js — replace the whole file
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const meta = { name: 'demo' };

const DUMMY_PY = fileURLToPath(new URL('./dummy.py', import.meta.url));

// The engine loads this module once and shares it across concurrent runs
// (Node's ESM cache), so module scope must stay immutable. Per-run state
// belongs inside main().

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
  // Cancellation is cooperative: an in-flight Fleet call cannot be aborted, so
  // each check prevents the NEXT phase from starting. The check before agent()
  // is the one that matters, because that is the phase that spends tokens.
  const cancelled = () => signal?.aborted === true;

  // 'doer' and 'reviewer' are reserved keywords; the pool resolves them to this
  // run's own members. Never name a member directly.
  log(`running on worker-${args.workspace?.workerId} as ${args.workspace?.doer?.name}`);

  phase('status');
  await reportPhase('reading fleet status');
  log(toolText(await fleetApi.fleetStatus()));
  if (cancelled()) return { cancelled: true };

  phase('python command');
  await reportPhase('running the python command');
  const cmdResult = await command(`python3 "${DUMMY_PY}"`, {
    member_name: 'doer',
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
  const reply = await agent('Reply with exactly: pong', { member_name: 'doer' });
  log(`agent result: ${reply}`);

  return { command: cmdResult, transform: payload, agent: reply };
}
```

- [ ] **Step 4: Rewrite the launcher**

```js
// workflows/demo/main.mjs — replace runDemo (lines 10-44), keep the rest
export async function runDemo({ fleetApi, pool, signal, reportPhase } = {}) {
  // Attach to `apra-fleet start` (where members + OAuth were provisioned).
  // Unset transport would fall back to stdio spawn, which cannot find the
  // npm-global server layout and would also miss those members.
  if (!process.env.APRA_FLEET_TRANSPORT) {
    process.env.APRA_FLEET_TRANSPORT = 'http';
  }
  ensureApralabs();
  const { FleetWorkflow } = await import('@apralabs/apra-fleet-workflow');
  const { WorkflowEngine } = await import('@apralabs/apra-fleet-workflow/engine');
  const { WorkerPool } = await import('../../pool/worker-pool.mjs');
  const { createPooledFleetApi } = await import('../../pool/pooled-fleet-api.mjs');

  let api = fleetApi;
  let transport = null;
  if (!api) {
    try {
      const { connectFleet } = await import('@apralabs/apra-fleet-client/server-resolution');
      const connected = await connectFleet({ env: process.env });
      api = connected.fleetApi;
      transport = connected.transport;
    } catch (err) {
      const detail = err?.message ?? err;
      const message = `Fleet server is not running or connectFleet() failed: ${detail}\nStart it with: cd ~/.apra-fleet/bin && apra-fleet start`;
      console.error(message);
      throw new Error(message, { cause: err });
    }
  }

  // A caller that owns a pool passes it in; a direct CLI run builds its own.
  let ownPool = null;
  try {
    const activePool = pool ?? (ownPool = await WorkerPool.create({ fleetApi: api }));
    const lease = await activePool.acquire({ signal, reportPhase });
    try {
      const pooledApi = createPooledFleetApi(api, lease);
      const workflow = new FleetWorkflow(pooledApi);
      const engine = new WorkflowEngine(workflow);
      return await engine.executeFile(engineScript, {
        fleetApi: pooledApi,
        workspace: { workerId: lease.workerId, doer: lease.doer, reviewer: lease.reviewer },
        // The lease signal is the caller's signal plus lock-compromise.
        signal: lease.signal,
        reportPhase,
      });
    } finally {
      await lease.release();
    }
  } finally {
    await ownPool?.close();
    transport?.stop?.();
  }
}
```

- [ ] **Step 5: Register the new test files**

```json
"test": "node --test tests/pool-roster.test.mjs tests/pool-cleanup.test.mjs tests/pool-worker-lock.test.mjs tests/pool-fleet-text.test.mjs tests/pool-pooled-fleet-api.test.mjs tests/pool-worker-pool.test.mjs tests/demo.test.mjs tests/inspect-members.test.mjs tests/mcp.test.mjs"
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test tests/demo.test.mjs`
Expected: PASS, 7 tests

- [ ] **Step 7: Commit**

```bash
git add workflows/demo/demo.js workflows/demo/main.mjs tests/demo.test.mjs package.json
git commit -m "feat: run the demo workflow on a pooled worker"
```

---

### Task 8: Make inspect-members observational

**Files:**
- Modify: `workflows/inspect-members/inspect-members.js` (replace the whole file)
- Modify: `workflows/inspect-members/main.mjs:12-66`
- Delete: `workflows/inspect-members/inspect.py`
- Modify: `tests/inspect-members.test.mjs` (replace the whole file)

**Interfaces:**
- Consumes: `poolConfig`, `buildRoster` from Task 1; `readHolder` from Task 3.
- Produces: `runInspectMembers({ fleetApi, workers, includeFiles, signal, reportPhase }) -> Promise<{ generatedAt, poolSize, workers: Array<{ id, busy, heldSince, doer, reviewer }> }>` where each role is `{ name, folder, exists, fileCount, totalBytes, entries? }`.

- [ ] **Step 1: Write the failing test**

```js
// tests/inspect-members.test.mjs — replace the whole file
import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';

const { runInspectMembers } = await import('../workflows/inspect-members/main.mjs');
const { tryClaim } = await import('../pool/worker-lock.mjs');

async function withRoot(size, run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inspect-'));
  const previous = { size: process.env.WORKER_POOL_SIZE, root: process.env.WORKER_POOL_ROOT };
  process.env.WORKER_POOL_SIZE = String(size);
  process.env.WORKER_POOL_ROOT = root;
  try {
    for (let id = 1; id <= size; id += 1) {
      await fs.mkdir(path.join(root, `worker-${id}`, 'doer'), { recursive: true });
      await fs.mkdir(path.join(root, `worker-${id}`, 'reviewer'), { recursive: true });
    }
    await run(root);
  } finally {
    process.env.WORKER_POOL_SIZE = previous.size;
    process.env.WORKER_POOL_ROOT = previous.root;
  }
}

test('reports every worker in the pool by default', async () => {
  await withRoot(2, async () => {
    const fleetApi = createMockFleetApi({ members: rosterNames(2) });
    const report = await runInspectMembers({ fleetApi });
    assert.equal(report.poolSize, 2);
    assert.deepEqual(report.workers.map((w) => w.id), [1, 2]);
    assert.equal(report.workers[0].doer.name, 'WORKER-1-DOER');
    assert.ok(Date.parse(report.generatedAt) > 0);
  });
});

test('never executes commands as a member', async () => {
  await withRoot(1, async () => {
    const fleetApi = createMockFleetApi({ members: rosterNames(1) });
    await runInspectMembers({ fleetApi });
    assert.deepEqual(fleetApi.commandCalls, [], 'inspection must not touch a member session');
  });
});

test('reports folder contents from disk', async () => {
  await withRoot(1, async (root) => {
    await fs.writeFile(path.join(root, 'worker-1', 'doer', 'a.txt'), 'hello');
    const fleetApi = createMockFleetApi({ members: rosterNames(1) });
    const report = await runInspectMembers({ fleetApi, includeFiles: true });
    assert.equal(report.workers[0].doer.exists, true);
    assert.equal(report.workers[0].doer.fileCount, 1);
    assert.equal(report.workers[0].doer.totalBytes, 5);
    assert.deepEqual(report.workers[0].doer.entries, ['a.txt']);
    assert.equal(report.workers[0].reviewer.entries.length, 0);
  });
});

test('omits entries unless includeFiles is set', async () => {
  await withRoot(1, async (root) => {
    await fs.writeFile(path.join(root, 'worker-1', 'doer', 'a.txt'), 'hello');
    const fleetApi = createMockFleetApi({ members: rosterNames(1) });
    const report = await runInspectMembers({ fleetApi });
    assert.equal(report.workers[0].doer.entries, undefined);
    assert.equal(report.workers[0].doer.fileCount, 1);
  });
});

test('reports a held worker as busy with the time it was taken', async () => {
  await withRoot(1, async (root) => {
    const release = await tryClaim(path.join(root, '.locks', 'worker-1'));
    try {
      const fleetApi = createMockFleetApi({ members: rosterNames(1) });
      const report = await runInspectMembers({ fleetApi });
      assert.equal(report.workers[0].busy, true);
      assert.ok(Date.parse(report.workers[0].heldSince) > 0);
    } finally {
      await release();
    }
  });
});

test('a free worker reports busy false', async () => {
  await withRoot(1, async () => {
    const fleetApi = createMockFleetApi({ members: rosterNames(1) });
    const report = await runInspectMembers({ fleetApi });
    assert.equal(report.workers[0].busy, false);
    assert.equal(report.workers[0].heldSince, null);
  });
});

test('a workers filter narrows the report', async () => {
  await withRoot(3, async () => {
    const fleetApi = createMockFleetApi({ members: rosterNames(3) });
    const report = await runInspectMembers({ fleetApi, workers: [2] });
    assert.deepEqual(report.workers.map((w) => w.id), [2]);
  });
});

test('an out-of-range worker id is rejected', async () => {
  await withRoot(2, async () => {
    const fleetApi = createMockFleetApi({ members: rosterNames(2) });
    await assert.rejects(() => runInspectMembers({ fleetApi, workers: [5] }), /worker 5/i);
  });
});

test('reportPhase is called and is optional', async () => {
  await withRoot(1, async () => {
    const fleetApi = createMockFleetApi({ members: rosterNames(1) });
    const phases = [];
    await runInspectMembers({ fleetApi, reportPhase: (message) => phases.push(message) });
    assert.ok(phases.length >= 1, 'reportPhase should be invoked at least once');
    await runInspectMembers({ fleetApi });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/inspect-members.test.mjs`
Expected: FAIL — the report has no `poolSize`/`workers` shape

- [ ] **Step 3: Rewrite the workflow body**

```js
// workflows/inspect-members/inspect-members.js — replace the whole file
import fs from 'node:fs/promises';
import path from 'node:path';
import { readHolder } from '../../pool/worker-lock.mjs';

export const meta = { name: 'inspect-members' };

// Purely observational. It deliberately never runs a command AS a member:
// inspecting a worker some run is holding would be the concurrent-same-member
// collision the pool exists to prevent. Folder contents come from this
// process's own filesystem, and busy/free from the worker's lock file.

async function folderReport(role, includeFiles) {
  let entries;
  try {
    entries = await fs.readdir(role.folder);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { name: role.name, folder: role.folder, exists: false, fileCount: 0, totalBytes: 0 };
    }
    throw err;
  }

  let fileCount = 0;
  let totalBytes = 0;
  for (const entry of entries) {
    const stat = await fs.stat(path.join(role.folder, entry));
    if (stat.isFile()) {
      fileCount += 1;
      totalBytes += stat.size;
    }
  }

  const report = { name: role.name, folder: role.folder, exists: true, fileCount, totalBytes };
  if (includeFiles) report.entries = entries;
  return report;
}

export async function main(context) {
  const { phase, log, args } = context;
  const reportPhase = args.reportPhase ?? (() => {});
  const signal = args.signal;
  const includeFiles = args.includeFiles === true;
  const roster = args.roster ?? [];

  const workers = [];
  for (const worker of roster) {
    if (signal?.aborted) {
      log(`cancelled before inspecting worker-${worker.id}`);
      break;
    }
    phase(`inspect worker-${worker.id}`);
    await reportPhase(`inspecting worker-${worker.id}`);

    const holder = await readHolder(worker.lockTarget);
    workers.push({
      id: worker.id,
      busy: holder.locked,
      heldSince: holder.heldSince,
      doer: await folderReport(worker.doer, includeFiles),
      reviewer: await folderReport(worker.reviewer, includeFiles),
    });
  }

  return { generatedAt: new Date().toISOString(), poolSize: roster.length, workers };
}
```

- [ ] **Step 4: Rewrite the launcher**

```js
// workflows/inspect-members/main.mjs — replace runInspectMembers, keep the
// isMainModule block at the bottom unchanged
export async function runInspectMembers({
  fleetApi,
  workers,
  includeFiles,
  signal,
  reportPhase,
} = {}) {
  if (!process.env.APRA_FLEET_TRANSPORT) {
    process.env.APRA_FLEET_TRANSPORT = 'http';
  }
  ensureApralabs();
  const { FleetWorkflow } = await import('@apralabs/apra-fleet-workflow');
  const { WorkflowEngine } = await import('@apralabs/apra-fleet-workflow/engine');
  const { buildRoster, poolConfig } = await import('../../pool/roster.mjs');

  const config = poolConfig();
  const fullRoster = buildRoster(config);

  // Validated here rather than in the MCP schema: the pool is sized at runtime
  // from the environment, so the valid set is not known when the schema is built.
  let roster = fullRoster;
  if (Array.isArray(workers) && workers.length > 0) {
    for (const id of workers) {
      if (!Number.isInteger(id) || id < 1 || id > fullRoster.length) {
        throw new Error(`Unknown worker ${String(id)}: the pool has ${fullRoster.length} workers`);
      }
    }
    roster = fullRoster.filter((worker) => workers.includes(worker.id));
  }

  // Observational only: it takes no lease and needs no Fleet connection for the
  // folder or lock reads. fleetApi is still accepted so the launcher signature
  // matches every other workflow.
  let api = fleetApi;
  let transport = null;
  if (!api) {
    try {
      const { connectFleet } = await import('@apralabs/apra-fleet-client/server-resolution');
      const connected = await connectFleet({ env: process.env });
      api = connected.fleetApi;
      transport = connected.transport;
    } catch (err) {
      const detail = err?.message ?? err;
      const message = `Fleet server is not running or connectFleet() failed: ${detail}\nStart it with: cd ~/.apra-fleet/bin && apra-fleet start`;
      console.error(message);
      throw new Error(message, { cause: err });
    }
  }

  try {
    const workflow = new FleetWorkflow(api);
    const engine = new WorkflowEngine(workflow);
    return await engine.executeFile(engineScript, {
      fleetApi: api,
      roster,
      includeFiles,
      signal,
      reportPhase,
    });
  } finally {
    transport?.stop?.();
  }
}
```

- [ ] **Step 5: Delete the now-unused python script**

```bash
git rm workflows/inspect-members/inspect.py
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test tests/inspect-members.test.mjs`
Expected: PASS, 9 tests

- [ ] **Step 7: Commit**

```bash
git add workflows/inspect-members/ tests/inspect-members.test.mjs
git commit -m "refactor: make inspect-members observational and pool-aware"
```

---

### Task 9: Build the pool in the MCP server

**Files:**
- Modify: `mcp/main.mjs:7-71`
- Modify: `mcp/server.mjs:26-58`
- Modify: `mcp/registry.mjs` (both entries)
- Modify: `tests/mcp.test.mjs` (mock + `buildMcpServer` calls)

**Interfaces:**
- Consumes: `WorkerPool` from Task 6; `runDemo` from Task 7; `runInspectMembers` from Task 8.
- Produces: `startMcpServer({ fleetApi, pool, port }) -> Promise<{ server, close }>`; `buildMcpServer({ fleetApi, pool, registry })`; registry entries receive `run({ fleetApi, pool, args, signal, reportPhase })`.

- [ ] **Step 1: Update the MCP test**

Delete the local `createMockFleetApi` (lines 13-42) and replace the imports and
`withServer` helper with these. Everything below `within()` stays as it is,
except the two `startMcpServer` calls noted in the next step.

```js
// tests/mcp.test.mjs — imports and helpers
import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import * as z from 'zod/v4';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';

const { buildMcpServer } = await import('../mcp/server.mjs');
const { createMcpHttpApp } = await import('../mcp/http.mjs');
const { startMcpServer } = await import('../mcp/main.mjs');
const { WorkerPool } = await import('../pool/worker-pool.mjs');

async function makePool(fleetApi, size = 1) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-pool-'));
  return await WorkerPool.create({
    fleetApi,
    config: { size, root, acquireTimeoutMs: 5000 },
  });
}

// Starts the real express app on an ephemeral port and connects a real MCP
// client over streamable HTTP, so the transport wiring is exercised too.
async function withServer(registryOverride, run) {
  const fleetApi = createMockFleetApi({ members: rosterNames(1) });
  const pool = await makePool(fleetApi);
  const app = createMcpHttpApp({
    buildServer: () => buildMcpServer({ fleetApi, pool, registry: registryOverride }),
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
      await run({ client, fleetApi, pool });
    } finally {
      await client.close();
    }
  } finally {
    await pool.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
}
```

In the two `startMcpServer` tests, replace each `startMcpServer({ fleetApi: createMockFleetApi(), port })` call with a mock and pool built the same way:

```js
const fleetApi = createMockFleetApi({ members: rosterNames(1) });
const pool = await makePool(fleetApi);
// ...then pass { fleetApi, pool, port } instead of { fleetApi, port },
// and `await pool.close()` alongside the existing cleanup.
```

Add this test at the end of the file:

```js
test('a tool call reaches the workflow with a pooled fleetApi', async () => {
  const registry = [
    {
      name: 'echo-worker',
      description: 'Returns the worker this call was assigned.',
      async run({ pool }) {
        const lease = await pool.acquire();
        try {
          return `worker-${lease.workerId}`;
        } finally {
          await lease.release();
        }
      },
    },
  ];
  await withServer(registry, async ({ client }) => {
    const result = await client.callTool({ name: 'echo-worker', arguments: {} });
    assert.match(result.content[0].text, /worker-1/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/mcp.test.mjs`
Expected: FAIL — `buildMcpServer` ignores `pool`, so `run({ pool })` receives `undefined`

- [ ] **Step 3: Thread the pool through the server**

In `mcp/server.mjs`, change the signature and the invoke closure:

```js
export function buildMcpServer({ fleetApi, pool, registry = defaultRegistry } = {}) {
  if (!fleetApi) {
    throw new Error('buildMcpServer requires fleetApi');
  }
  const server = new McpServer(SERVER_INFO);

  for (const entry of registry) {
    const config = { description: entry.description };
    if (entry.inputSchema) config.inputSchema = entry.inputSchema;
    if (entry.annotations) config.annotations = entry.annotations;

    // A thrown error is turned into an isError result by the SDK, so there is
    // deliberately no try/catch here.
    const invoke = async (args, ctx) =>
      toToolResult(
        await entry.run({
          fleetApi,
          pool,
          args,
          signal: ctx.mcpReq.signal,
          reportPhase: makePhaseReporter(ctx),
        }),
      );
    // ...unchanged registerTool call below
```

- [ ] **Step 4: Build the pool once at startup**

In `mcp/main.mjs`, add the import and build the pool after `api` is resolved:

```js
import { WorkerPool } from '../pool/worker-pool.mjs';

export async function startMcpServer({ fleetApi, pool, port } = {}) {
```

After the `connectFleet` block and before `createMcpHttpApp`:

```js
  // One pool per process, built once at startup rather than per request.
  // A roster failure here is deliberately fatal: better a loud startup error
  // than an agent() call failing deep inside a run.
  let ownPool = null;
  let activePool = pool;
  if (!activePool) {
    try {
      activePool = ownPool = await WorkerPool.create({ fleetApi: api });
    } catch (err) {
      await transport?.stop?.();
      throw err;
    }
  }

  const app = createMcpHttpApp({
    buildServer: () => buildMcpServer({ fleetApi: api, pool: activePool }),
  });
```

In the existing listen-error `catch` block, add `await ownPool?.close();` beside the transport cleanup, and in `close()`:

```js
  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    await ownPool?.close();
    transport?.stop?.();
  };
```

- [ ] **Step 5: Update the registry**

```js
// mcp/registry.mjs — replace the whole file
import * as z from 'zod/v4';
import { runDemo } from '../workflows/demo/main.mjs';
import { runInspectMembers } from '../workflows/inspect-members/main.mjs';

// Routable workflows. To expose a new tool, append an entry here — no changes to
// server.mjs or http.mjs are needed. `description` is read by the connected
// model when it decides which tool to call, so write it for that reader.
export const defaultRegistry = [
  {
    name: 'demo',
    description:
      'Runs the demo workflow end to end on a pooled worker: the dummy python ' +
      'command, the transform, and an agent smoke test. Choose this to run the ' +
      'demo workflow or to verify that Fleet plumbing works. Queues when every ' +
      'worker is busy. Spends LLM tokens and can take a minute.',
    annotations: { readOnlyHint: false, idempotentHint: true },
    async run({ fleetApi, pool, signal, reportPhase }) {
      const result = await runDemo({ fleetApi, pool, signal, reportPhase });
      return `demo workflow completed: ${JSON.stringify(result)}`;
    },
  },
  {
    name: 'inspect-members',
    description:
      "Reports on this repo's worker pool: which workers are busy and since when, " +
      'and what is in each work folder. Choose this to check pool health or to see ' +
      'what a worker has been doing. Read-only, takes no worker, and spends no LLM tokens.',
    inputSchema: z.object({
      workers: z
        .array(z.number().int().positive())
        .optional()
        .describe('Worker numbers to inspect, e.g. [1, 2]. Defaults to every worker in the pool.'),
      includeFiles: z
        .boolean()
        .optional()
        .describe('Include a listing of top-level entries in each work folder.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args, signal, reportPhase }) {
      return await runInspectMembers({
        fleetApi,
        workers: args.workers,
        includeFiles: args.includeFiles,
        signal,
        reportPhase,
      });
    },
  },
];
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, all files

- [ ] **Step 7: Commit**

```bash
git add mcp/ tests/mcp.test.mjs
git commit -m "feat: build one worker pool per MCP server process"
```

---

### Task 10: Provisioning, Docker, and ignored paths

**Files:**
- Modify: `scripts/provision-members.sh` (replace lines 21-28)
- Modify: `scripts/docker-entrypoint.sh:25`
- Modify: `docker-compose.yml` (environment block)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: the naming and folder conventions from Task 1.
- Produces: 2N registered members with OAuth attached to every role.

- [ ] **Step 1: Loop the provisioning script over every worker**

```sh
# scripts/provision-members.sh — replace everything from line 21 to the end
WORKER_POOL_SIZE="${WORKER_POOL_SIZE:-4}"

i=1
while [ "$i" -le "$WORKER_POOL_SIZE" ]; do
  ensure_member "WORKER-${i}-DOER" "$(pwd)/workdir/worker-${i}/doer"
  ensure_member "WORKER-${i}-REVIEWER" "$(pwd)/workdir/worker-${i}/reviewer"
  i=$((i + 1))
done

if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  # Every role on every worker gets the token: a workflow author may target
  # either role with agent() and should not have to know which ones carry
  # credentials.
  i=1
  while [ "$i" -le "$WORKER_POOL_SIZE" ]; do
    apra-fleet auth --oauth --member "WORKER-${i}-DOER" "$CLAUDE_CODE_OAUTH_TOKEN"
    apra-fleet auth --oauth --member "WORKER-${i}-REVIEWER" "$CLAUDE_CODE_OAUTH_TOKEN"
    i=$((i + 1))
  done
else
  echo "CLAUDE_CODE_OAUTH_TOKEN is unset; skip auth. agent() calls will fail." >&2
fi
```

Also add folder creation to `ensure_member`, right before the `apra-fleet register-member` call:

```sh
  mkdir -p "$work_path"
```

- [ ] **Step 2: Update the Docker entrypoint**

Replace `scripts/docker-entrypoint.sh:25`:

```sh
  i=1
  while [ "$i" -le "${WORKER_POOL_SIZE:-4}" ]; do
    mkdir -p "/workspace/workdir/worker-${i}/doer" "/workspace/workdir/worker-${i}/reviewer"
    i=$((i + 1))
  done
```

- [ ] **Step 3: Pass the size through compose**

In `docker-compose.yml`, add to the `environment` block:

```yaml
      WORKER_POOL_SIZE: ${WORKER_POOL_SIZE:-4}
```

- [ ] **Step 4: Ignore worker state**

Append to `.gitignore`:

```
workdir/worker-*/
workdir/.locks/
```

- [ ] **Step 5: Verify the script runs**

Run: `sh -n scripts/provision-members.sh && sh -n scripts/docker-entrypoint.sh`
Expected: no output — both parse cleanly.

Confirm the loop expands to the right names without touching Fleet, by stubbing
the two commands the script calls:

Run:
```bash
WORKER_POOL_SIZE=2 sh -c '
  apra-fleet() { echo "apra-fleet $*"; }
  mkdir() { :; }
  . ./scripts/provision-members.sh
' 2>&1 | grep register-member
```
Expected: four `register-member` lines, naming `WORKER-1-DOER`, `WORKER-1-REVIEWER`, `WORKER-2-DOER`, `WORKER-2-REVIEWER`.

- [ ] **Step 6: Commit**

```bash
git add scripts/ docker-compose.yml .gitignore
git commit -m "feat: provision N worker pairs and authorize every role"
```

---

### Task 11: Documentation and cutover

**Files:**
- Modify: `README.md`, `docs/architecture.md`, `docs/development.md`, `docs/mcp-interface.md`
- Delete: `workdir/DEMO-DOER/`, `workdir/DEMO-REVIEWER/`, `workdir/BOILERPLATE-DOER/`, `workdir/BOILERPLATE-REVIEWER/`

**Interfaces:**
- Consumes: everything above.
- Produces: no code interfaces; the repo's documented contract matches the implementation.

- [ ] **Step 1: Retire the old work folders**

```bash
git rm -r workdir/DEMO-DOER workdir/DEMO-REVIEWER workdir/BOILERPLATE-DOER workdir/BOILERPLATE-REVIEWER
```

- [ ] **Step 2: Update `docs/architecture.md`**

In the "Member" paragraph, replace *"This repo registers two: `DEMO-DOER` and `DEMO-REVIEWER`"* with:

```markdown
This repo registers `WORKER_POOL_SIZE` (default 4) pairs: `WORKER-{i}-DOER` and
`WORKER-{i}-REVIEWER`. Workflow bodies never name them — they use the reserved
role keywords `'doer'` and `'reviewer'`, which the pool resolves to the members
assigned to that run. See [the concurrency spec](specs/concurrency-spec.md).
```

In the "Work folder" paragraph, replace the `workdir/DEMO-*` sentence with `workdir/worker-{i}/doer/` and `workdir/worker-{i}/reviewer/`, and note that locks live in `workdir/.locks/` outside the folders they protect so cleanup needs no exception.

Add a `### pool/` subsection to the "Module map" listing the five modules and their responsibilities, and a "Concurrency" subsection under "Design decisions worth knowing" summarising: one lease per run, cross-process file locks, cleanup on acquire and release, fail-fast roster verification.

- [ ] **Step 3: Update `docs/development.md`**

In "Provisioning members", document `WORKER_POOL_SIZE` and that changing it requires re-running `scripts/provision-members.sh`.

Add to "Conventions":

```markdown
- **Address members by role, never by name.** Pass `'doer'` or `'reviewer'` as
  `member_name`; the pool resolves them to the worker assigned to your run.
- **Keep workflow module scope immutable.** The engine loads your body once with
  `import()` and Node's ESM cache shares that instance across every concurrent
  run, so a module-level `let`, counter, or cache is shared between runs on
  different workers. Per-run state belongs inside `main()`.
```

- [ ] **Step 4: Update `docs/mcp-interface.md`**

In the tool catalog, update `inspect-members` to take `workers?: number[]` and describe the busy/heldSince report. Add a "Queueing" note under "Execution model":

```markdown
A tool call that finds every worker busy waits in a FIFO queue, sending a
progress heartbeat immediately and then every 30 seconds with its position.
After `WORKER_POOL_ACQUIRE_TIMEOUT_MS` (default 5 minutes) it fails with
"all N workers busy, try again" rather than being killed by a transport timeout.
Heartbeats only fire when the client sent a progress token.
```

- [ ] **Step 5: Update `README.md`**

Replace `DEMO-DOER`/`DEMO-REVIEWER` mentions with the worker naming, add the three `WORKER_POOL_*` variables to the environment table, and update the troubleshooting table with:

| Symptom | Cause |
|---|---|
| `These worker members are not registered: …` | `WORKER_POOL_SIZE` changed without re-provisioning. Run `scripts/provision-members.sh`. |
| `all N workers busy, try again` | Pool saturated for longer than `WORKER_POOL_ACQUIRE_TIMEOUT_MS`. Raise `WORKER_POOL_SIZE` or retry. |

- [ ] **Step 6: Verify the whole suite and grep for stale references**

Run: `npm test`
Expected: PASS

Run: `grep -rn "DEMO-DOER\|DEMO-REVIEWER\|BOILERPLATE-" --exclude-dir=node_modules --exclude-dir=.git .`
Expected: matches only inside `docs/specs/` (the spec's own history sections)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "docs: cut over to the worker pool convention"
```

---

### Task 12: Live tests

Both existing live tests break under this change: `demo.live.test.mjs` calls
`runDemo()` with no pool (it will now build one and demand a registered roster),
and `mcp.live.test.mjs` asserts the old `report.members` shape. They need a real
Fleet server with provisioned workers and are not part of `npm test`.

**Files:**
- Modify: `tests/demo.live.test.mjs:19-30`
- Modify: `tests/mcp.live.test.mjs:24-32`
- Create: `tests/pool.live.test.mjs`

**Interfaces:**
- Consumes: `WorkerPool` from Task 6; the updated launchers from Tasks 7-8.
- Produces: nothing importable.

**Deviation from the spec, deliberate:** the spec's testing section calls for
"two concurrent `demo` runs asserting they land on different workers". That
spends agent tokens twice on every run. The concurrency test below acquires two
leases directly instead — same pool code path, same real locks, no tokens. The
single `demo` live test still proves the end-to-end pooled run.

- [ ] **Step 1: Update the demo live test**

```js
// tests/demo.live.test.mjs — replace the test block at lines 19-30
test(
  'live runDemo runs python command and agent on a pooled worker',
  { timeout: 180_000 },
  async () => {
    const result = await runDemo();

    assert.equal(typeof result, 'object', 'runDemo() should return the dummy phase results');
    assert.match(asText(result.command), /hello-from-python/);
    assert.deepEqual(result.transform, { ok: true, source: 'transform' });
    assert.match(asText(result.agent), /\bpong\b/i);
  },
);
```

- [ ] **Step 2: Update the MCP live test**

```js
// tests/mcp.live.test.mjs — replace the assertions at lines 24-32
    const report = JSON.parse(result.content[0].text);
    assert.ok(report.poolSize >= 1, 'the pool should have at least one worker');
    assert.equal(report.workers.length, report.poolSize);
    for (const worker of report.workers) {
      assert.equal(worker.doer.name, `WORKER-${worker.id}-DOER`);
      assert.equal(worker.reviewer.name, `WORKER-${worker.id}-REVIEWER`);
      assert.equal(worker.doer.exists, true, `worker-${worker.id} doer folder should exist`);
      assert.equal(worker.reviewer.exists, true, `worker-${worker.id} reviewer folder should exist`);
      assert.equal(typeof worker.busy, 'boolean');
    }
```

- [ ] **Step 3: Write the live pool test**

```js
// tests/pool.live.test.mjs
import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { WorkerPool } = await import('../pool/worker-pool.mjs');

// Real Fleet server, real members, real lock files. Spends no LLM tokens: this
// exercises roster verification and lease handout, not agent().
// Needs `apra-fleet start` and provisioned workers.
async function connect() {
  process.env.APRA_FLEET_TRANSPORT ??= 'http';
  const { ensureApralabs } = await import('../workflows/demo/ensure-apralabs.mjs');
  ensureApralabs();
  const { connectFleet } = await import('@apralabs/apra-fleet-client/server-resolution');
  return await connectFleet({ env: process.env });
}

test('a live pool verifies its roster and hands out distinct workers', { timeout: 60000 }, async () => {
  const { fleetApi, transport } = await connect();
  const pool = await WorkerPool.create({ fleetApi });
  try {
    assert.ok(pool.size >= 1);

    const first = await pool.acquire();
    try {
      assert.equal(first.doer.name, `WORKER-${first.workerId}-DOER`);

      if (pool.size >= 2) {
        const second = await pool.acquire();
        try {
          assert.notEqual(second.workerId, first.workerId, 'two leases must not share a worker');
        } finally {
          await second.release();
        }
      }
    } finally {
      await first.release();
    }

    // The worker comes back: a second acquire after release must succeed.
    const reused = await pool.acquire();
    await reused.release();
  } finally {
    await pool.close();
    transport?.stop?.();
  }
});

test('a live pool rejects a roster larger than what is provisioned', { timeout: 60000 }, async () => {
  const { fleetApi, transport } = await connect();
  try {
    await assert.rejects(
      () => WorkerPool.create({ fleetApi, config: { size: 99, root: process.cwd() + '/workdir', acquireTimeoutMs: 1000 } }),
      /not registered/,
    );
  } finally {
    transport?.stop?.();
  }
});
```

- [ ] **Step 4: Run the live tests against a running Fleet**

Run: `node --test tests/pool.live.test.mjs tests/mcp.live.test.mjs`
Expected: PASS. If it fails with "These worker members are not registered", run `scripts/provision-members.sh` first.

Run: `node --test tests/demo.live.test.mjs`
Expected: PASS — spends tokens for one `pong`.

- [ ] **Step 5: Commit**

```bash
git add tests/demo.live.test.mjs tests/mcp.live.test.mjs tests/pool.live.test.mjs
git commit -m "test: cover the worker pool against a live Fleet"
```

---

## Verification checklist

Run after Task 12.

- [ ] `npm test` passes.
- [ ] `grep -rn "fleetStatus" workflows/ pool/ mcp/` shows no presence checks — only the demo's status log.
- [ ] `grep -rn "from '\.\./mcp" pool/ workflows/` returns nothing (dependency direction intact).
- [ ] Two terminals, both `WORKER_POOL_ROOT` pointing at the same directory: `node -e "..."` holding a lease in one blocks the other, and frees it on exit.
- [ ] With a live Fleet: `npm run mcp`, then two concurrent `demo` tool calls land on different workers (`inspect-members` shows both busy).
