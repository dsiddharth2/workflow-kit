# Stdio transport for Fleet communication

Status: implemented (kit launchers and `transport/stdio-fleet.mjs`). Failure-mode
rows that the implementation plan did not require — throwing on a missing binary
with a custom message, requiring `CLAUDE_CODE_OAUTH_TOKEN` before spawn, a
configurable connect timeout, and wrapping unexpected child-exit as a custom
error — are not implemented; spawn/connect/callTool errors from the MCP SDK
propagate instead. OAuth is optional at spawn (plan); a missing token does not
block `spawnFleet()`.

## Problem

The workflow-kit connects to Fleet over MCP/HTTP, which requires a long-running
Fleet server started with `apra-fleet start`. This creates three problems:

1. **Server dependency.** Every caller — the MCP server, a direct CLI run, the
   scheduled runner — must have a running Fleet server. If it's down, nothing
   works, and the error ("Fleet server is not running") is the single most
   common failure mode.
2. **Deployment complexity.** Docker needs to start the server, wait for it,
   provision members against it, and keep it alive. The provisioning script
   (`provision-members.sh`) is tightly coupled to the server lifecycle.
3. **No crash isolation.** All members share one Fleet server process. A bug or
   resource leak in one member's session can affect every concurrent run.

## Requirements

1. **No server prerequisite.** A workflow run spawns its own Fleet process on
   demand and tears it down when done. `apra-fleet start` is not required.
2. **Same `fleetApi` interface.** Workflow bodies (`demo.js`), the MCP server
   layer (`mcp/server.mjs`), and tests see the exact same API. The transport is
   invisible above the new module.
3. **Per-worker isolation.** Each spawned Fleet process is independent. A crash
   in one does not affect others.
4. **Ephemeral processes.** Spawn on demand, kill on teardown. No warm process
   pool, no idle management.
5. **Registration at spawn time.** Members are registered and OAuth tokens
   attached as part of the spawn sequence, not as a separate provisioning step.
6. **Demo workflow runs end to end over stdio with passing tests.**

## Chosen approach

Spawn `apra-fleet run --transport stdio` as a child process and connect via the
MCP SDK's `StdioClientTransport`. Build a `fleetApi`-compatible wrapper that
translates method calls into MCP `tools/call` requests over that client.

Chosen over raw child_process JSON (reimplements MCP parsing) and CLI wrapper
(loses structured responses, brittle output parsing).

## Architecture

```
workflow body (demo.js)
  │
  │  uses fleetApi.executeCommand(), .executePrompt(), etc.
  │  (same interface as today)
  │
  ▼
transport/stdio-fleet.mjs
  │
  │  spawnFleet() → { fleetApi, stop() }
  │    1. spawn('apra-fleet', ['run', '--transport', 'stdio'])
  │    2. MCP Client over StdioClientTransport
  │    3. registerMember via tools/call
  │    4. attach OAuth via tools/call
  │    5. return fleetApi wrapper
  │
  ▼
apra-fleet child process (stdio)
  │
  │  MCP JSON-RPC over stdin/stdout
  │
  ▼
Claude Code CLI session (per member)
```

### New module

| Module | Responsibility |
|---|---|
| `transport/stdio-fleet.mjs` | Spawn Fleet, connect MCP client, register members, wrap as `fleetApi`, provide `stop()` |

### Modified files

| File | Change |
|---|---|
| `workflows/demo/main.mjs` | Replace `connectFleet()` with `spawnFleet()`. Remove `APRA_FLEET_TRANSPORT` forcing. |
| `workflows/demo/demo.js` | Delete `ensureMember`, `memberPresent`, `memberListedInStatus`, and the registration phase. Delete `DOER_WORK`/`REVIEWER_WORK` constants. |
| `mcp/main.mjs` | Same swap: `connectFleet()` → `spawnFleet()`. Remove `APRA_FLEET_TRANSPORT` logic. |
| `package.json` | Add `@modelcontextprotocol/sdk` dependency. |

### Unchanged files

| File | Why |
|---|---|
| `mcp/server.mjs` | Receives `fleetApi` via injection; transport-agnostic. |
| `mcp/http.mjs` | Upstream MCP server; unrelated to downstream transport. |
| `mcp/registry.mjs` | Calls `runDemo`/`runInspectMembers` with `fleetApi`; transport invisible. |
| `workflows/demo/ensure-apralabs.mjs` | `@apralabs/apra-fleet-workflow` packages still resolve through the symlink. |
| `workflows/inspect-members/` | Receives `fleetApi` via injection. |

## Design decisions

### 1. The `fleetApi` wrapper translates methods to MCP tool calls

```
fleetApi.executeCommand(opts)  → client.callTool('execute_command', opts)
fleetApi.executePrompt(opts)   → client.callTool('execute_prompt', opts)
fleetApi.listMembers(opts)     → client.callTool('list_members', opts)
fleetApi.registerMember(opts)  → client.callTool('register_member', opts)
fleetApi.fleetStatus()         → client.callTool('fleet_status', {})
```

The wrapper normalizes the MCP SDK's response shape back into the
`{ content: [{ type: 'text', text }] }` envelope the rest of the codebase
expects. This is the seam — everything above it is transport-agnostic.

Tool names are the snake_case MCP convention. If Fleet's tool names differ, the
mapping is maintained in one place inside the wrapper.

### 2. Spawn sequence

```
spawnFleet({ memberName, workFolder, oauthToken }):
  1. spawn('apra-fleet', ['run', '--transport', 'stdio'], { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: oauthToken } })
  2. new Client({ name: 'workflow-kit', version: '1.0.0' })
  3. client.connect(new StdioClientTransport({ command: <child> }))
  4. client.callTool('register_member', { friendly_name: memberName, work_folder: workFolder, member_type: 'local' })
  5. attach OAuth token via the appropriate auth tool call
  6. return { fleetApi: wrapper, stop() }
```

