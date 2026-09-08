import * as z from 'zod/v4';
import { runDemo } from '../workflows/demo/main.mjs';
import { runInspectMembers } from '../workflows/inspect-members/main.mjs';

// Routable workflows. To expose a new tool, append an entry here — no changes to
// server.mjs or http.mjs are needed. `description` is read by the connected
// model when it decides which tool to call, so write it for that reader.
export const defaultRegistry = [
  {
    name: 'demo',
    description:
      'Runs the demo workflow end to end: fleet status, the dummy python command, ' +
      'the transform, and an agent smoke test. DEMO-DOER is registered when Fleet is spawned. ' +
      'Choose this to run the demo workflow or to verify that Fleet plumbing works. ' +
      'Spends LLM tokens and can take a minute.',
    annotations: { readOnlyHint: false, idempotentHint: true },
    async run({ fleetApi, signal, reportPhase }) {
      const result = await runDemo({ fleetApi, signal, reportPhase });
      return `demo workflow completed: ${JSON.stringify(result)}`;
    },
  },
  {
    name: 'inspect-members',
    description:
      "Reports on this repo's Fleet members: which are registered, and what is in each " +
      'work folder on the Fleet host. Choose this to check fleet health or to see what a ' +
      'member has been doing. Read-only and spends no LLM tokens.',
    inputSchema: z.object({
      members: z
        .array(z.enum(['DEMO-DOER', 'DEMO-REVIEWER']))
        .optional()
        .describe(
          'Member names to inspect. Defaults to DEMO-DOER and DEMO-REVIEWER.',
        ),
      includeFiles: z
        .boolean()
        .optional()
        .describe('Include a capped listing of top-level entries in each work folder.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args, signal, reportPhase }) {
      return await runInspectMembers({
        fleetApi,
        members: args.members,
        includeFiles: args.includeFiles,
        signal,
        reportPhase,
      });
    },
  },
];
