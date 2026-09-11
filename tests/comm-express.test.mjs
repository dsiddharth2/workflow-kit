// tests/comm-express.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';

const { createExpressAdapter } = await import('../comm/express.mjs');

function authenticate(req, res, next) {
  req.user = { id: 'test' };
  next();
}

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpPost(port, path, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

test('health route returns ok', async () => {
  const adapter = createExpressAdapter();
  await adapter.start({
    routes: {
      health: (req, res) => res.json({ ok: true }),
      mcp: null,
      task: null,
      jobs: null,
    },
    port: 0,
    host: '127.0.0.1',
    authenticate,
  });
  try {
    const res = await httpGet(adapter.port(), '/health');
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
  } finally {
    await adapter.stop();
  }
});

test('mcp route calls handler with auth', async () => {
  let called = false;
  const adapter = createExpressAdapter();
  await adapter.start({
    routes: {
      health: null,
      mcp: (req, res) => { called = true; res.json({ received: true }); },
      task: null,
      jobs: null,
    },
    port: 0,
    host: '127.0.0.1',
    authenticate,
  });
  try {
    const res = await httpPost(adapter.port(), '/mcp', { test: 1 });
    assert.equal(res.status, 200);
    assert.ok(called);
  } finally {
    await adapter.stop();
  }
});

test('null routes are not mounted', async () => {
  const adapter = createExpressAdapter();
  await adapter.start({
    routes: { health: (req, res) => res.json({ ok: true }), mcp: null, task: null, jobs: null },
    port: 0,
    host: '127.0.0.1',
    authenticate,
  });
  try {
    const res = await httpPost(adapter.port(), '/mcp', {});
    assert.notEqual(res.status, 200);
  } finally {
    await adapter.stop();
  }
});

test('stop() closes the server', async () => {
  const adapter = createExpressAdapter();
  await adapter.start({
    routes: { health: (req, res) => res.json({ ok: true }), mcp: null, task: null, jobs: null },
    port: 0,
    host: '127.0.0.1',
    authenticate,
  });
  await adapter.stop();
  await assert.rejects(() => httpGet(adapter.port(), '/health'), /ECONNREFUSED/);
});

test('task route is mounted when provided', async () => {
  let taskBody;
  const adapter = createExpressAdapter();
  await adapter.start({
    routes: {
      health: null,
      mcp: null,
      task: (req, res) => { taskBody = req.body; res.json({ queued: true }); },
      jobs: null,
    },
    port: 0,
    host: '127.0.0.1',
    authenticate,
  });
  try {
    const res = await httpPost(adapter.port(), '/task', { goal: 'test' });
    assert.equal(res.status, 200);
    assert.deepEqual(taskBody, { goal: 'test' });
  } finally {
    await adapter.stop();
  }
});

test('jobs route is mounted when provided', async () => {
  let jobId;
  const adapter = createExpressAdapter();
  await adapter.start({
    routes: {
      health: null,
      mcp: null,
      task: null,
      jobs: (req, res) => { jobId = req.params.id; res.json({ status: 'done' }); },
    },
    port: 0,
    host: '127.0.0.1',
    authenticate,
  });
  try {
    const res = await httpGet(adapter.port(), '/jobs/abc-123');
    assert.equal(res.status, 200);
    assert.equal(jobId, 'abc-123');
  } finally {
    await adapter.stop();
  }
});
