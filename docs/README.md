# Documentation

| Document | Read it when |
|---|---|
| [architecture.md](architecture.md) | You want to understand what this repo is, how the layers fit together, and why the non-obvious decisions were made. Start here — it includes a primer on Fleet concepts for people who have never used Fleet. |
| [development.md](development.md) | You are setting up, running tests, adding a workflow, or debugging a failure. |
| [mcp-interface.md](mcp-interface.md) | You are setting up or extending the MCP server — tool catalog, registry contract, timeouts, auth, and hosting. |
| [specs/2026-09-09-fleet-agent-kit-spec.md](specs/2026-09-09-fleet-agent-kit-spec.md) | You want to see what has been built, the development roadmap, and where the project is heading. |

### Specs

Design documents for features that have been implemented or proposed.

| Spec | Status | Covers |
|---|---|---|
| [specs/stdio-transport-spec.md](specs/stdio-transport-spec.md) | Implemented | Spawning Fleet over stdio (the current downstream transport). |
| [specs/stdio-transport-plan.md](specs/stdio-transport-plan.md) | Implemented | Task-by-task implementation plan that landed the stdio design. |
| [specs/concurrency-spec.md](specs/concurrency-spec.md) | Implemented | Original shared worker pool design (superseded by tiered dispatch). |
| [specs/concurrency-plan.md](specs/concurrency-plan.md) | Implemented | Implementation plan for the worker pool. |
| [specs/2026-09-10-tiered-worker-dispatch-design.md](specs/2026-09-10-tiered-worker-dispatch-design.md) | Implemented | Tiered worker dispatch: pool + ephemeral + queue. |
| [specs/2026-09-10-tiered-worker-dispatch-plan.md](specs/2026-09-10-tiered-worker-dispatch-plan.md) | Implemented | Implementation plan for tiered dispatch. |
| [specs/2026-09-09-fleet-agent-kit-spec.md](specs/2026-09-09-fleet-agent-kit-spec.md) | Proposed | Future vision: evolving workflow-kit into a modular Fleet Agent Kit. |

The [root README](../README.md) is the quickstart: prerequisites, provisioning, and the commands to run things.
