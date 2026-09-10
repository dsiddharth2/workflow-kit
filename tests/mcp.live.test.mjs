import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const { startMcpServer } = await import('../mcp/main.mjs');

// Spawns real Fleet over stdio. Spends no LLM tokens: inspect-members makes
// no agent() call. Needs the apra-fleet binary. The leased pair is a pool
// worker (WORKER-{i}-DOER / -REVIEWER), not the retired DEMO members.
test('inspect-members reports on live members over MCP', { timeout: 180000 }, async () => {
  const { server, close } = await startMcpServer({ port: 0 });
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  const client = new Client({ name: 'live-test-client', version: '1.0.0' });

  try {
    await client.connect(new StreamableHTTPClientTransport(url));

    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['demo', 'inspect-members']);

    const result = await client.callTool({ name: 'inspect-members', arguments: {} });
    assert.equal(result.isError, undefined, `tool call failed: ${result.content?.[0]?.text}`);

    const report = JSON.parse(result.content[0].text);
    assert.match(report.workerId, /^(pool|ephemeral)-/);
    assert.deepEqual(
      report.members.map((entry) => entry.role),
      ['doer', 'reviewer'],
    );
    assert.match(report.members[0].name, /^WORKER-\d+-DOER$/);
    assert.match(report.members[1].name, /^WORKER-\d+-REVIEWER$/);
    for (const member of report.members) {
      assert.equal(member.present, true, `${member.name} should be registered`);
      assert.equal(member.report.exists, true, `${member.name} work folder should exist`);
    }
  } finally {
    try {
      await client.close();
    } finally {
      await close();
    }
  }
});
