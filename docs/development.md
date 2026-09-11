# Development guide

Day-to-day workflow for people writing code in this repo: getting set up, running
things, testing, and adding a workflow. For how the pieces fit together and why, read
[architecture.md](architecture.md) first.

## First-time setup

You need Node **22.16+**, `python3` on PATH for the dummy command, and the
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI if you want live
`agent()` calls.

```bash
npm install -g @apralabs/apra-fleet
apra-fleet install
```

`apra-fleet start` is not required. Launchers spawn `apra-fleet run --transport stdio`
for the duration of a run.

Then, in the repo:

```bash
npm install                                  # installs the MCP, HTTP, and stdio client dependencies
```

`npm install` does **not** install Fleet's workflow packages. `@apralabs/apra-fleet-workflow`
resolves at runtime through a symlink created automatically by `ensureApralabs()`. It
checks `~/.apra-fleet/node_modules/@apralabs` first, then falls back to the npm global
prefix (where `npm install -g @apralabs/apra-fleet` lands). This is intentional — Fleet
is a machine install, not a project dependency.

### Members and OAuth

Node registers pool members (`WORKER-{i}-DOER` / `-REVIEWER`) when the dispatcher
starts. Workflows address `'doer'` and `'reviewer'` on the leased pair. Live
`agent()` calls need `CLAUDE_CODE_OAUTH_TOKEN` in the environment so
`MemberManager` can attach it via `provision_llm_auth`:

```bash
export CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"
```

There is no provisioning script on the startup path. Docker's entrypoint only
installs deps and execs Node; registration happens in `pool/member-manager.mjs`.
`--type local` is required if you register by hand; the default is remote and
demands a `host`.

Re-export a fresh token when you see `OAuth session expired`.

If `apra-fleet` is not on PATH, set `APRA_FLEET_BIN` to the binary.

## Running things

| Command | Needs Fleet binary? | Needs a token? |
|---|---|---|
| `npm test` | no | no |
| `node --test tests/transport-stdio-fleet.test.mjs` | no | no |
| `node --test tests/pool-*.test.mjs` | no | no |
| `node --test tests/demo.test.mjs` | no | no |
| `node --test tests/inspect-members.test.mjs` | no | no |
| `node --test tests/mcp.test.mjs` | no | no |
| `node --test tests/stdio-fleet.live.test.mjs` | yes (skips otherwise) | no |
| `node --test tests/mcp.live.test.mjs` | yes | no |
| `node --test tests/demo.live.test.mjs` | yes | yes |
| `node --test tests/dispatch.live.test.mjs` | yes | yes |
| `node workflows/demo/main.mjs` | yes | yes |
| `npm run mcp` | yes | only for `demo` |
| `python3 workflows/demo/dummy.py` | no | no |
| `python3 workflows/inspect-members/inspect.py --root <work-folder>` | no | no |

A successful live workflow run prints `agent result: pong` and **returns to the shell**
with exit 0. If it prints `pong` and hangs, the transport was not stopped — check the
`finally` block in the launcher.

The MCP server listens on loopback at `PORT`, default 3000. Start it, then register it
with Claude Code from another terminal:

```bash
npm run mcp
claude mcp add --transport http fleet http://127.0.0.1:3000/mcp
```

See [mcp-interface.md](mcp-interface.md) for timeout, hosting, and authentication
configuration.

## Testing

Tests split by what they need, and the split is the point.

**Mock tests** (`tests/transport-stdio-fleet.test.mjs`, the `tests/pool-*.test.mjs`
files, `tests/demo.test.mjs`, `tests/inspect-members.test.mjs`) run anywhere — no
Fleet binary, no members, no tokens, no network. They work because the launchers
accept an injected `fleetApi`, and the transport wrapper is unit-tested against a
fake MCP client.

`tests/mcp.test.mjs` also needs no Fleet binary or token. It drives a real MCP client
over a real ephemeral port against the HTTP application, with Fleet mocked underneath.
Those files are what `npm test` runs, and what you should run constantly.

