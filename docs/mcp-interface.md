# MCP interface

The process exposes workflows to Claude Code as MCP tools at `POST /mcp`. It is an MCP
server on this side and an MCP client of a spawned Fleet process underneath (stdio).
The HTTP layer is stateless: each tool call receives a fresh upstream MCP server and
transport. The downstream Fleet child is spawned once when this server starts.

## Setup

Install Fleet and project dependencies, export a token if you need `demo`, and start
the MCP server. `apra-fleet start` is not required.

```bash
npm install -g @apralabs/apra-fleet
apra-fleet install
npm install
export CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"   # only for demo / agent()
npm run mcp
```

`startMcpServer()` spawns Fleet over stdio and builds a worker dispatcher that
registers pool members. Every tool call holds one leased doer/reviewer pair.
Register this server with Claude Code:

```bash
claude mcp add --transport http fleet http://127.0.0.1:3000/mcp
```

OAuth setup is described in the [development guide](development.md). The MCP server
binds to loopback and port 3000 by default. Set `APRA_FLEET_BIN` if `apra-fleet` is not
on PATH.

## Tool catalog

| Tool | Arguments | Behavior |
|---|---|---|
| `demo` | None | Runs the complete demo, including the agent smoke test. It spends LLM tokens and is not read-only. |
| `inspect-members` | `roles`, `includeFiles` | Reports on the pair the call is running on. It is read-only and spends no LLM tokens. |

`inspect-members` accepts:

- `roles`: optional array of `'doer'` and `'reviewer'`. It defaults to both roles
  on the leased pair this call is running on.
- `includeFiles`: optional boolean. When true, include a capped top-level directory
  listing for each member.

## Registry contract

`mcp/registry.mjs` is the complete tool registry. Each entry has this shape:

```js
{
  name,
  description,
  inputSchema?,
  annotations?,
  async run({ fleetApi, args, signal, reportPhase }) {
    // Return the final value shown to the model.
  },
}
```

`inputSchema`, when present, must be a `z.object(...)`. Omit it for a tool that takes no
arguments. `annotations` supplies MCP tool hints such as `readOnlyHint`. If `run`
throws, the MCP SDK automatically converts the exception into an `isError` tool result.

To add a workflow, import its launcher and append one entry to `mcp/registry.mjs`. No
changes to `server.mjs` or `http.mjs` are needed. Write `description` for the connected
model: it uses that text to decide when to choose the tool.

## Execution model

A tool call is one request and one final response. Workflow `phase()` and `log()` output
goes to the MCP server's terminal; Claude sees only heartbeat messages and the final
tool result. A heartbeat is a progress notification produced by `reportPhase`.

The heartbeat only fires when the client requests progress by sending a progress token.
It is not a substitute for configuring enough client time for a slow workflow.

### Timeouts

| Timer | Default | Notes |
|---|---|---|
| Wall clock per tool call | ~28 hours | `MCP_TOOL_TIMEOUT`, or per-server `timeout` in `.mcp.json`. Progress does not extend it. |
| First response byte | 60 seconds | HTTP/SSE only. Rises only if `timeout` / `MCP_TOOL_TIMEOUT` is ≥60s. |
| Idle | 5 minutes | Aborts a call sending neither a response nor progress. `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`; `0` disables. |

The reliable fix for a slow workflow is `"timeout": 600000` in that server's
`.mcp.json` entry:

```json
{
  "mcpServers": {
    "fleet": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "timeout": 600000
    }
  }
}
```

### Cancellation

Cancellation is cooperative. Workflows check the supplied `signal` between phases, so
cancellation stops the next phase rather than interrupting the phase currently running.

## Authentication and hosting

The included authentication function is a pass-through development stub. Replace it by
injecting middleware through `createMcpHttpApp({ authenticate })`; do not edit the
workflow or registry to add HTTP authentication.

The provided launcher binds to `127.0.0.1` by default. Set `MCP_BIND_HOST=0.0.0.0` for
Docker or VM deployments (the docker-compose file does this automatically). A
network-accessible deployment also needs bearer-token authentication: build the
middleware with `requireBearerAuth` from `@modelcontextprotocol/express`, inject it as
`authenticate`, and configure its token verifier. Do not expose the pass-through stub on
a non-loopback interface.

Give the matching token to Claude Code when registering the remote endpoint:

```bash
claude mcp add --transport http --header "Authorization: Bearer …" \
  fleet http://HOST:3000/mcp
```

Use TLS and a real secret manager for any network-accessible deployment.

## Output limits

Claude Code warns when MCP output exceeds 10,000 tokens and truncates it at 25,000
tokens. `MAX_MCP_OUTPUT_TOKENS` controls the truncation limit. Independently,
`workflows/inspect-members/inspect.py` caps its directory listing at 50 entries.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `apra-fleet` spawn error | Install Fleet or set `APRA_FLEET_BIN`, then restart the MCP server. |
| `OAuth session expired` | Re-export `CLAUDE_CODE_OAUTH_TOKEN` and restart so Node can re-attach OAuth to the pool. |
| A tool is not chosen | Improve its `description` in `mcp/registry.mjs` so the model knows when to use it. |
| A tool call times out | Set `"timeout"` in that server's `.mcp.json` entry; use `600000` for a ten-minute allowance. |
