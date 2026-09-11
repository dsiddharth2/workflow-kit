// comm/interface.mjs
//
// Every comm adapter must implement this shape:
//
//   {
//     async start({ routes, port, host, authenticate })
//     async stop()
//   }
//
// routes is an object with named handlers. Null or undefined routes are not
// mounted. The adapter provides the HTTP framework; the handlers provide logic.
//
//   routes.mcp     POST /mcp      — MCP protocol
//   routes.task    POST /task     — task submission (Phase 2)
//   routes.jobs    GET  /jobs/:id — job status (Phase 4)
//   routes.health  GET  /health   — health check
//
// authenticate is an Express-compatible middleware function (req, res, next).