The workflow mock is a hand-written object implementing the methods the body actually
uses (`fleetStatus`, `executeCommand`, `executePrompt`) and recording its calls. It
returns realistic MCP envelopes — `content[]` plus `structuredContent` — so the
text-extraction paths get exercised rather than bypassed. `demo.js` no longer calls
`registerMember`; a test that omits that method is enough to prove registration did
not leak back into the body.

**Live tests** split further. `tests/stdio-fleet.live.test.mjs` spawns a real Fleet
stdio child, registers a temp member, and calls `fleetStatus` / `listMembers`. It skips
when `apra-fleet` is not installed. `tests/mcp.live.test.mjs` starts the MCP server
(which spawns Fleet) and calls `inspect-members` without spending tokens.
`tests/demo.live.test.mjs` runs the full workflow against a real member with a real
token, asserting `hello-from-python`, the transform payload, and `pong`.
`tests/dispatch.live.test.mjs` proves pool → ephemeral → queue against a real Fleet
(two pool workers, two ephemeral, two queued). It is not part of `npm test`. Run live
tests before merging changes that touch the Fleet integration, not on every save.

`tests/setup-fleet-modules.mjs` calls `ensureApralabs()` before any test imports Fleet
packages; import it first in any new test file that pulls in a launcher.

When you add behavior, prefer extending the mock over reaching for a live Fleet child.
If something can only be verified live, that is usually a hint that connection logic has
leaked into a workflow body.

## Adding a workflow

Follow the existing shape rather than inventing a new one.

**1. Create the launcher and body.** Copy the split from `workflows/demo/`: a
`main.mjs` that owns spawn, transport cleanup and the exported entry function, and
a body file that only knows how to do the work given the engine `context`. The entry
function must accept `{ fleetApi, workspace }` so it stays testable. Address
`'doer'` and `'reviewer'`, never a hardcoded member name.

```js
import { withStandaloneLease } from '../standalone.mjs';
import { ensureApralabs } from '../demo/ensure-apralabs.mjs';

export async function runMyWorkflow({ fleetApi, workspace, signal, reportPhase } = {}) {
  ensureApralabs();
  if (!fleetApi) {
    return withStandaloneLease((ctx) => runMyWorkflow({ ...ctx, reportPhase }));
  }
  // …execute the body
}
```

**2. Write a mock test first.** Reuse the mock-client pattern. Assert the calls you care
about — which roles, which commands, which prompts. Do not put registration in the
body; `withStandaloneLease` / MemberManager own spawn and registration.

**3. Expose it as an MCP tool, if it should be.** Append an entry to `defaultRegistry`
in `mcp/registry.mjs`:

```js
{
  name: 'my-workflow',
  description: 'What this does and when a model should choose it.',
  inputSchema: z.object({ target: z.string().describe('What to act on') }),
  annotations: { readOnlyHint: true },
  async run({ fleetApi, args, signal, reportPhase, workspace }) {
    return await runMyWorkflow({ fleetApi, signal, reportPhase, workspace, target: args.target });
  },
}
```

No changes to `server.mjs` or `http.mjs` are needed — the registry is data. `name` must
be unique, `inputSchema` must be a `z.object(...)`, and omitting `inputSchema` declares
a no-argument tool. Write `description` for the connected model deciding whether to
choose the tool. A thrown `run` automatically becomes an MCP `isError` result.

**4. Workers are leased, not hardcoded.** Workflows address `'doer'` and `'reviewer'`.
The dispatcher registers pool members at startup from `WORKER_POOL_SIZE`. Do not
put registration in the body, and do not hardcode member names. There is no
provisioning script on the startup path.

## Conventions

- **ESM everywhere.** `"type": "module"`, `.mjs` for launchers and MCP modules.
- **`node:test` and `node:assert/strict`.** No test framework dependency.
- **No `@apralabs/*` in `package.json`.** Fleet's workflow packages resolve through the symlink.
- **`@modelcontextprotocol/client` is a runtime dependency** — the stdio transport imports it.
- **Dependency injection over module-level singletons.** Anything that talks to Fleet
  takes `fleetApi` as an argument.
