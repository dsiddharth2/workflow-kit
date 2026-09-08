import { test } from 'node:test';
import assert from 'node:assert/strict';

// We test the wrapper logic by mocking the MCP Client. The actual
// StdioClientTransport spawn is tested in the live integration tier.

const { createFleetApi, spawnFleet, DEFAULT_REQUEST_TIMEOUT_MS } = await import('../transport/stdio-fleet.mjs');

function createMockClient({ tools = [], callResults = {} } = {}) {
  const calls = [];
  return {
    calls,
    async listTools() {
      return { tools: tools.map((name) => ({ name })) };
    },
    async callTool(params, options) {
      calls.push({ ...params, options });
      const result = callResults[params.name];
      if (result instanceof Error) throw result;
      return result ?? { content: [{ type: 'text', text: 'ok' }] };
    },
    async connect() {},
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

test('createFleetApi strips timeoutMs and signal from tool arguments', async () => {
  const client = createMockClient({ tools: FLEET_TOOLS });
  const api = await createFleetApi(client);
  const signal = new AbortController().signal;

  await api.executePrompt({
    prompt: 'hello',
    member_name: 'DOER',
    timeoutMs: 120_000,
    signal,
    failSoft: true,
  });

  assert.deepEqual(client.calls[0].arguments, { prompt: 'hello', member_name: 'DOER' });
  assert.equal(client.calls[0].options.timeout, 120_000);
  assert.equal(client.calls[0].options.signal, signal);
});

test('createFleetApi defaults client timeout to 15 minutes', async () => {
  const client = createMockClient({ tools: FLEET_TOOLS });
  const api = await createFleetApi(client);
  await api.executeCommand({ command: 'echo', member_name: 'X' });
  assert.equal(client.calls[0].options.timeout, DEFAULT_REQUEST_TIMEOUT_MS);
  assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 15 * 60 * 1000);
});

test('createFleetApi derives timeout from timeout_s plus grace', async () => {
  const client = createMockClient({ tools: FLEET_TOOLS });
  const api = await createFleetApi(client);
  await api.executeCommand({ command: 'echo', member_name: 'X', timeout_s: 120 });
  assert.equal(client.calls[0].options.timeout, 120_000 + 30_000);
  assert.equal(client.calls[0].arguments.timeout_s, 120);
});

function fakeTransportClass(captures) {
  return class FakeTransport {
    constructor(params) {
      captures.transportParams = params;
    }
    async close() {
      captures.transportClosed = true;
    }
  };
}

test('spawnFleet registers a member and skip-registers when already listed', async () => {
  const client = createMockClient({
    tools: FLEET_TOOLS,
    callResults: {
      list_members: { content: [{ type: 'text', text: 'DEMO-DOER' }] },
    },
  });
  const captures = {};
  const { stop } = await spawnFleet(
    { memberName: 'DEMO-DOER', workFolder: '/tmp/demo' },
    { Client: class {
      constructor() { return client; }
    }, StdioClientTransport: fakeTransportClass(captures) },
  );
  const registerCalls = client.calls.filter((c) => c.name === 'register_member');
  assert.equal(registerCalls.length, 0, 'already-listed members must not be re-registered');
  await stop();
  await stop();
  assert.equal(captures.transportClosed, true);
});

test('spawnFleet rejects when register_member returns a Fleet error', async () => {
  const client = createMockClient({
    tools: FLEET_TOOLS,
    callResults: {
      list_members: { content: [{ type: 'text', text: '' }] },
      register_member: { content: [{ type: 'text', text: '❌ host is required' }] },
    },
  });
  await assert.rejects(
    () => spawnFleet(
      { memberName: 'X', workFolder: '/tmp/x' },
      { Client: class { constructor() { return client; } }, StdioClientTransport: fakeTransportClass({}) },
    ),
    /host is required/,
  );
});

test('spawnFleet passes stdio args and OAuth env to the transport', async () => {
  const client = createMockClient({ tools: FLEET_TOOLS });
  const captures = {};
  const { stop } = await spawnFleet(
    {
      oauthToken: 'tok',
      bin: '/opt/apra-fleet',
      env: { PATH: '/bin', HOME: '/tmp' },
    },
    {
      Client: class { constructor() { return client; } },
      StdioClientTransport: fakeTransportClass(captures),
    },
  );
  assert.equal(captures.transportParams.command, '/opt/apra-fleet');
  assert.deepEqual(captures.transportParams.args, ['run', '--transport', 'stdio']);
  assert.equal(captures.transportParams.env.CLAUDE_CODE_OAUTH_TOKEN, 'tok');
  await stop();
});
