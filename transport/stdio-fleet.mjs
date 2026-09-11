import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// Match @apralabs/apra-fleet-client: FleetWorkflow.agent()/command() pass
// timeoutMs/signal expecting a 15-minute client default, not the MCP SDK's 60s.
export const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
const TIMEOUT_GRACE_MS = 30 * 1000;

export function deriveTimeoutMs(payload = {}) {
  const hintSeconds = payload.max_total_s ?? payload.timeout_s;
  if (typeof hintSeconds !== 'number' || !Number.isFinite(hintSeconds) || hintSeconds <= 0) {
    return undefined;
  }
  return hintSeconds * 1000 + TIMEOUT_GRACE_MS;
}

function toolText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  return (result.content ?? []).map((part) => part.text ?? '').join('\n');
}

export function toolResultLooksFailed(result) {
  if (result?.isError) return true;
  return /^\s*(❌|ERROR:)/m.test(toolText(result));
}

function memberListed(result, name) {
  return toolText(result).split(/[\n\r]/).some((line) => line.includes(name));
}

// The five fleetApi methods and the Fleet MCP tool names they map to.
// Names are discovered at connect time via listTools(); these are the
// expected names used for matching.
export const FLEET_METHODS = Object.freeze({
  executeCommand: 'execute_command',
  executePrompt: 'execute_prompt',
  listMembers: 'list_members',
  registerMember: 'register_member',
  fleetStatus: 'fleet_status',
});

const CLIENT_ONLY_KEYS = new Set(['timeoutMs', 'signal', 'failSoft']);

// Build a fleetApi-compatible wrapper from a connected MCP Client.
// Exported for unit testing; spawnFleet() calls it after connecting.
export async function createFleetApi(client) {
  const { tools } = await client.listTools();
  const available = new Set(tools.map((t) => t.name));

  // Verify every required tool is present.
  const missing = Object.values(FLEET_METHODS).filter((name) => !available.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Fleet MCP server is missing required tools: ${missing.join(', ')}. ` +
        `Available: ${[...available].join(', ')}`,
    );
  }

  function call(toolName, args = {}) {
    const payload = {};
    for (const [key, value] of Object.entries(args ?? {})) {
      if (!CLIENT_ONLY_KEYS.has(key)) payload[key] = value;
    }
    const timeout = args?.timeoutMs ?? deriveTimeoutMs(payload) ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const options = { timeout };
    if (args?.signal) options.signal = args.signal;
    return client.callTool({ name: toolName, arguments: payload }, options);
  }

  const api = {
    executeCommand(opts) { return call(FLEET_METHODS.executeCommand, opts); },
    executePrompt(opts) { return call(FLEET_METHODS.executePrompt, opts); },
    listMembers(opts) { return call(FLEET_METHODS.listMembers, opts); },
    registerMember(opts) { return call(FLEET_METHODS.registerMember, opts); },
    fleetStatus() { return call(FLEET_METHODS.fleetStatus); },
  };
  if (available.has('remove_member')) {
    api.removeMember = (opts) => call('remove_member', opts);
  }
  if (available.has('provision_llm_auth')) {
    api.provisionLlmAuth = (opts) => call('provision_llm_auth', opts);
  }
  return api;
}

export async function ensureRegistered(fleetApi, memberName, workFolder) {
  const listed = await fleetApi.listMembers({});
  if (memberListed(listed, memberName)) return;

  const result = await fleetApi.registerMember({
    friendly_name: memberName,
    work_folder: workFolder,
    member_type: 'local',
  });
  if (!toolResultLooksFailed(result)) return;

  const again = await fleetApi.listMembers({});
  if (memberListed(again, memberName)) return;

  throw new Error(`register_member failed: ${toolText(result)}`);
}

// Spawn apra-fleet as a child process over stdio, connect an MCP client,
// register the member, attach OAuth, and return a ready fleetApi.
// The second argument is test-only (inject Client / StdioClientTransport).
export async function spawnFleet({
  memberName,
  workFolder,
  oauthToken,
  bin,
  env = process.env,
} = {}, {
  Client: ClientImpl = Client,
  StdioClientTransport: TransportImpl = StdioClientTransport,
} = {}) {
  const command = bin ?? env.APRA_FLEET_BIN ?? 'apra-fleet';
  const token = oauthToken ?? env.CLAUDE_CODE_OAUTH_TOKEN;

  const childEnv = { ...env };
  if (token) childEnv.CLAUDE_CODE_OAUTH_TOKEN = token;

  const transport = new TransportImpl({
    command,
    args: ['run', '--transport', 'stdio'],
    env: childEnv,
    stderr: 'inherit',
  });

  const client = new ClientImpl({ name: 'workflow-kit', version: '1.0.0' });

  let connected = false;
  try {
    await client.connect(transport);
    connected = true;

    const fleetApi = await createFleetApi(client);

    if (memberName && workFolder) {
      await ensureRegistered(fleetApi, memberName, workFolder);
    }

    // Attach OAuth if a token is available. The token was passed to the child
    // via env, and provision_llm_auth copies the local OAuth session.
    if (memberName && token) {
      try {
        const authResult = await client.callTool({
          name: 'provision_llm_auth',
          arguments: { member_name: memberName },
        });
        if (toolResultLooksFailed(authResult)) {
          console.warn(`[stdio-fleet] OAuth provisioning failed for ${memberName}: ${toolText(authResult)}`);
        }
      } catch (err) {
        console.warn(`[stdio-fleet] OAuth provisioning failed for ${memberName}: ${err.message}`);
      }
    }

    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      try { await client.close(); } catch { /* best effort */ }
      try { await transport.close(); } catch { /* best effort */ }
    };

    return { fleetApi, stop };
  } catch (err) {
    if (connected) {
      try { await client.close(); } catch { /* best effort */ }
    }
    try { await transport.close(); } catch { /* best effort */ }
    throw err;
  }
}