- **Dynamic `import()` for Fleet packages**, always after `ensureApralabs()`.
- **Secrets live in Fleet's credential store and `CLAUDE_CODE_OAUTH_TOKEN`**, never in
  source, never in an `agent()` payload, never in git.
- **Comments explain why, not what.** The existing comments mark non-obvious
  constraints — why `'junction'`, why `failSoft` is defined as non-enumerable.

## Local state and git

`node_modules/`, `.claude/` (including the copies Fleet seeds inside
`workdir/*/`), `.env`, `.cursor/` and leftover `.fleet/` / `.fleet-src/` directories are
all gitignored. The `.claude/settings.local.json` files that appear under `workdir/`
after registering members are machine state, not product source — leave them out of
commits.

## Docker

Build once, run, done. The image installs Fleet, Claude Code, and project dependencies.
The entrypoint installs deps and links packages; it does **not** register members.
Node's `MemberManager` registers the worker pool and attaches `CLAUDE_CODE_OAUTH_TOKEN`
when the MCP process starts.

### Quick start

```bash
docker compose up                    # MCP server on port 3000
```

Then register the MCP server with Claude Code from the host:

```bash
claude mcp add --transport http fleet http://127.0.0.1:3000/mcp
```

Pass an OAuth token for live `agent()` calls:

```bash
CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)" docker compose up
```

The token is passed as an environment variable. Node attaches it to pool members at
startup via `provision_llm_auth`, and the stdio child inherits it — nothing is saved
to disk in this repo.

Override the host port with `MCP_PORT`:

```bash
MCP_PORT=4000 docker compose up
```

### Running workflows or tests directly

```bash
docker compose run --rm fleet node workflows/demo/main.mjs      # live workflow (spawns stdio Fleet)
docker compose run --rm fleet node --test tests/demo.test.mjs   # mock tests
```

Passing `--test` still uses the same entrypoint (deps + symlink + exec). Mock tests
do not need a Fleet child. Live runs spawn stdio Fleet from the launcher or MCP
server.

### How it works

The entrypoint runs automatically on every container start:

1. Installs project deps if the named volume is empty (first run)
2. Symlinks `@apralabs` packages so workflows resolve them
3. Execs the container command (MCP server by default)

Member registration and OAuth happen in Node (`createWorkerDispatcher` /
`MemberManager`) after the process starts and spawns `apra-fleet run --transport
stdio`. The entrypoint no longer starts an HTTP Fleet server.

The compose file sets `MCP_BIND_HOST=0.0.0.0` so the MCP server is reachable from the
host. The default bind address remains `127.0.0.1` for local development outside Docker.
A named volume for `node_modules` prevents the host bind mount from overwriting
Linux-native dependencies.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `apra-fleet` not found / spawn error | Install Fleet (`npm install -g @apralabs/apra-fleet && apra-fleet install`) or set `APRA_FLEET_BIN`. |
| `Fleet MCP server is missing required tools` | The spawned binary is too old or not Fleet. Need a build that supports `run --transport stdio`. |
| `Cannot find package 'undici'` | Stale `node_modules/@apralabs` symlink. `ensureApralabs()` checks `~/.apra-fleet/node_modules` first, then the npm global prefix; delete any leftover `.fleet-src`. |
| `"host" is required for remote members` | Add `--type local` to `register-member`. |
| `Member "…" not found` on `auth` | Register the member before authenticating it. |
| `OAuth session expired` | `claude setup-token`, export `CLAUDE_CODE_OAUTH_TOKEN`, re-run. |
| Live run prints `pong` but never exits | Transport not stopped — check the launcher's `finally`. |
| A tool is never chosen | Improve its registry `description` so the connected model knows when to use it. |
| A tool call times out | Set `"timeout"` in that server's `.mcp.json` entry. |
