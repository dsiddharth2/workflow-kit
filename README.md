# workflow-kit

A workflow kit from [Apra Fleet](https://github.com/Apra-Labs/apra-fleet). Clone it, write your workflows and tools, `docker compose up`. Everything else — Fleet install, member registration, dependency installation, MCP server — is handled for you. Workflows spawn Fleet over stdio; you do not need `apra-fleet start`.

## Quick start

```bash
git clone https://github.com/dsiddharth2/workflow-kit.git
cd workflow-kit
```

Set the OAuth token and start the container in the background:

**Bash / macOS / Linux:**
```bash
CLAUDE_CODE_OAUTH_TOKEN="your-token" docker compose up -d
```

**PowerShell (Windows):**
```powershell
$env:CLAUDE_CODE_OAUTH_TOKEN = "your-token"
docker compose up -d
```

That's it. The MCP server is now listening on `http://localhost:3000/mcp`. Register it with Claude Code:

```bash
claude mcp add --transport http fleet http://127.0.0.1:3000/mcp
```

Claude can now call your workflows as MCP tools.

---

## What you get out of the box

The Docker image handles everything on startup:

1. Installs Fleet, Claude Code, and project dependencies
2. Starts an HTTP Fleet server long enough to provision members and attach your OAuth token
3. Starts the MCP server on port 3000, which spawns its own Fleet child over stdio

You only write two things:

- **Workflow bodies** — the actual work your agents do (`workflows/`)
- **Tool entries** — one entry per workflow in the MCP registry (`mcp/registry.mjs`)

---

## Writing your first workflow

### 1. Create the workflow body

```text
workflows/my-workflow/
  main.mjs          # launcher: spawns Fleet over stdio, runs the engine, cleans up
  my-workflow.js    # body: receives engine context, does the work
```

The body receives `context` with Fleet primitives — `command()`, `transform()`, `agent()` — and does the work:

```js
// workflows/my-workflow/my-workflow.js
export const meta = { name: 'my-workflow' };

export async function main(context) {
  const { command, agent, log } = context;

  log('running analysis');
  const data = await command('python3 analyze.py', { member_name: 'MY-DOER' });

  const reply = await agent('Summarize this data', { member_name: 'MY-DOER' });
  return { data, reply };
}
```

The launcher owns spawn and cleanup. Copy the pattern from `workflows/demo/main.mjs`:

```js
// workflows/my-workflow/main.mjs
export async function runMyWorkflow({ fleetApi } = {}) {
  ensureApralabs();
  let api = fleetApi;
  let stop = null;
  if (!api) {
    const { spawnFleet } = await import('../../transport/stdio-fleet.mjs');
    const fleet = await spawnFleet({
      memberName: 'MY-DOER',
      workFolder: path.join(repoRoot, 'workdir', 'MY-DOER'),
    });
    api = fleet.fleetApi;
    stop = fleet.stop;
  }
  try {
    // …execute the body
  } finally {
    await stop?.();
  }
}
```

### 2. Expose it as an MCP tool

Append one entry to `mcp/registry.mjs`:

```js
{
  name: 'my-workflow',
  description: 'What this does and when a model should choose it.',
  inputSchema: z.object({ target: z.string().describe('What to act on') }),
  async run({ fleetApi, args, signal, reportPhase }) {
    return await runMyWorkflow({ fleetApi, target: args.target, signal, reportPhase });
  },
}
```

No changes to `server.mjs` or `http.mjs` needed — the registry is data.

### 3. Register your members

Pass `memberName` and `workFolder` to `spawnFleet()` in the launcher so they are
registered when Fleet starts. Also add them to `scripts/provision-members.sh` if you
use Docker (the entrypoint provisions into Fleet's shared data dir):

```bash
apra-fleet register-member --type local --llm claude \
  --name MY-DOER --path "$(pwd)/workdir/MY-DOER"
```

Create matching folders under `workdir/`. Each member needs its own folder — two members sharing a `cwd` will collide.

### 4. Run it

```bash
docker compose up
```

---

## Running without Docker

If you prefer running directly on your machine:

```bash
# Install Fleet globally
npm install -g @apralabs/apra-fleet
apra-fleet install

# Install project deps
npm install

# Token for live agent() calls
export CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"

# Start the MCP server (spawns Fleet over stdio)
npm run mcp
```

`apra-fleet start` is not required. Set `APRA_FLEET_BIN` if the binary is not on PATH.

---

## Running workflows directly

```bash
# Inside Docker
docker compose run --rm fleet node workflows/demo/main.mjs

# On host
node workflows/demo/main.mjs
```

---

## Testing

Tests run without a Fleet binary, without members, and without tokens:

```bash
npm test                                                              # all mock tests
docker compose run --rm fleet node --test tests/demo.test.mjs         # in Docker
```

The mock tests inject a fake `fleetApi` and assert real behavior — command dispatch, transform, agent calls. Write mock tests first when adding workflows.

Live tests need the `apra-fleet` binary (they spawn it over stdio). `demo.live` also needs a token:

```bash
node --test tests/stdio-fleet.live.test.mjs  # spawn + fleetStatus; skips if no binary
node --test tests/demo.live.test.mjs         # full workflow with real LLM
node --test tests/mcp.live.test.mjs          # MCP server against live stdio Fleet
```

---

## How it works

```text
┌─────────────────────────────────────────────────────────────┐
│  Your Node process                                          │
│                                                             │
│   mcp/             POST /mcp — one MCP tool per registry    │
│     │              entry. Claude chooses from descriptions.  │
│     │ entry.run({ fleetApi, args, signal, reportPhase })    │
│     ▼                                                       │
│   workflows/       runDemo() — spawn + execute               │
│     │              Your workflow bodies live here.           │
│     ▼                                                       │
│   transport/       spawnFleet() — StdioClientTransport       │
└─────┼───────────────────────────────────────────────────────┘
      │ MCP JSON-RPC over stdin/stdout
      ▼
┌─────────────────────────────────────────────────────────────┐
│  apra-fleet child     `run --transport stdio`               │
│                                                             │
│   YOUR-DOER                     YOUR-REVIEWER               │
│   workdir/YOUR-DOER/            workdir/YOUR-REVIEWER/      │
│   Claude Code + OAuth           registered, ready            │
└─────────────────────────────────────────────────────────────┘
```

Four ideas explain most of the code:

- **Launcher / body split.** `main.mjs` owns spawn, transport and cleanup; the `.js` body only does the work. That is what keeps bodies testable.
- **`fleetApi` is injected.** Launchers spawn only when no client is passed in, so mock tests run with no binary and no tokens.
- **Fleet is a machine install, not a dependency.** `ensureApralabs()` symlinks `node_modules/@apralabs` to the Fleet install. No `@apralabs/*` in `package.json`.
- **Downstream Fleet is stdio.** Launchers call `spawnFleet()`. `APRA_FLEET_TRANSPORT` is not used. Members are registered at spawn time, not in the workflow body.

---

## Setting up the OAuth token

The OAuth token is inherited by the spawned Fleet child via `CLAUDE_CODE_OAUTH_TOKEN`
and attached to the member with `provision_llm_auth`. Fleet spawns Claude (not your
Node process), so the token must reach that child.

### Local development

```bash
apra-fleet auth --oauth --member DEMO-DOER "$(claude setup-token)"
```

`claude setup-token` opens a browser login and outputs the token. Export it (or pass
it to `spawnFleet({ oauthToken })`) so the stdio child can attach it to the member.

### Docker / VM

**Bash / macOS / Linux:**
```bash
CLAUDE_CODE_OAUTH_TOKEN="your-token" docker compose up -d
```

**PowerShell (Windows):**
```powershell
$env:CLAUDE_CODE_OAUTH_TOKEN = "your-token"
docker compose up -d
```

The provision script picks up the env var and runs `apra-fleet auth` inside the
container (against the entrypoint's HTTP Fleet) so the shared data dir has the token.
The MCP process also inherits the env var when it spawns stdio Fleet. The `-d` flag
runs the container in the background.

### CI (GitHub Actions, Azure Pipelines, etc.)

1. Run `claude setup-token` locally and copy the output
2. Store it as a secret in your CI provider (e.g. GitHub Secrets → `CLAUDE_CODE_OAUTH_TOKEN`)
3. Pass it as an environment variable when starting the container

The token never enters the Docker image — it is injected at runtime and stored only
in Fleet's in-memory credential store.

---

## Docker configuration

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | — | OAuth token inherited by spawned Fleet processes |
| `APRA_FLEET_BIN` | `apra-fleet` on PATH | Fleet binary when it is not on PATH |
| `MCP_PORT` | `3000` | Host port mapped to the MCP server |
| `MCP_BIND_HOST` | `0.0.0.0` (compose) / `127.0.0.1` (local) | MCP server bind address |

Override the host port:

```bash
MCP_PORT=4000 docker compose up
```

---

## Layout

```text
workflows/
  demo/                 # demo workflow — replace with your own
    main.mjs            # launcher: spawnFleet, execute, stop()
    demo.js             # body: status, command, transform, agent
    dummy.py            # stand-in for real Python work
    ensure-apralabs.mjs # symlinks @apralabs packages from Fleet install
  inspect-members/      # read-only member inspection workflow
    main.mjs, inspect-members.js, inspect.py
transport/
  stdio-fleet.mjs       # spawn apra-fleet over stdio, wrap as fleetApi
mcp/
  main.mjs              # MCP server launcher, configurable bind address
  server.mjs            # one MCP tool per registry entry
  http.mjs              # stateless POST /mcp and GET /health
  registry.mjs          # tool catalog — add your workflows here
  auth.mjs              # injectable auth stub (replace for production)
  fleet-text.mjs        # extract text from Fleet MCP results
scripts/
  docker-entrypoint.sh  # start HTTP Fleet, install deps, provision, exec
  provision-members.sh  # register members + attach OAuth (Docker / shared data dir)
tests/                  # mock and live test suites
workdir/                # member working directories (one per member)
docs/
  architecture.md       # layers, data flow, design decisions
  development.md        # setup, testing, adding workflows, conventions
  mcp-interface.md      # MCP tool reference, timeouts, auth, hosting
  specs/                # stdio transport spec and implementation plan
Dockerfile
docker-compose.yml
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `apra-fleet` not found / spawn error | Install Fleet (`npm install -g @apralabs/apra-fleet && apra-fleet install`) or set `APRA_FLEET_BIN`. |
| `Fleet MCP server is missing required tools` | Need a Fleet build that supports `run --transport stdio`. |
| `"host" is required for remote members` | Add `--type local` to `register-member`. |
| `Member "…" not found` on `auth` | Register the member first, then `auth`. |
| `OAuth session expired` | `claude setup-token`, export `CLAUDE_CODE_OAUTH_TOKEN`, re-run. |
| `Cannot find package 'undici'` | Stale `@apralabs` symlink. Delete `node_modules/@apralabs` and re-run. |
| Live run prints `pong` but never exits | Transport not stopped — check the launcher's `finally` block. |
| MCP tool not chosen by Claude | Improve its `description` in `mcp/registry.mjs`. |
| MCP tool call times out | Set `"timeout": 600000` in `.mcp.json` for that server. |

---

## Further reading

| Document | Covers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Fleet concepts, layer diagram, module map, design decisions |
| [docs/development.md](docs/development.md) | First-time setup, testing, adding workflows, conventions |
| [docs/mcp-interface.md](docs/mcp-interface.md) | MCP tool catalog, registry contract, timeouts, auth, hosting |
| [docs/specs/stdio-transport-spec.md](docs/specs/stdio-transport-spec.md) | Stdio Fleet transport design |
