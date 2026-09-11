// tests/host.live.test.mjs
import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const { startHost } = await import('../host/index.mjs');

test('host serves inspect-members over MCP with live Fleet', { timeout: 180000 }, async () => {
  const { host, close } = await startHost({ port: 0 });
  const url = new URL(`http://127.0.0.1:${host.port()}/mcp`);
  const client = new Client({ name: 'live-test-client', version: '1.0.0' });

  try {
    await client.connect(new StreamableHTTPClientTransport(url));

    const { tools } = await client.listTools();
    assert.ok(tools.some(t => t.name === 'inspect-members'));
    assert.ok(tools.some(t => t.name === 'demo'));

    const result = await client.callTool({ name: 'inspect-members', arguments: {} });
    assert.equal(result.isError, undefined, `tool call failed: ${result.content?.[0]?.text}`);

    const report = JSON.parse(result.content[0].text);
    assert.match(report.workerId, /^(pool|ephemeral)-/);
    assert.deepEqual(
      report.members.map(entry => entry.role),
      ['doer', 'reviewer'],
    );
    for (const member of report.members) {
      assert.equal(member.present, true, `${member.name} should be registered`);
      assert.equal(member.report.exists, true, `${member.name} work folder should exist`);
    }
  } finally {
    try { await client.close(); } finally { await close(); }
  }
});

test('host callTool works with live Fleet', { timeout: 180000 }, async () => {
  const { callTool, close } = await startHost({ port: 0 });

  try {
    const out = await callTool('inspect-members', {});
    assert.equal(out.ok, true);
    const report = out.result;
    const parsed = typeof report === 'string' ? JSON.parse(report) : report;
    assert.match(parsed.workerId, /^(pool|ephemeral)-/);
  } finally {
    await close();
  }
});
