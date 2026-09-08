import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

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
    return client.callTool({ name: toolName, arguments: args });
  }

  return {
    executeCommand(opts) { return call(FLEET_METHODS.executeCommand, opts); },
    executePrompt(opts) { return call(FLEET_METHODS.executePrompt, opts); },
    listMembers(opts) { return call(FLEET_METHODS.listMembers, opts); },
    registerMember(opts) { return call(FLEET_METHODS.registerMember, opts); },
    fleetStatus() { return call(FLEET_METHODS.fleetStatus); },
  };
}

// Spawn apra-fleet as a child process over stdio, connect an MCP client,
// register the member, attach OAuth, and return a ready fleetApi.
export async function spawnFleet({
  memberName,
  workFolder,
  oauthToken,
  bin,
  env = process.env,
} = {}) {
  const command = bin ?? env.APRA_FLEET_BIN ?? 'apra-fleet';
  const token = oauthToken ?? env.CLAUDE_CODE_OAUTH_TOKEN;

  const childEnv = { ...env };
  if (token) childEnv.CLAUDE_CODE_OAUTH_TOKEN = token;

  const transport = new StdioClientTransport({
    command,
    args: ['run', '--transport', 'stdio'],
    env: childEnv,
    stderr: 'inherit',
  });

  const client = new Client({ name: 'workflow-kit', version: '1.0.0' });

  let connected = false;
  try {
    await client.connect(transport);
    connected = true;

    const fleetApi = await createFleetApi(client);

    // Register the member.
    if (memberName && workFolder) {
      await fleetApi.registerMember({
        friendly_name: memberName,
        work_folder: workFolder,
        member_type: 'local',
      });
    }

    // Attach OAuth if a token is available. The token was passed to the child
    // via env, and provision_llm_auth copies the local OAuth session.
    if (memberName && token) {
      try {
        await client.callTool({
          name: 'provision_llm_auth',
          arguments: { member_name: memberName },
        });
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
