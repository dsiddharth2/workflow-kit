import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// We test the wrapper logic by mocking the MCP Client. The actual
// StdioClientTransport spawn is tested in the live integration tier.

// createFleetApi is the internal wrapper builder — spawnFleet uses it after
// connecting. We export it separately for unit testing.
const { createFleetApi, FLEET_METHODS } = await import('../transport/stdio-fleet.mjs');

function createMockClient({ tools = [], callResults = {} } = {}) {
  const calls = [];
  return {
    calls,
    async listTools() {
      return { tools: tools.map((name) => ({ name })) };
    },
    async callTool(params) {
      calls.push(params);
      const result = callResults[params.name];
      if (result instanceof Error) throw result;
      return result ?? { content: [{ type: 'text', text: 'ok' }] };
    },
    async close() {},
  };
}

// Fleet's known tool names, as they appear in a real Fleet MCP server.
const FLEET_TOOLS = [
  'execute_command',
  'execute_prompt',
  'list_members',
  'register_member',
  'fleet_status',
  'credential_store_set',
  'provision_llm_auth',
];

test('createFleetApi discovers tool names and maps all five methods', async () => {
  const client = createMockClient({ tools: FLEET_TOOLS });
  const api = await createFleetApi(client);

  await api.executeCommand({ command: 'echo hi', member_name: 'DOER' });
  await api.executePrompt({ prompt: 'hello', member_name: 'DOER' });
  await api.listMembers({});
  await api.registerMember({ friendly_name: 'X', work_folder: '/tmp/x', member_type: 'local' });
  await api.fleetStatus();

  assert.equal(client.calls.length, 5);
  assert.equal(client.calls[0].name, 'execute_command');
  assert.deepEqual(client.calls[0].arguments, { command: 'echo hi', member_name: 'DOER' });
  assert.equal(client.calls[1].name, 'execute_prompt');
  assert.equal(client.calls[2].name, 'list_members');
  assert.equal(client.calls[3].name, 'register_member');
  assert.equal(client.calls[4].name, 'fleet_status');
});

test('createFleetApi normalizes MCP callTool response to content envelope', async () => {
  const client = createMockClient({
    tools: FLEET_TOOLS,
    callResults: {
      fleet_status: { content: [{ type: 'text', text: 'running' }] },
    },
  });
  const api = await createFleetApi(client);
  const result = await api.fleetStatus();
  assert.deepEqual(result, { content: [{ type: 'text', text: 'running' }] });
});

test('createFleetApi passes through structuredContent when present', async () => {
  const client = createMockClient({
    tools: FLEET_TOOLS,
    callResults: {
      execute_command: {
        content: [{ type: 'text', text: 'hello' }],
        structuredContent: { stdout: 'hello', exitCode: 0 },
      },
    },
  });
  const api = await createFleetApi(client);
  const result = await api.executeCommand({ command: 'echo', member_name: 'X' });
  assert.equal(result.structuredContent.stdout, 'hello');
});

test('createFleetApi throws when a required tool is missing from Fleet', async () => {
  const client = createMockClient({ tools: ['fleet_status'] });
  await assert.rejects(
    () => createFleetApi(client),
    (err) => {
      assert.match(err.message, /execute_command/);
      return true;
    },
  );
});

test('createFleetApi propagates callTool errors', async () => {
  const client = createMockClient({
    tools: FLEET_TOOLS,
    callResults: { fleet_status: new Error('child died') },
  });
  const api = await createFleetApi(client);
  await assert.rejects(() => api.fleetStatus(), /child died/);
});