The `StdioClientTransport` from `@modelcontextprotocol/sdk` can either spawn
the child process itself (given `{ command, args, env }`) or connect to an
existing one. The simpler path is to let it spawn: pass `{ command: 'apra-fleet',
args: ['run', '--transport', 'stdio'], env }` and let the transport own the
child lifecycle. If more control is needed (e.g. custom stderr handling), spawn
manually and pass the child's stdin/stdout streams. The implementation will
determine which fits; both produce the same MCP client. stderr from the child
process is piped to the parent's stderr for diagnostics.

### 3. Registration moves from workflow body to spawn time

Today `demo.js` calls `ensureMember()` in its first phase. With stdio, the
spawned Fleet process starts empty — registration must happen before any
workflow phase runs. `spawnFleet()` owns this: it registers the member(s) and
attaches OAuth as part of its startup sequence, then hands back a ready-to-use
`fleetApi`.

This simplifies `demo.js`: the registration phase, the `memberPresent` check
(which was broken — it used `fleetStatus()` instead of `listMembers()`), and
the work-folder constants all go away.

### 4. OAuth is passed via environment variable

The spawned child process inherits `CLAUDE_CODE_OAUTH_TOKEN` from the parent
environment. After member registration, `spawnFleet()` calls the Fleet auth
tool to attach the token to the member. This mirrors what
`provision-members.sh` does with `apra-fleet auth --oauth --member NAME "$TOKEN"`.

The token flows: parent env → child env → Fleet auth tool → credential store
on that member.

### 5. Teardown is stop() in a finally

`stop()` closes the MCP client connection, then kills the child process
(SIGTERM, with a fallback to SIGKILL after a timeout). It is idempotent — safe
to call after the child has already exited. Launchers call it from a `finally`
block, identical to how `transport?.stop()` is called today.

### 6. Unexpected child exit is a thrown error

If the child process dies while a `callTool` is in flight, the MCP client's
pending promise rejects. The wrapper catches this and throws:
`"Fleet stdio process exited unexpectedly (code N, signal S)"`.

A dead child is not restarted. The run fails, the `finally` block calls
`stop()` (which is a no-op on an already-dead process), and the error
propagates to the caller.

### 7. Tool name discovery is optional

On connect, the wrapper may call `tools/list` to verify Fleet exposes the
expected tools. This is a startup sanity check, not load-bearing. If Fleet's
tool names change, the error surfaces on first `callTool` anyway.

## Launcher flow after the change

```
runDemo({ fleetApi, signal, reportPhase }):
  1. If fleetApi injected → use it (tests, mock)
  2. Else → spawnFleet({ memberName: 'DEMO-DOER', workFolder, oauthToken })
  3. ensureApralabs()
  4. new FleetWorkflow(api) → new WorkflowEngine(workflow)
  5. engine.executeFile('demo.js', { fleetApi: api, signal, reportPhase })
  6. finally → stop()
```

The `APRA_FLEET_TRANSPORT` env var forcing and the `connectFleet()` import are
gone. The "is the Fleet server running?" error path is gone — you own the
process.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | (required) | OAuth token passed to spawned Fleet processes |
| `APRA_FLEET_BIN` | `apra-fleet` (on PATH) | Path to the Fleet binary, for environments where it's not on PATH |

`APRA_FLEET_TRANSPORT` is no longer used by this kit.

## Failure modes

| Situation | Behavior |
|---|---|
| `apra-fleet` not on PATH | `spawnFleet` throws `"apra-fleet binary not found"` at spawn time |
| `CLAUDE_CODE_OAUTH_TOKEN` not set | `spawnFleet` throws `"CLAUDE_CODE_OAUTH_TOKEN required"` before spawning |
| Child process fails to start | `spawnFleet` rejects with the spawn error |
| MCP client connect times out | `spawnFleet` rejects after a configurable timeout |
| Registration fails | `spawnFleet` kills the child and rejects with the registration error |
| Child dies mid-run | Pending `callTool` rejects; run fails; `finally` calls `stop()` |
| `stop()` called twice | Idempotent; second call is a no-op |

## Testing

**Mock tier** (no Fleet binary):

- Verify `spawnFleet` calls `spawn` with correct args
- Mock the MCP `Client` — verify tool call translation and response normalization
- Verify `stop()` kills child and closes client
- Verify error handling on unexpected child exit
- Existing `tests/demo.test.mjs` unchanged — injects `fleetApi` directly

**Integration tier** (`*.live.test.mjs`, needs `apra-fleet` binary):

- Spawn real Fleet over stdio, register a member, call `fleetStatus`
- Run full demo workflow end to end over stdio
- Gated on binary availability — skips with a message if not installed

## Dependencies

One new runtime dependency: `@modelcontextprotocol/sdk` (for `Client` and
`StdioClientTransport`). The project already depends on `@modelcontextprotocol/server`
for the upstream MCP server; the SDK is the client-side counterpart.

## Non-goals

- No warm process pool or idle management. Processes are ephemeral.
- No changes to the upstream MCP server (how Claude Code talks to this kit).
- No cross-process worker coordination (that's the concurrency branch's concern).
- No Windows service or daemon management.
- No reconnection or restart of a failed Fleet process.

## Relationship to the concurrency branch

This spec targets `main`, which has no pool/lock infrastructure. The
concurrency branch (`feat/conc-implementation`) can later adopt stdio by
changing how `WorkerPool` provisions each worker — `spawnFleet()` per worker
pair instead of `connectFleet()` to a shared server. That integration is out
of scope here.
