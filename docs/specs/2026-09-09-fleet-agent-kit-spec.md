# Fleet Agent Kit

Status: proposed — foundation shipped, phases pending.

## What is already shipped

The workflow-kit already implements the mandatory foundation that this spec builds on:

### Transport and MCP

- Stdio transport — `apra-fleet run --transport stdio` as a child process, no server prerequisite
- MCP server — stateless HTTP, one tool per registry entry, Zod schemas, progress heartbeats
- 6 MCP tools: `demo`, `inspect-members`, `city-briefing`, `weather`, `timezone`, `textstats`

### Worker dispatch (covers parts of Phase 4 and Phase 5)

- Pre-provisioned worker pool — N doer/reviewer pairs with cross-process file locks
- Ephemeral worker factory — on-demand pairs in `os.tmpdir()`, self-destruct on release
- Tiered dispatcher — pool → ephemeral → queue → reject, shared FIFO wait queue
- MemberManager — Node-side registration, OAuth provisioning, teardown
- PooledFleetApi — remaps `'doer'`/`'reviewer'` keywords to lease member names

### Workflows and tools

- demo — status, python command, local transform, agent smoke test
- inspect-members — read-only worker pair inspection
- city-briefing — multi-tool: weather API, timezone API, text stats, agent briefing
- Python tool scripts: `tools/weather/`, `tools/timezone/`, `tools/textstats/` (stdlib only)
- Launcher/body split convention with `withStandaloneLease()` for CLI runs

### Infrastructure

- Docker image, compose file, entrypoint with dep install and `@apralabs` symlinks
- GitHub Actions CI — unit tests, integration tests (Docker), load tests with PR reporting
- Full mock test suite, live test suite, load test harness

### Near-term improvements (before Phase 1)

- Mock test for city-briefing workflow
- Deprecation notice on `scripts/provision-members.sh`
- Additional Python tool scripts

---

## Problem

The workflow-kit runs workflows on Apra Fleet through an MCP server and stdio
transport. A developer who wants to build an autonomous agent — one that takes
a task and gets it over the finish line — must wire up a run loop, memory
management, budget enforcement, guardrails, and evaluation harness from scratch
every time. There is no standardised way to do this on Fleet, and there is no
reusable kit that gives a developer the agent anatomy pre-wired so they can
focus on the work the agent does, not on the infrastructure around it.

A second problem: the kit's runtime layer (Express, job queue, transport) is
currently hardwired. Deploying the same agent to an Azure Function App, a
Docker container, or a bare Node process requires forking the codebase.

## Goal

Evolve the workflow-kit into a **Fleet Agent Kit**: a modular, configurable
toolkit for building agents on Apra Fleet. A developer clones the kit, enables
the modules they need, writes their tools and (optionally) their planning
strategy, and ships an agent.

The kit must support a spectrum of deployment shapes:

- **Minimal — tool server.** Tools registry + communication layer + Fleet
  transport. No planning, no orchestration. An external caller (Claude Code,
  another agent, a human-in-the-loop UI) does the reasoning and calls tools
  directly.
- **Full agent.** All modules enabled. The agent receives a task, plans,
  executes, observes, replans, and returns a result autonomously.
- **Custom.** Any combination — tools + guardrails but no planner, tools +
  budgets but no memory, etc.

One Docker container runs one agent instance. That agent handles tasks as they
arrive (it is a long-running service, not a disposable function). Scaling is
horizontal: more containers, each with its own agent. The kit never manages
multiple agents inside one process.

## Principles

1. **Modular by default.** Every component above the mandatory core is a module
   that can be enabled, disabled, or replaced via configuration.
2. **No framework lock-in.** The communication layer is an interface. Express is
   one adapter; Azure Functions, Fastify, or a raw Node `http.Server` are
   others. Swapping the adapter never touches agent code.
3. **Fleet is the execution layer.** The agent talks to Fleet for LLM calls and
   commands. Fleet handles provider differences (Claude, OpenAI, future
   LangChain member types). The kit does not abstract over LLM providers
   directly.
4. **Agents are services.** One container = one agent. The agent stays running
   and processes tasks through its communication layer. It is not a one-shot
   script.
5. **Errors are values.** Tool failures return structured error objects. They do
   not throw. The run loop decides what to do with them. Cancellation via
   `signal` (AbortSignal) is the one exception — it aborts the current
   operation and the run loop catches it to stop cleanly.

