// comm/express.mjs
import { createMcpExpressApp } from '@modelcontextprotocol/express';

export function createExpressAdapter() {
  let server = null;

  return {
    async start({ routes, port, host, authenticate }) {
      const app = createMcpExpressApp();

      if (routes.health) app.get('/health', routes.health);
      if (routes.mcp)    app.post('/mcp', authenticate, routes.mcp);
      if (routes.task)   app.post('/task', authenticate, routes.task);
      if (routes.jobs)   app.get('/jobs/:id', authenticate, routes.jobs);

      server = app.listen(port, host);
      await new Promise((resolve, reject) => {
        const onListening = () => { server.off('error', onError); resolve(); };
        const onError = (err) => { server.off('listening', onListening); reject(err); };
        server.once('listening', onListening);
        server.once('error', onError);
      });
    },

    port() {
      return server?.address()?.port;
    },

    address() {
      return server?.address();
    },

    async stop() {
      if (!server) return;
      await new Promise(resolve => server.close(resolve));
      server = null;
    },
  };
}
