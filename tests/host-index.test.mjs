// tests/host-index.test.mjs
import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { WorkerDispatcher } from '../pool/worker-dispatcher.mjs';
import { WorkerPool } from '../pool/worker-pool.mjs';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';

const { startHost, createHost } = await import('../host/index.mjs');

function mockPayloadForCommand(command) {
  if (command.includes('weather.py')) {
    return JSON.stringify({
      ok: true, location: 'London', temp_c: '15', temp_f: '59',
      feels_like_c: '14', humidity: '72', description: 'Cloudy',
      wind_speed_kmph: '11', wind_dir: 'WSW', visibility_km: '10', uv_index: '3',
    });
  }
  if (command.includes('timezone.py')) {
    return JSON.stringify({
      ok: true, timezone: 'Europe/London', datetime: '2025-06-15T14:30:00+01:00',
      utc_offset: '+01:00', day_of_week: 0, abbreviation: 'BST',
    });
  }
  if (command.includes('textstats.py')) {
    return JSON.stringify({
      ok: true, char_count: 26, word_count: 5,
      sentence_count: 1, unique_words: 5, avg_word_length: 4.2,
    });
  }
  return JSON.stringify({ root: '/tmp/x', exists: true, fileCount: 1, totalBytes: 4 });
}

function makeMockFleetApi() {
  return createMockFleetApi({
    members: rosterNames(2),
    commandPayload: (options) => mockPayloadForCommand(options.command ?? ''),
  });
}

async function makeDispatcher() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'host-test-pool-'));
  return new WorkerDispatcher({
    pool: WorkerPool.create({ config: { size: 2, root, acquireTimeoutMs: 5000 } }),
    ephemeral: null,
    config: { maxQueueSize: 4, queueTimeoutMs: 5000 },
  });
}

test('startHost boots and serves tools via MCP', async () => {
  const fleetApi = makeMockFleetApi();
  const dispatcher = await makeDispatcher();
  const { host, close } = await startHost({ fleetApi, dispatcher, port: 0 });

  const url = new URL(`http://127.0.0.1:${host.port()}/mcp`);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(url));
    const { tools } = await client.listTools();
    assert.ok(tools.some(t => t.name === 'inspect-members'));
    assert.ok(tools.some(t => t.name === 'demo'));
    assert.ok(tools.some(t => t.name === 'weather'));
    assert.ok(tools.some(t => t.name === 'city-briefing'));

    const result = await client.callTool({ name: 'inspect-members', arguments: {} });
    assert.equal(result.isError, undefined, `tool call failed: ${result.content?.[0]?.text}`);
  } finally {
    try { await client.close(); } finally { await close(); }
  }
});

test('startHost health endpoint returns ok', async () => {
  const fleetApi = makeMockFleetApi();
  const dispatcher = await makeDispatcher();
  const { host, close } = await startHost({ fleetApi, dispatcher, port: 0 });

  try {
    const res = await new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1', port: host.port(), path: '/health', method: 'GET',
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  } finally {
    await close();
  }
});

test('callTool returns result through executor path', async () => {
  const fleetApi = makeMockFleetApi();
  const dispatcher = await makeDispatcher();
  const { callTool, close } = await startHost({ fleetApi, dispatcher, port: 0 });

  try {
    const out = await callTool('inspect-members', {});
    assert.equal(out.ok, true);
    assert.ok(out.result);
  } finally {
    await close();
  }
});

test('callTool returns error for unknown tool', async () => {
  const fleetApi = makeMockFleetApi();
  const dispatcher = await makeDispatcher();
  const { callTool, close } = await startHost({ fleetApi, dispatcher, port: 0 });

  try {
    const out = await callTool('nonexistent-tool', {});
    assert.equal(out.ok, false);
    assert.match(out.error, /not_found|unknown/i);
  } finally {
    await close();
  }
});

test('close shuts down cleanly', async () => {
  const fleetApi = makeMockFleetApi();
  const dispatcher = await makeDispatcher();
  const { host, close } = await startHost({ fleetApi, dispatcher, port: 0 });
  const port = host.port();
  await close();
  await assert.rejects(
    () => new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, path: '/health', method: 'GET' },
        resolve);
      req.on('error', reject);
      req.end();
    }),
    /ECONNREFUSED/,
  );
});

test('startHost rethrows loadConfig failures', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'host-bad-config-'));
  await fs.writeFile(path.join(dir, 'host.config.mjs'), `export default {
    fleet: {},
    comm: { adapter: 'express' },
  };`);
  const fleetApi = makeMockFleetApi();
  const dispatcher = await makeDispatcher();
  await assert.rejects(
    () => startHost({ fleetApi, dispatcher, port: 0, configDir: dir }),
    /name/i,
  );
});

test('createHost.comm applies bind host and stop aliases close', async () => {
  const fleetApi = makeMockFleetApi();
  const dispatcher = await makeDispatcher();
  const { start } = createHost({ fleetApi, dispatcher })
    .comm({ port: 0, host: '127.0.0.1' })
    .tools(undefined)
    .build();
  const started = await start();
  const port = started.host.port();
  try {
    assert.equal(started.stop, started.close);
    const res = await new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1', port, path: '/health', method: 'GET', agent: false,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  } finally {
    await started.stop();
  }
  await assert.rejects(
    () => new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1', port, path: '/health', method: 'GET',
      }, resolve);
      req.on('error', reject);
      req.end();
    }),
    /ECONNREFUSED/,
  );
});

test('callTool maps dispatch failures to error-as-value', async () => {
  const fleetApi = makeMockFleetApi();
  const dispatcher = await makeDispatcher();
  dispatcher.dispatch = async () => {
    throw new Error('queue overflow');
  };
  const { callTool, close } = await startHost({ fleetApi, dispatcher, port: 0 });
  try {
    const out = await callTool('inspect-members', {});
    assert.equal(out.ok, false);
    assert.ok(out.error);
    assert.ok(out.message);
  } finally {
    await close();
  }
});

test('listen failure stops the adapter', async () => {
  let stopped = false;
  const fakeAdapter = {
    async start() { throw new Error('listen failed'); },
    async stop() { stopped = true; },
    port() { return undefined; },
  };
  const fleetApi = makeMockFleetApi();
  const dispatcher = await makeDispatcher();
  await assert.rejects(
    () => startHost({
      fleetApi,
      dispatcher,
      createAdapter: () => fakeAdapter,
    }),
    /listen failed/,
  );
  assert.equal(stopped, true);
});