---

## Architecture

### Mandatory core

Three modules that are always present. Without any one of them the kit cannot
function.

#### 1. Tools registry

The canonical catalog of everything the agent can do. Each tool has a typed
input schema, a model-facing description, and a `run` function. The existing
`mcp/registry.mjs` contract is the starting point:

```js
{
  name: 'find-mismatched-invoices',
  description: 'Scan the AP ledger and return invoice lines that do not match their PO.',
  inputSchema: z.object({
    period: z.string().describe('YYYY-MM date range'),
    threshold: z.number().optional().describe('Tolerance in dollars'),
  }),
  annotations: { readOnlyHint: false },
  run: async ({ fleetApi, args, signal }) => { /* ... */ },
}
```

Extensions beyond the current contract:

| Field | Type | Purpose |
|---|---|---|
| `reversible` | `boolean` | Guardrails classify actions by this flag. |
| `timeout` | `number` | Per-tool wall-clock cap in ms. |
| `retryable` | `boolean` | Whether the run loop may retry on failure. |
| `tags` | `string[]` | Grouping for evals and reporting. |

Tools are the unit of capability. Existing workflows (`workflows/`) become
tools — each workflow launcher is wrapped as a tool entry. New capabilities
are added as tool entries. The registry is the single source of truth for what
the agent can do.

#### 2. Communication layer (comm)

An interface that accepts incoming requests and returns responses. The
interface is mandatory; the implementation is swappable.

**Interface contract:**

```js
// Every adapter must implement this shape.
{
  // Start listening for incoming requests.
  async start({ handler, port?, host? }),

  // Graceful shutdown.
  async stop(),
}
```

Where `handler` is:

```js
async function handler(request) → response
// request:  { method, path, headers, body, signal }
// response: { status, headers, body }
```

The core never imports Express, Fastify, or any HTTP framework directly. It
imports the comm interface and the configured adapter implements it.

**Shipped adapters:**

| Adapter | When to use |
|---|---|
| `comm/express.mjs` | Default. Local dev, Docker, any long-running process. |
| `comm/azure-functions.mjs` | Azure Function App deployment. |
| `comm/raw-http.mjs` | Minimal Node `http.createServer` with no framework. |

Adding an adapter means implementing `start()` and `stop()` against the
interface. Agent code, tool code, and all other modules are untouched.

The MCP server layer (`mcp/server.mjs`, `mcp/http.mjs`) sits between the comm
adapter and the tools registry. It translates MCP protocol messages into tool
calls. When the run loop is disabled, the MCP layer exposes tools directly and
an external caller does the reasoning.

#### 3. Fleet transport

Talks to Fleet members over stdio (existing `transport/stdio-fleet.mjs`). This
is the bridge to LLM execution: `executePrompt`, `executeCommand`,
`registerMember`, `listMembers`, `fleetStatus`. The `fleetApi` interface is
injectable — tests supply a mock, live runs supply the real stdio client.

No changes to the transport module are required. It continues to work exactly
as documented in `specs/stdio-transport-spec.md`.

---

### Optional modules

Each module below can be enabled or disabled independently via `agent.config.mjs`
(or its JSON equivalent). When disabled, the module's code is never loaded and
its behaviour is absent — not stubbed, not no-oped, simply not present.

#### 4. Run loop / planner

The orchestration brain. When enabled, the agent receives a task and
autonomously decides what to do, calls tools, observes results, and iterates
until done.

**Default strategy: plan-execute-replan.**

```
Task arrives
  │
  ▼
Plan: agent writes steps from the task description + available tools
  │
  ▼
Execute: run steps in order, calling tools
  │
  ├─ step succeeds → next step
  ├─ step fails, retryable → retry (up to tool's retry limit)
  └─ step fails, not retryable → Replan
  │
  ▼
Replan: agent revises the remaining steps from what happened
  │
  ▼
Continue until: done condition met OR budget exhausted
```

**Alternative strategy: open-ended.** No upfront plan. Each iteration the
agent decides the next action from the full observation history. Costs more
tokens, handles surprises better.

The strategy is a configuration choice, not a code change:

