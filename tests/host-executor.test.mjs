// tests/host-executor.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod/v4';

const { executeTool } = await import('../host/tools/executor.mjs');

const mockFleetApi = {};

function makeTool(overrides = {}) {
  return {
    name: 'test-tool',
    timeout: 5000,
    run: async () => 'ok',
    ...overrides,
  };
}

test('successful tool call returns { ok: true, result }', async () => {
  const tool = makeTool({ run: async () => ({ answer: 42 }) });
  const out = await executeTool(tool, { fleetApi: mockFleetApi, args: {} });
  assert.equal(out.ok, true);
  assert.deepEqual(out.result, { answer: 42 });
});

test('invalid args returns validation_failed', async () => {
  const tool = makeTool({
    inputSchema: z.object({ city: z.string() }),
  });
  const out = await executeTool(tool, { fleetApi: mockFleetApi, args: { city: 123 } });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'validation_failed');
  assert.ok(out.details);
});

test('valid args pass validation and run executes', async () => {
  const tool = makeTool({
    inputSchema: z.object({ city: z.string() }),
    run: async ({ args }) => `weather in ${args.city}`,
  });
  const out = await executeTool(tool, { fleetApi: mockFleetApi, args: { city: 'London' } });
  assert.equal(out.ok, true);
  assert.equal(out.result, 'weather in London');
});

test('tool without inputSchema skips validation', async () => {
  const tool = makeTool({ run: async ({ args }) => args.anything });
  const out = await executeTool(tool, { fleetApi: mockFleetApi, args: { anything: 'goes' } });
  assert.equal(out.ok, true);
  assert.equal(out.result, 'goes');
});

test('thrown error returns tool_error', async () => {
  const tool = makeTool({ run: async () => { throw new Error('boom'); } });
  const out = await executeTool(tool, { fleetApi: mockFleetApi, args: {} });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'tool_error');
  assert.equal(out.message, 'boom');
});

test('timeout returns error', async () => {
  const tool = makeTool({
    timeout: 50,
    run: async ({ signal }) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 10_000);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      });
    },
  });
  const out = await executeTool(tool, { fleetApi: mockFleetApi, args: {} });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'timeout');
});

test('caller abort signal is respected', async () => {
  const ac = new AbortController();
  const tool = makeTool({
    timeout: 60_000,
    run: async ({ signal }) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 10_000);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      });
    },
  });
  setTimeout(() => ac.abort(), 50);
  const out = await executeTool(tool, { fleetApi: mockFleetApi, args: {}, signal: ac.signal });
  assert.equal(out.ok, false);
  assert.match(out.error, /timeout|abort/);
});

test('missing or invalid timeout returns error-as-value rather than throwing', async () => {
  const invalid = makeTool({
    timeout: 'not-a-number',
    run: async () => 'ok',
  });
  const invalidOut = await executeTool(invalid, { fleetApi: mockFleetApi, args: {} });
  assert.equal(invalidOut.ok, false);
  assert.equal(typeof invalidOut.error, 'string');

  const missing = makeTool({ run: async () => { throw new Error('should be wrapped'); } });
  delete missing.timeout;
  const missingOut = await executeTool(missing, { fleetApi: mockFleetApi, args: {} });
  assert.equal(missingOut.ok, false);
  assert.equal(typeof missingOut.error, 'string');
});

test('run throwing null returns tool_error', async () => {
  const tool = makeTool({
    run: async () => { throw null; },
  });
  const out = await executeTool(tool, { fleetApi: mockFleetApi, args: {} });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'tool_error');
});

test('extra context is passed through to run()', async () => {
  let received;
  const tool = makeTool({
    run: async (ctx) => { received = ctx; return 'ok'; },
  });
  await executeTool(tool, {
    fleetApi: mockFleetApi,
    args: { x: 1 },
    reportPhase: 'test-phase',
    workspace: { workerId: 'w-1' },
  });
  assert.equal(received.fleetApi, mockFleetApi);
  assert.deepEqual(received.args, { x: 1 });
  assert.equal(received.reportPhase, 'test-phase');
  assert.deepEqual(received.workspace, { workerId: 'w-1' });
  assert.ok(received.signal);
});
