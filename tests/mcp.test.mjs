import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import * as z from 'zod/v4';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const { buildMcpServer } = await import('../mcp/server.mjs');
const { createMcpHttpApp } = await import('../mcp/http.mjs');
const { startMcpServer } = await import('../mcp/main.mjs');

function createMockFleetApi() {
  const commandCalls = [];
  const promptCalls = [];
  return {
    commandCalls,
    promptCalls,
    async fleetStatus() {
      return {
        content: [{ type: 'text', text: 'DEMO-DOER\nDEMO-REVIEWER' }],
      };
    },
    async executeCommand(options) {
      commandCalls.push(options);
      const payload = JSON.stringify({ root: '/tmp/x', exists: true, fileCount: 1, totalBytes: 4 });
      return {
        content: [{ type: 'text', text: payload }],
        structuredContent: { stdout: payload, exitCode: 0 },
      };
    },
    async executePrompt(options) {
      promptCalls.push(options);
      return { content: [{ type: 'text', text: 'pong' }], structuredContent: { response: 'pong' } };
    },
  };
}

// Starts the real express app on an ephemeral port and connects a real MCP
// client over streamable HTTP, so the transport wiring is exercised too.
async function withServer(registryOverride, run) {
  const fleetApi = createMockFleetApi();
  const app = createMcpHttpApp({
    buildServer: () => buildMcpServer({ fleetApi, registry: registryOverride }),
  });
  const httpServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
  });
  const url = new URL(`http://127.0.0.1:${httpServer.address().port}/mcp`);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      await run({ client, fleetApi });
    } finally {
      await client.close();
    }
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
}

async function within(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('startMcpServer rejects a real port collision', async () => {
  const occupyingServer = createHttpServer();
  occupyingServer.listen(0, '127.0.0.1');
  await once(occupyingServer, 'listening');

  try {
    const port = occupyingServer.address().port;
    await assert.rejects(
      within(
        startMcpServer({ fleetApi: createMockFleetApi(), port }),
        1_000,
        'timed out waiting for the port collision to reject',
      ),
      (err) => err?.code === 'EADDRINUSE',
    );
  } finally {
    await new Promise((resolve) => occupyingServer.close(resolve));
  }
});

test('startMcpServer removes its startup error listener after listening', async () => {
  const { server, close } = await startMcpServer({ fleetApi: createMockFleetApi(), port: 0 });
  try {
    assert.equal(server.listenerCount('error'), 0);
  } finally {
    await close();
  }
});

test('advertises exactly the registry tools, with schemas and annotations', async () => {
  await withServer(undefined, async ({ client }) => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['demo', 'inspect-members']);

    const inspect = tools.find((tool) => tool.name === 'inspect-members');
    assert.deepEqual(Object.keys(inspect.inputSchema.properties).sort(), ['includeFiles', 'members']);
    assert.deepEqual(inspect.inputSchema.properties.members.items.enum, [
      'DEMO-DOER',
      'DEMO-REVIEWER',
    ]);
    assert.equal(inspect.annotations.readOnlyHint, true);

    const demo = tools.find((tool) => tool.name === 'demo');
    assert.deepEqual(demo.inputSchema.properties ?? {}, {});
    assert.equal(demo.annotations.readOnlyHint, false);
  });
});

test('calling demo runs the workflow', async () => {
  await withServer(undefined, async ({ client, fleetApi }) => {
    const result = await client.callTool({ name: 'demo' });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /demo workflow completed/);
    assert.ok(fleetApi.promptCalls.length >= 1, 'the agent phase should have run');
  });
});

test('calling inspect-members with one member touches only that member', async () => {
  await withServer(undefined, async ({ client, fleetApi }) => {
    const result = await client.callTool({
      name: 'inspect-members',
      arguments: { members: ['DEMO-DOER'] },
    });
    assert.equal(result.isError, undefined);
    assert.equal(fleetApi.commandCalls.length, 1);
    assert.equal(fleetApi.commandCalls[0].member_name, 'DEMO-DOER');

    const report = JSON.parse(result.content[0].text);
    assert.deepEqual(report.members.map((entry) => entry.name), ['DEMO-DOER']);
  });
});

test('a throwing workflow returns isError and the server keeps serving', async () => {
  const registry = [
    {
      name: 'boom',
      description: 'always throws',
      async run() {
        throw new Error('workflow exploded');
      },
    },
    {
      name: 'fine',
      description: 'always works',
      async run() {
        return 'still here';
      },
    },
  ];
  await withServer(registry, async ({ client }) => {
    const failed = await client.callTool({ name: 'boom' });
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /workflow exploded/);

    const after = await client.callTool({ name: 'fine' });
    assert.equal(after.isError, undefined);
    assert.equal(after.content[0].text, 'still here');
  });
});

test('invalid arguments are rejected before the workflow runs', async () => {
  let ran = false;
  const registry = [
    {
      name: 'typed',
      description: 'takes a number',
      inputSchema: z.object({ count: z.number() }),
      async run() {
        ran = true;
        return 'ok';
      },
    },
  ];
  await withServer(registry, async ({ client }) => {
    const result = await client.callTool({ name: 'typed', arguments: { count: 'nope' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /count/);
    assert.equal(ran, false, 'run must not be called with invalid arguments');
  });
});

test('an unknown tool name fails cleanly', async () => {
  await withServer(undefined, async ({ client }) => {
    await assert.rejects(() => client.callTool({ name: 'no-such-tool' }));
  });
});

test('a client requesting progress receives a heartbeat per phase', async () => {
  await withServer(undefined, async ({ client }) => {
    const updates = [];
    const result = await client.callTool(
      { name: 'inspect-members', arguments: {} },
      { onprogress: (update) => updates.push(update) },
    );
    assert.equal(result.isError, undefined);
    assert.ok(updates.length >= 1, 'expected at least one progress notification');
    assert.ok(
      updates.every((update, index) => index === 0 || update.progress > updates[index - 1].progress),
      'progress must strictly increase',
    );
  });
});

test('a client that does not request progress still gets the result', async () => {
  await withServer(undefined, async ({ client }) => {
    const result = await client.callTool({ name: 'inspect-members', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.ok(JSON.parse(result.content[0].text).members.length >= 1);
  });
});

test('disconnecting a client closes the request server and aborts its workflow', async () => {
  let resolveStarted;
  let resolveAborted;
  let resolveClosed;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  const aborted = new Promise((resolve) => {
    resolveAborted = resolve;
  });
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const registry = [
    {
      name: 'slow',
      description: 'waits for cancellation',
      async run({ signal }) {
        resolveStarted();
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        resolveAborted();
        return 'cancelled';
      },
    },
  ];
  const fleetApi = createMockFleetApi();
  const app = createMcpHttpApp({
    buildServer: () => {
      const server = buildMcpServer({ fleetApi, registry });
      server.server.onclose = resolveClosed;
      return server;
    },
  });
  const httpServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
  });

  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'slow', arguments: {} },
  });
  const request = httpRequest({
    hostname: '127.0.0.1',
    port: httpServer.address().port,
    path: '/mcp',
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    },
  });
  request.on('error', () => {});
  request.end(body);

  try {
    await within(started, 1_000, 'timed out waiting for workflow to start');
    request.destroy();
    await within(
      Promise.all([closed, aborted]),
      1_000,
      'timed out waiting for request cleanup to abort the workflow',
    );
  } finally {
    request.destroy();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