```js
// agent.config.mjs
export default {
  modules: {
    runLoop: {
      enabled: true,
      strategy: 'plan-execute',   // or 'open-ended'
      maxReplanAttempts: 3,
    },
  },
}
```

When the run loop is **disabled**, the agent is a tool server. The MCP layer
exposes tools directly. An external caller (Claude Code, another orchestrator)
sends `tools/call` requests and does its own planning.

The run loop calls Fleet through `fleetApi.executePrompt()` for LLM reasoning
steps. The prompt includes: the task, the current plan (if plan-execute), the
observation history (managed by the memory module if enabled, or a simple
array if not), and the available tools.

**Done condition.** A function the agent developer provides:

```js
runLoop: {
  isDone: (result, context) => result.status === 'matched',
}
```

If no `isDone` is provided, the run loop stops when the LLM returns a final
answer with no further tool calls. This is the fallback, not the recommended
default — an explicit done condition is always better.

#### 5. Memory

Three distinct kinds. Each is independently enableable.

**Working context** (`memory.workingContext`). What is in the LLM's context
window during a run. When enabled, the module compacts older turns
(summarises them via a lightweight Fleet `executePrompt` call on the same
member) to prevent long-run degradation. When disabled, the run loop passes
the raw observation history and the developer is responsible for context
length.

```js
memory: {
  workingContext: {
    enabled: true,
    maxTurns: 50,             // compact after this many turns
    compactionStrategy: 'summarise',  // or 'sliding-window'
  },
}
```

**Run state** (`memory.runState`). Checkpoint after each step so a crashed
process can resume. Stored as JSON in the agent's working directory. Each
checkpoint includes an idempotency key so replayed steps do not double-execute.
When disabled, a crash restarts the task from scratch.

```js
memory: {
  runState: {
    enabled: true,
    checkpointDir: './state',
  },
}
```

**Long-term memory** (`memory.longTerm`). Facts carried across separate runs.
Most task agents do not need this. When disabled (the default), each run
starts with a clean slate.

```js
memory: {
  longTerm: {
    enabled: false,           // default off
    backend: 'filesystem',    // or 'redis', 'sqlite' — later
  },
}
```

#### 6. Budgets and stop conditions

Caps that prevent a bad run from becoming an expensive one. When enabled,
the run loop checks these after every iteration. When disabled, the run loop
runs until its done condition or until the LLM stops calling tools.

```js
budgets: {
  enabled: true,
  maxIterations: 25,
  maxCostUsd: 5.00,           // estimated from token counts + model pricing
  maxTokens: 500_000,         // total input + output tokens
  timeoutMs: 600_000,         // 10 min wall clock
}
```

When a budget is exceeded, the run loop stops, logs which budget was hit, and
returns a partial result with `status: 'budget_exceeded'`. It does not throw.

Token and cost tracking hooks into Fleet's response metadata. Each
`executePrompt` call returns token counts; the budgets module accumulates them.

#### 7. Guardrails

Safety checks that classify and gate tool actions. When enabled, every tool
call passes through the guardrails module before execution.

```js
guardrails: {
  enabled: true,
  requireApproval: ['irreversible'],   // human gate for irreversible tools
  dryRunMode: false,                   // log what would happen, don't execute
  sandboxFs: true,                     // scope filesystem ops to workdir
  validateInputs: true,               // enforce inputSchema before run()
  validateOutputs: false,             // validate tool return shape
}
```

**Reversibility classification.** Each tool declares `reversible: true|false`
in its registry entry. When `requireApproval` includes `'irreversible'`, the
guardrails module calls a configurable approval callback before executing
irreversible tools. In unattended mode, the callback can auto-deny or
auto-approve based on policy.

**Filesystem sandbox.** When `sandboxFs` is true, tools that touch the
filesystem are scoped to the agent's working directory. Paths outside it are
rejected. This relies on Fleet's member workdir isolation — each member
already operates in its own folder.

**Dry-run mode.** When enabled, tools are not executed. Instead, the module
logs what would have been called with what arguments. Useful for testing agent
behaviour without side effects.

#### 8. Eval harness

A test runner that calls the agent and grades output. When enabled, provides
`npm run eval` which runs the agent against a task suite and produces a
report.

**Task suite format:**

