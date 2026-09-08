import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureApralabs } from '../workflows/demo/ensure-apralabs.mjs';
import { createMcpHttpApp } from './http.mjs';
import { buildMcpServer } from './server.mjs';

export async function startMcpServer({ fleetApi, port } = {}) {
  ensureApralabs();

  let api = fleetApi;
  let stopFleet = null;
  if (!api) {
    const { spawnFleet, ensureRegistered } = await import('../transport/stdio-fleet.mjs');
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const workdir = path.join(repoRoot, 'workdir');
    const fleet = await spawnFleet({
      memberName: 'DEMO-DOER',
      workFolder: path.join(workdir, 'DEMO-DOER'),
    });
    api = fleet.fleetApi;
    stopFleet = fleet.stop;

    // Register the reviewer too — inspect-members reports on both, and the
    // provisioning script no longer runs at startup.
    await ensureRegistered(api, 'DEMO-REVIEWER', path.join(workdir, 'DEMO-REVIEWER'));
  }

  const app = createMcpHttpApp({ buildServer: () => buildMcpServer({ fleetApi: api }) });
  const listenPort = port ?? Number(process.env.PORT ?? 3000);
  const bindHost = process.env.MCP_BIND_HOST || '127.0.0.1';
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
      await stopFleet?.();
    } catch {
      // Preserve the listener error after best-effort Fleet cleanup.
    }
    throw err;
  }
  console.log(`MCP server listening on http://${bindHost}:${server.address().port}/mcp`);

  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
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
