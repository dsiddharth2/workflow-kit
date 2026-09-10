import { McpServer } from '@modelcontextprotocol/server';
import { createPooledFleetApi } from '../pool/pooled-fleet-api.mjs';
import { defaultRegistry } from './registry.mjs';

const SERVER_INFO = { name: 'workflow-kit', version: '1.0.0' };

function toToolResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

// Progress notifications are only legal when the client sent a progressToken,
// and `progress` must increase on every one. With no token this is a no-op, so
// workflow bodies can call reportPhase unconditionally.
function makePhaseReporter(ctx) {
  const progressToken = ctx.mcpReq._meta?.progressToken;
  let progress = 0;
  return async (message) => {
    if (progressToken === undefined) return;
    progress += 1;
    await ctx.mcpReq.notify({
      method: 'notifications/progress',
      params: { progressToken, progress, message },
    });
  };
}

export function buildMcpServer({ fleetApi, dispatcher, registry = defaultRegistry } = {}) {
  if (!fleetApi) throw new Error('buildMcpServer requires fleetApi');
  if (!dispatcher) throw new Error('buildMcpServer requires dispatcher');
  const server = new McpServer(SERVER_INFO);

  for (const entry of registry) {
    const config = { description: entry.description };
    if (entry.inputSchema) config.inputSchema = entry.inputSchema;
    if (entry.annotations) config.annotations = entry.annotations;

    // Every call holds exactly one worker pair for its duration. A thrown
    // error is turned into an isError result by the SDK, so there is
    // deliberately no try/catch -- only the finally that returns the lease.
    const invoke = async (args, ctx) => {
      const reportPhase = makePhaseReporter(ctx);
      const lease = await dispatcher.dispatch({ signal: ctx.mcpReq.signal, reportPhase });
      try {
        return toToolResult(
          await entry.run({
            fleetApi: createPooledFleetApi(fleetApi, lease),
            args,
            signal: lease.signal,
            reportPhase,
            workspace: { workerId: lease.workerId, doer: lease.doer, reviewer: lease.reviewer },
          }),
        );
      } finally {
        await lease.release();
      }
    };

    // The SDK passes (args, ctx) only when inputSchema is declared; without one
    // the context arrives as the single argument.
    server.registerTool(
      entry.name,
      config,
      entry.inputSchema ? (args, ctx) => invoke(args ?? {}, ctx) : (ctx) => invoke({}, ctx),
    );
  }

  return server;
}