```json
[
  {
    "id": "inv-001",
    "description": "Find the mismatched invoice in the test ledger",
    "inputs": { "period": "2026-01", "threshold": 0.01 },
    "expected": { "status": "matched", "count": 3 },
    "grader": "exact-match",
    "tags": ["invoices", "happy-path"]
  }
]
```

**Shipped graders:**

| Grader | Behaviour |
|---|---|
| `exact-match` | Deep-equal on `expected` vs actual output. |
| `contains` | Checks that actual output contains expected substrings. |
| `llm-judge` | Sends expected + actual to an LLM and asks "does this pass?" |
| `custom` | Calls a user-provided `(expected, actual) → { pass, reason }`. |

**Report output:**

```
fleet-agent-kit eval — 2026-09-09T14:30:00Z
  ✓ inv-001  Find the mismatched invoice       exact-match   1.2s   $0.03
  ✗ inv-002  Handle missing ledger file        exact-match   0.8s   $0.01
    Expected: { error: "ledger_not_found" }
    Actual:   { error: "file_not_found" }

22/25 passed · 3 failed · $0.52 total · 34s wall
```

The eval harness calls the agent through the same `handler(request)` interface
that the comm layer uses. It does not reach into internals. The agent under
test is unchanged.

**Example suite.** The kit ships with a suite of 20–30 tasks for the demo
agent covering: status checks, command execution, transform steps, agent
prompts, error handling, budget exhaustion, and guardrail triggers. This
suite serves as both documentation and a regression gate.

```js
evals: {
  enabled: true,
  suiteDir: './evals/suites',
  reportDir: './evals/reports',
  parallel: false,              // run tasks sequentially by default
}
```

#### 9. Dispatch / job queue

Intake and queuing for tasks. When enabled, tasks are queued and processed in
order rather than handled synchronously on the request path.

**In-process queue (v1).** A FIFO queue inside the Node process. Tasks are
enqueued on arrival, dequeued by the agent's run loop. Provides:

- Enqueue with backpressure (queue cap → 429 "busy, retry later")
- Dequeue with ack/nack (failed tasks re-enter the queue)
- Lease timeout (unacked tasks are reclaimed)
- Per-task status: `queued → processing → completed | failed`
- `GET /jobs/:id` to check status and retrieve results

```js
dispatch: {
  enabled: true,
  backend: 'in-process',
  maxQueueSize: 100,
  leaseTimeoutMs: 600_000,
}
```

When dispatch is disabled, tool calls and task submissions are handled
synchronously — the request blocks until the work is done and the response
is returned inline.

**Redis Streams (future).** A drop-in backend replacement. Same interface,
backed by Redis consumer groups. Enables multi-container dispatch where a
central Redis instance routes tasks to available agent containers. The
dispatch interface is designed so this swap requires a config change, not a
code change.

---

## Configuration

All module configuration lives in `agent.config.mjs` (or `agent.config.json`)
at the project root. The config is the single source of truth for what modules
are active. Use `.mjs` when the config contains functions (`isDone`,
approval callbacks); use `.json` for purely static configs. The loader tries
`.mjs` first, then `.json`.

**Full example:**

```js
// agent.config.mjs
export default {
  name: 'invoice-matcher',
  description: 'Finds mismatched invoices in AP ledgers',

  fleet: {
    memberName: 'INVOICE-DOER',
    workFolder: './workdir/INVOICE-DOER',
  },

  comm: {
    adapter: 'express',          // 'express' | 'azure-functions' | 'raw-http'
    port: 3000,
    host: '127.0.0.1',
  },

  modules: {
    runLoop: {
      enabled: true,
      strategy: 'plan-execute',
      maxReplanAttempts: 3,
      isDone: (result) => result.status === 'complete',
    },

    memory: {
      workingContext: { enabled: true, maxTurns: 50 },
      runState: { enabled: true, checkpointDir: './state' },
      longTerm: { enabled: false },
    },

    budgets: {
      enabled: true,
      maxIterations: 25,
      maxCostUsd: 5.00,
      timeoutMs: 600_000,
    },

    guardrails: {
      enabled: true,
      requireApproval: ['irreversible'],
      sandboxFs: true,
      validateInputs: true,
    },

    evals: {
      enabled: true,
      suiteDir: './evals/suites',
    },

    dispatch: {
      enabled: false,
    },
  },
}
```

**Minimal config (tool server only):**

