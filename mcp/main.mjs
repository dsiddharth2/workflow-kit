import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWorkerDispatcher } from '../pool/index.mjs';
import { ensureApralabs } from '../workflows/demo/ensure-apralabs.mjs';
import { createMcpHttpApp } from './http.mjs';
import { buildMcpServer } from './server.mjs';

export async function startMcpServer({ fleetApi, dispatcher, port, env = process.env, registry } = {}) {
  ensureApralabs();

  let api = fleetApi;
  let stopFleet = null;
  if (!api) {
    const { spawnFleet } = await import('../transport/stdio-fleet.mjs');
    // No memberName: registration and OAuth are MemberManager's job.
    const fleet = await spawnFleet({ env });
    api = fleet.fleetApi;
    stopFleet = fleet.stop;
  }

  // One dispatcher per process, built once at startup. A roster failure here
  // is deliberately fatal: better a loud startup error than an agent() call
  // failing deep inside a run.
  let ownDispatcher = null;
  let activeDispatcher = dispatcher;
  if (!activeDispatcher) {
    try {
      activeDispatcher = ownDispatcher = await createWorkerDispatcher({ fleetApi: api, env });
    } catch (err) {
      try {
        await stopFleet?.();
      } catch {
        // Preserve the dispatcher error after best-effort Fleet cleanup.
      }
      throw err;
    }
  }

  const app = createMcpHttpApp({
    buildServer: () => buildMcpServer({ fleetApi: api, dispatcher: activeDispatcher, registry }),
  });
  const listenPort = port ?? Number(env.PORT ?? 3000);
  const bindHost = env.MCP_BIND_HOST || '127.0.0.1';
  let server;
  try {
    server = app.listen(listenPort, bindHost);
    await new Promise((resolve, reject) => {
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      const onError = (err) => {
        server.off('listening', onListening);
        reject(err);
      };
      server.once('listening', onListening);
      server.once('error', onError);
    });
  } catch (err) {
    if (server) {
      try {
        await new Promise((resolve) => server.close(() => resolve()));
      } catch {
        // Preserve the listener error after best-effort HTTP cleanup.
      }
    }
    try {
      await ownDispatcher?.close();
    } catch {
      // Preserve the listener error after best-effort dispatcher cleanup.
    }
    try {
      await stopFleet?.();
    } catch {
      // Preserve the listener error after best-effort Fleet cleanup.
    }
    throw err;
  }
  console.log(
    `MCP server listening on http://${bindHost}:${server.address().port}/mcp ` +
      `(worker capacity ${activeDispatcher.capacity})`,
  );

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    // Fail queued waiters first so HTTP drain is not stuck behind queueTimeoutMs.
    activeDispatcher.beginShutdown();
    await new Promise((resolve) => server.close(resolve));
    await ownDispatcher?.close();
    await stopFleet?.();
  };
  return { server, close };
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  try {
    const { close } = await startMcpServer();
    const shutdown = async () => {
      await close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error(err?.message ?? err);
    process.exit(1);
  }
}
