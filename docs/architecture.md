# Architecture

How this repo is put together and why. Read this before changing code. If you just want
to get something running, start with the [README](../README.md); if you are about to add
a workflow or a test, continue to the [development guide](development.md).

## What this repo is

A starter for driving [Apra Fleet](https://github.com/Apra-Labs/apra-fleet) **from your
own Node process**. You clone it, keep the shape, and replace the dummy body with real
work.

It is deliberately **not** a Fleet CLI workflow. Nothing here is meant to be registered
with `apra-fleet workflow …`. The entry point is an ordinary exported async function:

```js
import { runDemo } from './workflows/demo/main.mjs';

await runDemo();               // live — spawns Fleet over stdio
await runDemo({ fleetApi });   // tests — inject a mock client
```

That single design choice drives most of what follows: because the workflow is a plain
function taking an injectable client, it can be called from a web server, from a test,
or from another workflow, and it can be tested without spawning Fleet or an API token.

## Fleet concepts you need first

If you have never used Fleet, these five terms explain almost everything in this repo.

**Fleet process.** Launchers spawn `apra-fleet run --transport stdio` as a child process
for the duration of a run, then tear it down. There is no `apra-fleet start` prerequisite.
The child owns the member registry and the credential store for that process, and it is
what actually spawns LLM CLIs. `APRA_FLEET_BIN` overrides the binary when it is not on
PATH.

**MCP.** The Model Context Protocol is used on both sides of this process. On top, this
repo is an MCP **server**: it exposes each entry in `mcp/registry.mjs` as a tool for
Claude Code. Underneath, it is an MCP **client** to the spawned Fleet process, whose
tools include `execute_command`, `execute_prompt`, `list_members`, `register_member`,
and `fleet_status`. Every Fleet operation ultimately becomes one MCP tool call, and each
result returns in MCP's envelope shape (`content[]` / `structuredContent`), which is why
text extraction is a shared helper rather than inline property access.

**Member.** A named agent workspace registered with Fleet: a name, a type (`local` or
`remote`), an LLM (`claude`), and a working folder on disk. Fleet runs commands and
prompts *as* a member, inside that member's folder. The demo launcher registers
`DEMO-DOER` at spawn time. `DEMO-REVIEWER` exists as a work folder for inspect-members
and Docker provisioning; the demo workflow itself no longer registers it.

**Work folder.** The directory a member operates in. Each member needs its **own**
folder — two local members sharing a `cwd` collide. Hence `workdir/DEMO-DOER/`
and `workdir/DEMO-REVIEWER/`, each holding only a `.gitkeep`. Fleet may drop a
`.claude/settings.local.json` into them at registration time; that is local machine
state and is gitignored.

**Credential store.** Where OAuth tokens live, attached to a specific member. The
spawned child inherits `CLAUDE_CODE_OAUTH_TOKEN` from the parent environment, and
`spawnFleet()` then calls Fleet's `provision_llm_auth` tool for that member. Exporting
the token in your shell is how a live `agent()` call is authenticated — the Claude
process is spawned by Fleet, not by your Node process. Nearly every "works
interactively, fails unattended" problem traces back to a missing token.

## The layers

```text
┌─────────────────────────────────────────────────────────────┐
│  Your Node process                                          │
│                                                             │
│   mcp/             POST /mcp — MCP server front door         │
│     │              one tool per registry entry               │
│     │ entry.run({ fleetApi, args, signal, reportPhase })     │
│     ▼                                                       │
│   workflows/       runDemo() — spawn + execute               │
│     │              inspect-members — read-only inspection    │
│     ▼                                                       │
│   transport/       spawnFleet() — StdioClientTransport       │
│                    fleetApi wrapper over tools/call          │
└─────┼───────────────────────────────────────────────────────┘
      │ MCP JSON-RPC over stdin/stdout
      ▼
┌─────────────────────────────────────────────────────────────┐
│  apra-fleet child     `run --transport stdio`               │
│                                                             │
│   DEMO-DOER              DEMO-REVIEWER (inspect / Docker)   │
│   workdir/DEMO-DOER/     workdir/DEMO-REVIEWER/             │
│   Claude Code + OAuth           registered if provisioned   │
└─────────────────────────────────────────────────────────────┘
```

The dependency arrow points one way only: `mcp/` imports from `workflows/`, and nothing
under `workflows/` imports from `mcp/`. The transport module is the downstream Fleet
client. The workflow layer stands alone; MCP is a stateless front door over it.

## Module map

### `transport/`

| File | Responsibility |
|---|---|
| `stdio-fleet.mjs` | Spawns Fleet over stdio, connects an MCP client, registers the member, attaches OAuth, and returns `{ fleetApi, stop() }`. |

`createFleetApi(client)` is the seam: it calls `client.listTools()`, verifies the five
required Fleet tools, and maps `executeCommand` / `executePrompt` / `listMembers` /
`registerMember` / `fleetStatus` onto `client.callTool()`. Workflow bodies and the MCP
server never see the transport. `spawnFleet()` is skipped entirely when a `fleetApi` is
injected (tests).

### `workflows/demo/`

| File | Responsibility |
|---|---|
| `main.mjs` | The launcher. Spawns Fleet when no `fleetApi` is injected, runs the engine, calls `stop()` in `finally`. Exports `runDemo()`; self-executes when run directly. |
| `demo.js` | The workflow body. Receives an engine `context` and does the actual work. Contains no connection or registration logic. |
| `dummy.py` | Stand-in for real Python work. Prints `hello-from-python`. |
| `ensure-apralabs.mjs` | Symlinks `node_modules/@apralabs` to the Fleet install so the packages resolve. |
| `workflow.json` | Metadata only. Not consumed by anything in this repo. |

The **launcher / body split** is the most important convention here. `main.mjs` owns
everything environmental — `spawnFleet()`, cleanup in a `finally` — while `demo.js` only
knows how to do the work, given a context. Keep that separation when you add workflows:
it is what makes the body testable and the launcher reusable.

`demo.js` runs four phases, each demonstrating a primitive you would reuse:

1. **status** — `fleetStatus()`, logging whatever the spawned Fleet reports.
2. **command** — `python3 dummy.py` on `DEMO-DOER`. Costs no LLM tokens.
3. **transform** — a pure local JS step, no Fleet involvement at all.
4. **agent** — `Reply with exactly: pong` on the doer. This is the step that spends
   tokens and needs `CLAUDE_CODE_OAUTH_TOKEN` to reach the child.

Member registration is owned by `spawnFleet()`, not by the workflow body. The demo
launcher passes `memberName: 'DEMO-DOER'` and the matching work folder; the child
registers that member and, when a token is present, calls `provision_llm_auth`.

`command()` passes `failSoft: true`, so a machine without `python3` still completes the
run. A throwing `transform()` or `agent()` does fail the run, and the process exits 1.

### `mcp/`

| File | Responsibility |
|---|---|
| `main.mjs` | Server launcher. Spawns Fleet when no `fleetApi` is injected, listens on loopback, and wires SIGINT/SIGTERM shutdown. |
| `server.mjs` | Builds the MCP server and registers one tool for each registry entry. Converts returned values to tool results and emits progress when requested. |
| `http.mjs` | Creates the Express app. Provides `GET /health` and a stateless `POST /mcp` with a fresh MCP server and transport per request. |
| `registry.mjs` | The tool catalog and workflow adapters: `{ name, description, inputSchema?, annotations?, run }`. |
| `auth.mjs` | Pass-through auth stub. Replace by injection, not by editing. |
| `fleet-text.mjs` | Pulls plain text out of Fleet MCP tool results. |

Full interface reference lives in [mcp-interface.md](mcp-interface.md).

## Data flow

### A workflow run

```text
runDemo()
  ├─ ensureApralabs()                       symlink @apralabs packages
  ├─ spawnFleet({ memberName, workFolder }) → { fleetApi, stop }   (skipped if injected)
  │    ├─ StdioClientTransport: apra-fleet run --transport stdio
  │    ├─ createFleetApi(client)            listTools + method map
  │    ├─ registerMember(DEMO-DOER)
  │    └─ provision_llm_auth (when token present)
  ├─ new WorkflowEngine(new FleetWorkflow(api))
  ├─ engine.executeFile('demo.js', { fleetApi })
  │    status → command → transform → agent
  └─ finally: await stop?.()
```

The `finally` matters. Without stopping the transport the child process keeps the event
loop alive and the process prints its result but never returns to the shell.

### An MCP tool call

```text
Claude Code chooses a tool from tools/list
  └─ POST /mcp tools/call
       ├─ authenticate
       ├─ create a fresh MCP server + HTTP transport
       ├─ validate args with the entry's inputSchema, when present
       ├─ entry.run({ fleetApi, args, signal, reportPhase })
       │    ├─ phase()/log() output             → server terminal
       │    └─ reportPhase(), if progressToken  → heartbeat to Claude
       ├─ return one final MCP tool result      → Claude
       └─ close the per-request MCP server
```

Each tool call has one request and one final response. Progress notifications are
heartbeats only: workflow terminal output is not streamed into the model's context.
The MCP layer keeps no session state between calls. The downstream Fleet child is
spawned once when the MCP server starts, and killed when the MCP server closes.

## Design decisions worth knowing

**Downstream Fleet is stdio, not HTTP.** Launchers call `spawnFleet()` from
`transport/stdio-fleet.mjs`. `APRA_FLEET_TRANSPORT` is not used. The wrapper discovers
Fleet's tool names via `listTools()` at connect time and maps camelCase `fleetApi`
methods onto those names. A missing required tool fails at spawn, not on first call.

**Registration happens at spawn time.** A freshly spawned Fleet process starts empty, so
`spawnFleet({ memberName, workFolder })` registers the member before any workflow phase
runs. `demo.js` does not call `registerMember`. Injected test clients therefore do not
need a `registerMember` method.

**OAuth is inherited, then attached.** The child environment copies the parent and sets
`CLAUDE_CODE_OAUTH_TOKEN` when a token is available (`oauthToken` argument or the parent
env). After registration, `provision_llm_auth` copies that session onto the member.
A missing token does not block spawn; `agent()` will fail later if Fleet has nothing to
authenticate with. `provision_llm_auth` failures are warnings, not hard errors.

**`@apralabs` packages resolve through a symlink.** The root `package.json` deliberately
does not depend on any `@apralabs/*` package; Fleet is a machine install, not a project
dependency. `ensureApralabs()` links `node_modules/@apralabs` to whichever location
actually contains the packages: first `~/.apra-fleet/node_modules/@apralabs`, then the
npm global prefix (where `npm install -g @apralabs/apra-fleet` lands). It verifies the
link target with `realpathSync` and relinks when stale, which is what fixes the
`Cannot find package 'undici'` symptom. It uses `'junction'` so Windows does not require
admin rights; POSIX ignores the argument.

**`fleetApi` is injected, never imported.** Both launchers accept a client and only
spawn when one isn't supplied. This is what makes the mock tests possible — they run
with no Fleet binary, no members, and no token.

**There is no internal router.** The model connected over MCP already sees the tool
names, descriptions, and schemas and decides which one to call. Adding another LLM
classification call inside this process would duplicate that routing, add latency, and
spend tokens unnecessarily. Tool descriptions are therefore part of the interface.

**Slow workflows use heartbeat plus client configuration.** The SDK does not implement
MCP Tasks, so long-running calls remain one request/response. When the client supplies a
progress token, phase reports provide a heartbeat; a sufficiently large `timeout` in
the client's `.mcp.json` is the reliable control for slow calls.

**Auth is replaced by injection.** `createMcpHttpApp({ authenticate })` takes
middleware. Routes depend only on `req.user`, so real auth drops in without editing
`auth.mjs`.

**Teardown is idempotent `stop()`.** `stop()` closes the MCP client, then the stdio
transport. It is safe to call twice. Unexpected child exit rejects the in-flight
`callTool`; the process is not restarted.

## Where state lives

| State | Location | Lifetime |
|---|---|---|
| Member registry | Fleet data dir (`~/.apra-fleet/data` by default) | Shared across stdio children on the same machine; a new child sees members already registered there. |
| OAuth tokens | Fleet credential store, per member | Until the token expires. Also passed into the child via `CLAUDE_CODE_OAUTH_TOKEN`. |
| Member scratch space | `workdir/<MEMBER>/` | On disk; `.claude/` inside is gitignored local state. |

The MCP layer holds no state: every HTTP request gets a fresh MCP server and transport.
The downstream Fleet child lives for the MCP server process, not per HTTP request.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | (none) | OAuth token passed into spawned Fleet processes and used by `provision_llm_auth`. |
| `APRA_FLEET_BIN` | `apra-fleet` on PATH | Path to the Fleet binary when it is not on PATH. |
| `PORT` | `3000` | MCP server listen port. |
| `MCP_BIND_HOST` | `127.0.0.1` | MCP server bind address. Compose sets `0.0.0.0`. |

## Extension points

| You want to | Do this |
|---|---|
| Real Python work | Replace `dummy.py`, keep the `command()` call |
| Real LLM work | Change the `agent()` prompt, keep `member_name` |
| A second agent | Dispatch `agent({ member_name: 'DEMO-REVIEWER' })`; register and auth it at spawn (or via `provision-members.sh` against the shared data dir) |
| Your own member names | Pass them to `spawnFleet()`, create matching `workdir/` folders, and update `scripts/provision-members.sh` |
| A new MCP tool | Append its entry to `mcp/registry.mjs` — no server or HTTP changes |
| Real authentication | Pass middleware to `createMcpHttpApp({ authenticate })` |

Two things to avoid: do not pass OAuth tokens into `agent()` payloads (they belong in
Fleet's credential store / the child env), and do not clone `apra-fleet` into this repo
— the symlink resolution exists precisely so you don't have to.

The stdio design is specified in [specs/stdio-transport-spec.md](specs/stdio-transport-spec.md).