```js
export default {
  name: 'card-sync-tools',
  fleet: { memberName: 'SYNC-DOER', workFolder: './workdir/SYNC-DOER' },
  comm: { adapter: 'express', port: 3000 },
  modules: {},    // everything optional is off
}
```

### Config validation

At startup, the kit validates the config against a schema. Missing mandatory
fields (name, fleet, comm) are hard errors. Unknown module names are warnings.
Contradictions (e.g., `budgets.enabled: true` but `runLoop.enabled: false`) are
warnings with explanations — budgets without a run loop are allowed (the caller
might enforce budgets externally) but the kit flags it.

---

## Module dependency rules

Some modules only make sense when others are enabled. The kit enforces these
as warnings, not errors, because an external caller may provide the missing
capability.

| Module | Depends on | Reason |
|---|---|---|
| Memory (working context) | Run loop | Without a run loop there is no turn history to compact. |
| Memory (run state) | Run loop | Without a run loop there is no step sequence to checkpoint. |
| Budgets | Run loop | Without a run loop there is no iteration to cap. |
| Guardrails | Tools registry | Always present — no dependency issue. |
| Evals | Tools registry | Tests call tools through the handler. No run loop required. |
| Dispatch | Comm layer | Intake arrives through the comm adapter. |

A module that depends on a disabled module logs a warning at startup:
`"budgets enabled but runLoop disabled — budget enforcement will not run;
disable budgets or enable runLoop"`.

---

## Directory structure

```
workflow-kit/
  agent.config.mjs              ← agent configuration (or .json)
  agent/                        ← core agent framework
    index.mjs                   ← createAgent() entry point
    config.mjs                  ← config loader + validator
    run-loop.mjs                ← plan → act → observe → replan
    memory/
      working-context.mjs       ← in-window compaction
      run-state.mjs             ← checkpoint / resume
      long-term.mjs             ← cross-run facts (Phase 3)
    tools/
      registry.mjs              ← tool catalog (extends mcp/registry.mjs)
      executor.mjs              ← call tool, validate, return error-as-value
    budgets.mjs                 ← iteration cap, cost ceiling, timeout
    guardrails.mjs              ← reversibility, approval, sandbox, validation
  comm/                         ← communication layer adapters
    interface.mjs               ← adapter contract definition
    express.mjs                 ← Express adapter (default)
    azure-functions.mjs         ← Azure Functions adapter
    raw-http.mjs                ← Node http.createServer adapter
  dispatch/                     ← job queue
    interface.mjs               ← queue contract
    in-process.mjs              ← in-memory FIFO (v1)
  evals/                        ← eval harness
    runner.mjs                  ← run(agent, suite) → report
    graders/
      exact-match.mjs
      contains.mjs
      llm-judge.mjs
      custom.mjs
    suites/                     ← task suite JSON files
      demo.json                 ← example suite for demo agent
    reports/                    ← generated reports (gitignored)
  transport/                    ← EXISTING — unchanged
    stdio-fleet.mjs
  workflows/                    ← EXISTING — become tool entries
    demo/
    inspect-members/
    city-briefing/
  mcp/                          ← EXISTING — evolves
    server.mjs                  ← now reads from agent/tools/registry.mjs
    http.mjs                    ← replaced by comm adapter in full mode
    registry.mjs                ← legacy; migrated into agent/tools/registry.mjs
    auth.mjs
    fleet-text.mjs
    main.mjs
  docs/
  workdir/
```

### Migration path from current code

The existing `mcp/registry.mjs` entries move into `agent/tools/registry.mjs`
with the extended fields (`reversible`, `timeout`, `retryable`, `tags`). The
existing `mcp/http.mjs` Express app becomes the `comm/express.mjs` adapter.
The existing `mcp/server.mjs` MCP protocol handler is unchanged — it reads
tools from the new registry location. The existing `mcp/main.mjs` launcher is
replaced by `agent/index.mjs` which loads config, initialises enabled modules,
and starts the comm adapter.

Existing workflows continue to work as tool entries. `runDemo()` becomes a
tool in the registry. No workflow code changes.

---

## Agent lifecycle

