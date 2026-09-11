import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureApralabs } from '../workflows/demo/ensure-apralabs.mjs';
import { createWorkerDispatcher } from '../pool/index.mjs';
import { buildMcpServer } from '../mcp/server.mjs';
import { authenticate as defaultAuthenticate } from '../mcp/auth.mjs';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { createPooledFleetApi } from '../pool/pooled-fleet-api.mjs';
import { loadConfig } from './config.mjs';
import { extendRegistry } from './tools/registry.mjs';
import { executeTool } from './tools/executor.mjs';
import { createExpressAdapter } from '../comm/express.mjs';

const SUPPORTED_ADAPTERS = { express: createExpressAdapter };

function resolveAdapter(name) {
  const factory = SUPPORTED_ADAPTERS[name];
  if (!factory) throw new Error(`unsupported comm adapter: "${name}"`);
  return factory();
}

function defaultConfigDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

// Thin entry point mirroring startMcpServer's injection pattern.
// Accepts optional fleetApi + dispatcher for testing. When omitted, spawns
// Fleet and creates the dispatcher from the pool, same as mcp/main.mjs.
export async function startHost({
  fleetApi,
  dispatcher,
  port,
  env = process.env,
  registry,
  configDir,
  authenticate = defaultAuthenticate,
} = {}) {
  ensureApralabs();

  let config;
  try {
    config = await loadConfig(configDir ?? defaultConfigDir(), env);
  } catch {
    config = {
      name: 'workflow-kit',
      description: '',
      fleet: {},
      comm: { adapter: 'express', port: port ?? Number(env.PORT ?? 3000), host: env.MCP_BIND_HOST ?? '127.0.0.1' },
      modules: {},
    };
  }

  let api = fleetApi;
  let stopFleet = null;
  if (!api) {
    const { spawnFleet } = await import('../transport/stdio-fleet.mjs');
    const fleet = await spawnFleet({ env });
    api = fleet.fleetApi;
    stopFleet = fleet.stop;
  }

  let ownDispatcher = null;
  let activeDispatcher = dispatcher;
  if (!activeDispatcher) {
    try {
      activeDispatcher = ownDispatcher = await createWorkerDispatcher({ fleetApi: api, env });
    } catch (err) {
      try { await stopFleet?.(); } catch { /* preserve original error */ }
      throw err;
    }
  }

  const toolRegistry = registry ?? extendRegistry();

  const mcpHandler = async (req, res) => {
    const server = buildMcpServer({
      fleetApi: api,
      dispatcher: activeDispatcher,
      registry: toolRegistry,
    });
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } finally {
      await server.close();
    }
  };

  const adapter = resolveAdapter(config.comm.adapter);
  const listenPort = port ?? config.comm.port;
  const bindHost = config.comm.host;

  try {
    await adapter.start({
      routes: {
        mcp: mcpHandler,
        task: null,
        jobs: null,
        health: (req, res) => res.json({ ok: true }),
      },
      port: listenPort,
      host: bindHost,
      authenticate,
    });
  } catch (err) {
    try { await ownDispatcher?.close(); } catch { /* preserve */ }
    try { await stopFleet?.(); } catch { /* preserve */ }
    throw err;
  }

  console.log(
    `host '${config.name}' listening on http://${bindHost}:${adapter.port()} ` +
    `(worker capacity ${activeDispatcher.capacity})`,
  );

  async function callTool(name, args = {}, { signal } = {}) {
    const tool = toolRegistry.find(t => t.name === name);
    if (!tool) {
      return { ok: false, error: 'not_found', message: `tool "${name}" not found` };
    }
    const lease = await activeDispatcher.dispatch({ signal });
    try {
      return await executeTool(tool, {
        fleetApi: createPooledFleetApi(api, lease),
        args,
        signal: lease.signal ?? signal,
        reportPhase: () => {},
        workspace: { workerId: lease.workerId, doer: lease.doer, reviewer: lease.reviewer },
      });
    } finally {
      await lease.release();
    }
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    activeDispatcher.beginShutdown();
    await adapter.stop();
    await ownDispatcher?.close();
    await stopFleet?.();
  };

  return {
    host: adapter,
    callTool,
    close,
    config,
    registry: toolRegistry,
  };
}

// Builder API — sugar over startHost.
export function createHost(options = {}) {
  let overrides = { ...options };

  const builder = {
    tools(registry)   { overrides.registry = registry; return builder; },
    comm(commConfig)  { Object.assign(overrides, commConfig); return builder; },
    build() {
      return {
        start: () => startHost(overrides),
      };
    },
  };
  return builder;
}

// Main module guard — same pattern as mcp/main.mjs.
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  try {
    const { close } = await startHost();
    const shutdown = async () => { await close(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error(err?.message ?? err);
    process.exit(1);
  }
}
