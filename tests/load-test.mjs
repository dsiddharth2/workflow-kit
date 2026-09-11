#!/usr/bin/env node
// Live load test for the tiered worker dispatch system.
// Starts the real MCP server (requires Fleet running), fires concurrent tool
// calls, and reports which tier served each request with timing.
//
// Usage:
//   node tests/load-test.mjs                    # defaults: 20 concurrent city-briefing calls
//   node tests/load-test.mjs --concurrency 30   # push past pool+ephemeral into queue
//   node tests/load-test.mjs --tool inspect-members --concurrency 15  # cheaper, no LLM tokens
//   node tests/load-test.mjs --city Paris        # city-briefing for Paris
//   node tests/load-test.mjs --waves 3          # run 3 waves back-to-back
//   node tests/load-test.mjs --hold 2000        # each call holds the worker for 2s (synthetic delay)
//
// Environment variables (override worker config):
//   WORKER_POOL_SIZE         default 4
//   WORKER_EPHEMERAL_MAX     default 10
//   WORKER_DISPATCH_QUEUE_SIZE       default 20
//   WORKER_DISPATCH_QUEUE_TIMEOUT_MS default 300000

import './setup-fleet-modules.mjs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startMcpServer } from '../mcp/main.mjs';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    concurrency: 20,
    tool: 'city-briefing',
    city: 'London',
    waves: 1,
    hold: 0,
    port: 0,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--concurrency' && args[i + 1]) opts.concurrency = Number(args[++i]);
    if (args[i] === '--tool' && args[i + 1]) opts.tool = args[++i];
    if (args[i] === '--city' && args[i + 1]) opts.city = args[++i];
    if (args[i] === '--waves' && args[i + 1]) opts.waves = Number(args[++i]);
    if (args[i] === '--hold' && args[i + 1]) opts.hold = Number(args[++i]);
    if (args[i] === '--port' && args[i + 1]) opts.port = Number(args[++i]);
    if (args[i] === '--help') {
      console.log(`Usage: node tests/load-test.mjs [options]
  --concurrency N   concurrent requests per wave (default: 20)
  --tool NAME       MCP tool to call (default: city-briefing)
  --city NAME       city for city-briefing tool (default: London)
  --waves N         number of sequential waves (default: 1)
  --hold MS         synthetic hold time per call in ms (default: 0)
  --port N          MCP server port (default: random)`);
      process.exit(0);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Single MCP tool call — returns timing + result metadata
// ---------------------------------------------------------------------------
async function callOnce(mcpUrl, toolName, toolArgs, callId) {
  const start = performance.now();
  let dispatchedAt = null;
  let workerId = null;
  let tier = null;
  let error = null;
  let queueMessages = [];

  const client = new Client({ name: `load-${callId}`, version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(mcpUrl));
    dispatchedAt = performance.now();

    const result = await client.callTool(
      { name: toolName, arguments: toolArgs },
      {
        onprogress(update) {
          if (update.message?.startsWith('queued')) {
            queueMessages.push({ time: performance.now() - start, message: update.message });
          }
        },
      },
    );

    const done = performance.now();

    if (result.isError) {
      error = result.content?.[0]?.text ?? 'unknown error';
    } else {
      const allText = (result.content ?? []).map((p) => p.text ?? '').join('\n');
      const workerMatch = allText.match(/\[worker:([\w-]+)\]/);
      if (workerMatch) workerId = workerMatch[1];
    }

    if (workerId) {
      if (workerId.startsWith('pool-')) tier = 'pool';
      else if (workerId.startsWith('ephemeral-')) tier = 'ephemeral';
      else tier = 'unknown';
    }

    return {
      callId,
      workerId,
      tier,
      error,
      connectMs: Math.round(dispatchedAt - start),
      totalMs: Math.round(done - start),
      dispatchMs: Math.round(done - dispatchedAt),
      queued: queueMessages.length > 0,
      queueMessages,
    };
  } catch (err) {
    return {
      callId,
      workerId: null,
      tier: null,
      error: err?.message ?? String(err),
      connectMs: dispatchedAt ? Math.round(dispatchedAt - start) : null,
      totalMs: Math.round(performance.now() - start),
      dispatchMs: null,
      queued: queueMessages.length > 0,
      queueMessages,
    };
  } finally {
    try { await client.close(); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// Wave runner
// ---------------------------------------------------------------------------
async function runWave(mcpUrl, toolName, toolArgs, concurrency, waveNum) {
  console.log(`\n--- Wave ${waveNum}: ${concurrency} concurrent calls to "${toolName}" ---\n`);
  const waveStart = performance.now();
  const promises = [];
  for (let i = 0; i < concurrency; i++) {
    promises.push(callOnce(mcpUrl, toolName, toolArgs, `w${waveNum}-${i + 1}`));
  }
  const results = await Promise.all(promises);
  const waveMs = Math.round(performance.now() - waveStart);
  return { results, waveMs };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
function printReport(wave, waveNum, config) {
  const { results, waveMs } = wave;

  const succeeded = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);
  const queued = results.filter((r) => r.queued);

  const byTier = { pool: [], ephemeral: [], unknown: [] };
  for (const r of succeeded) {
    (byTier[r.tier] ?? byTier.unknown).push(r);
  }

  const byWorker = {};
  for (const r of succeeded) {
    byWorker[r.workerId] = (byWorker[r.workerId] ?? 0) + 1;
  }

  console.log('┌─────────────────────────────────────────────────────┐');
  console.log(`│  Wave ${waveNum} Results                                     │`);
  console.log('├─────────────────────────────────────────────────────┤');
  console.log(`│  Config: pool=${config.poolSize}, ephemeral=${config.ephemeralMax}, queue=${config.queueSize}`);
  console.log(`│  Total capacity: ${config.poolSize + config.ephemeralMax} concurrent (${config.poolSize} pool + ${config.ephemeralMax} ephemeral)`);
  console.log(`│  Concurrency: ${results.length} requests`);
  console.log(`│  Wall time: ${waveMs}ms`);
  console.log('├─────────────────────────────────────────────────────┤');
  console.log(`│  ✓ Succeeded: ${succeeded.length}`);
  console.log(`│  ✗ Failed:    ${failed.length}`);
  console.log(`│  ⏳ Queued:    ${queued.length}`);
  console.log('├─────────────────────────────────────────────────────┤');
  console.log('│  Tier breakdown:');
  console.log(`│    pool:      ${byTier.pool.length} calls`);
  console.log(`│    ephemeral: ${byTier.ephemeral.length} calls`);
  if (byTier.unknown.length > 0) {
    console.log(`│    unknown:   ${byTier.unknown.length} calls`);
  }
  console.log('├─────────────────────────────────────────────────────┤');
  console.log('│  Worker distribution:');
  const sortedWorkers = Object.entries(byWorker).sort((a, b) => {
    if (a[0].startsWith('pool') && !b[0].startsWith('pool')) return -1;
    if (!a[0].startsWith('pool') && b[0].startsWith('pool')) return 1;
    return a[0].localeCompare(b[0]);
  });
  for (const [id, count] of sortedWorkers) {
    const bar = '█'.repeat(count);
    console.log(`│    ${id.padEnd(22)} ${String(count).padStart(3)} ${bar}`);
  }

  if (succeeded.length > 0) {
    const latencies = succeeded.map((r) => r.dispatchMs).sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p90 = latencies[Math.floor(latencies.length * 0.9)];
    const p99 = latencies[Math.floor(latencies.length * 0.99)];
    const min = latencies[0];
    const max = latencies[latencies.length - 1];
    console.log('├─────────────────────────────────────────────────────┤');
    console.log('│  Latency (dispatch → result):');
    console.log(`│    min: ${min}ms  p50: ${p50}ms  p90: ${p90}ms  p99: ${p99}ms  max: ${max}ms`);
  }

  if (failed.length > 0) {
    console.log('├─────────────────────────────────────────────────────┤');
    console.log('│  Failures:');
    for (const r of failed.slice(0, 5)) {
      const msg = r.error.length > 60 ? r.error.slice(0, 60) + '...' : r.error;
      console.log(`│    ${r.callId}: ${msg}`);
    }
    if (failed.length > 5) {
      console.log(`│    ... and ${failed.length - 5} more`);
    }
  }

  console.log('└─────────────────────────────────────────────────────┘');

  // Per-call detail table
  console.log('\n  Call details:');
  console.log('  ' + 'call'.padEnd(12) + 'tier'.padEnd(12) + 'worker'.padEnd(24) + 'dispatch'.padEnd(12) + 'total'.padEnd(10) + 'queued');
  console.log('  ' + '─'.repeat(78));
  for (const r of results) {
    const tierStr = r.error ? 'FAILED' : r.tier;
    const workerStr = r.workerId ?? r.error?.slice(0, 22) ?? '—';
    const dispStr = r.dispatchMs != null ? `${r.dispatchMs}ms` : '—';
    const totalStr = `${r.totalMs}ms`;
    const qStr = r.queued ? `yes (${r.queueMessages.length} msgs)` : 'no';
    console.log('  ' + r.callId.padEnd(12) + tierStr.padEnd(12) + workerStr.padEnd(24) + dispStr.padEnd(12) + totalStr.padEnd(10) + qStr);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const opts = parseArgs();

console.log('Starting MCP server with live Fleet connection...');
const poolSize = Number(process.env.WORKER_POOL_SIZE ?? 4);
const ephemeralMax = Number(process.env.WORKER_EPHEMERAL_MAX ?? 10);
const queueSize = Number(process.env.WORKER_DISPATCH_QUEUE_SIZE ?? 20);

const config = { poolSize, ephemeralMax, queueSize };

let mcpHandle;
try {
  mcpHandle = await startMcpServer({ port: opts.port });
} catch (err) {
  console.error(`Failed to start MCP server: ${err?.message ?? err}`);
  console.error('Make sure Fleet is running (apra-fleet start)');
  process.exit(1);
}

const port = mcpHandle.server.address().port;
const mcpUrl = new URL(`http://127.0.0.1:${port}/mcp`);
console.log(`MCP server ready at ${mcpUrl} (capacity: ${poolSize + ephemeralMax})`);

let toolName = opts.tool;
const toolArgs = {};
if (toolName === 'city-briefing') toolArgs.city = opts.city;
if (opts.hold > 0) {
  console.log(`Synthetic hold: each call will hold the worker for ${opts.hold}ms`);
}

console.log(`Tool: ${toolName}${toolArgs.city ? ` (city: ${toolArgs.city})` : ''}`);

try {
  for (let w = 1; w <= opts.waves; w++) {
    const wave = await runWave(mcpUrl, toolName, toolArgs, opts.concurrency, w);
    printReport(wave, w, config);
  }
} finally {
  console.log('\nShutting down MCP server...');
  await mcpHandle.close();
  console.log('Done.');
}