```
agent.config.mjs loaded and validated
  │
  ▼
Mandatory core initialised:
  Tools registry loaded
  Fleet transport spawned (fleetApi ready)
  Comm adapter created (not yet listening)
  │
  ▼
Optional modules initialised (in dependency order):
  Guardrails (wraps tool executor)
  Budgets (attaches to run loop hooks)
  Memory (working context, run state)
  Run loop (receives tools, memory, budgets, guardrails)
  Dispatch (wraps handler with queue)
  Evals (registered as npm script, not started at runtime)
  │
  ▼
Comm adapter starts listening
  │
  ▼
Tasks arrive → handler → dispatch (if enabled) → run loop (if enabled) → tools
  │
  ▼
Shutdown signal (SIGINT / SIGTERM)
  │
  ▼
Graceful shutdown:
  Comm adapter stops accepting new requests
  In-flight tasks finish (up to a drain timeout)
  Dispatch queue drains or persists remaining items
  Fleet transport stopped
  Process exits
```

---

## The Task shape

Every ingress door — MCP tool call, HTTP request, queue message, cron trigger
— produces the same `Task` object:

```js
{
  id: 'task-a1b2c3',               // generated or caller-supplied
  goal: 'Find mismatched invoices for January 2026',
  inputs: { period: '2026-01', threshold: 0.01 },
  constraints: {                    // optional caller-supplied overrides
    maxIterations: 10,
    timeoutMs: 120_000,
  },
  budget: {                         // optional caller-supplied caps
    maxCostUsd: 1.00,
  },
  outputChannel: 'mcp',            // where to send the result
  metadata: {                       // pass-through context
    callerSessionId: '...',
    priority: 'normal',
  },
}
```

Caller-supplied `constraints` and `budget` fields are merged with the agent's
configured defaults. The stricter value wins (lower cap, shorter timeout).

The agent never knows which door the task came from. The `outputChannel` tells
the comm layer where to route the result. If a new trigger type ever requires
changes to the agent's core logic, the boundary has leaked.

---

## Communication layer detail

### Ingress paths

| Door | How it produces a Task | Comm adapter role |
|---|---|---|
| **MCP** | `tools/call` request → extract tool name + args → wrap as Task | MCP server layer parses the protocol; adapter provides HTTP. |
| **Chat** | HTTP POST with a natural-language message → Task with `goal` set from the message | Adapter provides the HTTP endpoint; a thin translator wraps the body. |
| **Queue** | Dispatch module dequeues a message → already a Task (or transformed into one) | Not adapter-driven; the dispatch module owns this path. |
| **Schedule** | External cron (Azure Logic App, cron job) hits an HTTP endpoint → Task | Same as Chat — adapter provides the endpoint, body is the Task. |

### Adapter swap example

Switching from Express to Azure Functions:

```js
// agent.config.mjs — only this changes
comm: {
  adapter: 'azure-functions',
}
```

The Azure Functions adapter exports the same `{ start, stop }` interface.
`start()` registers the function triggers instead of calling `app.listen()`.
Every other module — tools, run loop, memory, guardrails — is identical.

---

## Concurrency model

One container runs one agent instance.

**Within one agent:**

- Tasks are processed one at a time by default (single-threaded Node).
- When dispatch is enabled, tasks queue and are processed sequentially.
- Future: a concurrency setting (`dispatch.concurrency: 3`) allows N tasks
  in flight simultaneously, each on its own Fleet member. This requires
  multiple members registered at spawn time. Each concurrent task gets its
  own workdir to prevent file collisions.

**Across containers:**

- Horizontal scaling: deploy N containers, each running the same agent.
- An external load balancer or Redis Streams dispatch routes tasks to
  available containers.
- Containers are stateless (run state is in the workdir or a shared store).
  Any container can pick up any task.

**Fleet constraints (unchanged):**

- One in-flight LLM prompt per member (server-enforced).
- Parallel across members, sequential within a member.
- The agent kit does not work around this — it respects it. Concurrency
  within one agent = number of registered members.

---

## Phased implementation

### Phase 1 — Mandatory core + config

**Ships:** Tools registry (extended schema), communication layer interface +
Express adapter, config loader/validator, agent entry point, migration of
existing registry and HTTP layer.

**Milestone:** `npm run start` boots the agent from `agent.config.mjs`. The
demo workflow runs as a tool through the new architecture. Existing MCP
clients see no difference. A minimal config (no optional modules) works.

**Does not ship:** Run loop, memory, budgets, guardrails, evals, dispatch.

### Phase 2 — Run loop + budgets + guardrails

**Ships:** Run loop (plan-execute and open-ended strategies), budgets module,
guardrails module. The demo agent can now receive a task and autonomously plan
+ execute using its tools.

**Milestone:** `createAgent('demo').tools([...]).build()` takes a task and
returns a result. Budget enforcement stops runaway runs. Guardrails gate
irreversible actions. The agent works end-to-end without an external
orchestrator.

### Phase 3 — Memory + evals

**Ships:** Working context compaction, run-state checkpoints with resume,
eval harness with graders + example suite.

**Milestone:** Agent survives long runs (50+ turns) without context
degradation. A crashed agent resumes from checkpoint. `npm run eval` runs the
example suite and produces a graded report. Eval suite gates prompt changes
in CI.

### Phase 4 — Dispatch + additional adapters

**Ships:** In-process dispatch queue, Azure Functions comm adapter, job status
endpoint.

**Milestone:** Tasks queue and process in order. Backpressure rejects excess
load. The same agent deploys to Azure Functions with a config change.

### Phase 5 — Scale

**Ships:** Redis Streams dispatch backend, long-term memory, concurrent task
processing (multiple Fleet members per agent), Docker production image.

**Milestone:** Multi-container deployment with Redis-based task routing.
Agents carry facts across runs. N tasks process in parallel on N members.

---

## Builder API

The primary developer-facing API for assembling an agent:

```js
import { createAgent } from './agent/index.mjs';
import { findInvoices, reconcilePO } from './tools/invoices.mjs';

const agent = createAgent('invoice-matcher')
  .tools([findInvoices, reconcilePO])
  .runLoop({ strategy: 'plan-execute' })        // optional
  .budget({ maxIterations: 25, maxCostUsd: 5 }) // optional
  .guardrails({ requireApproval: ['irreversible'] }) // optional
  .build();

// Full agent mode — autonomous
const result = await agent.run({
  goal: 'Find mismatched invoices for January 2026',
  inputs: { period: '2026-01' },
});

// Tool server mode — external caller picks tools
const toolResult = await agent.callTool('find-invoices', {
  period: '2026-01',
});
```

`createAgent()` reads from `agent.config.mjs` for defaults. Builder methods
override config values. `.build()` validates the final configuration and
returns an agent instance.

The builder is sugar over the config. Everything the builder can do, the
config file can do. The builder exists for programmatic assembly; the config
file exists for deployment configuration.

---

## Relationship to existing code

| Existing module | What happens |
|---|---|
| `mcp/registry.mjs` | Entries migrate to `agent/tools/registry.mjs` with extended fields. A re-export from the old path maintains backward compatibility during transition. |
| `mcp/server.mjs` | Unchanged. Reads tools from the new registry path. |
| `mcp/http.mjs` | Express-specific code moves to `comm/express.mjs`. The MCP protocol handling stays in `mcp/server.mjs`. |
| `mcp/main.mjs` | Replaced by `agent/index.mjs` as the entry point. |
| `mcp/auth.mjs` | Unchanged. Injected into the comm adapter as before. |
| `mcp/fleet-text.mjs` | Unchanged. Used by tool implementations. |
| `transport/stdio-fleet.mjs` | Unchanged. The agent entry point calls `spawnFleet()` the same way `mcp/main.mjs` does today. |
| `workflows/*` | Unchanged. Each workflow launcher is wrapped as a tool entry in the registry. Workflow code does not change. |

No existing functionality is removed. The refactoring lifts code into the
new module structure without breaking the current MCP interface.

---

## What this spec does not cover

- **Fleet-side changes.** LangChain member types, new member registration
  APIs, or Fleet CLI changes are out of scope. The kit consumes Fleet as-is.
- **Specific agent implementations.** The kit is the framework. Individual
  agents (invoice matcher, card sync, etc.) are built on top of it.
- **Multi-agent orchestration.** One container = one agent. Coordination
  between agents (e.g., one agent dispatching to another) is an external
  concern handled by the dispatch layer or a higher-level orchestrator.
- **Authentication implementation.** The auth stub pattern (injection) is
  unchanged. Real auth (bearer tokens, OAuth) is a deployment concern.
- **CI/CD pipeline.** The eval harness is CI-friendly but the pipeline
  configuration is deployment-specific.
