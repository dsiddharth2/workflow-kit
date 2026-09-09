import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod/v4';
import { runDemo } from '../workflows/demo/main.mjs';
import { runInspectMembers } from '../workflows/inspect-members/main.mjs';
import { runCityBriefing } from '../workflows/city-briefing/main.mjs';

const toolsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tools',
);

function parseToolOutput(raw) {
  let text;
  if (typeof raw === 'string') {
    text = raw;
  } else if (raw?.structuredContent?.stdout) {
    text = raw.structuredContent.stdout;
  } else if (raw?.content?.[0]?.text) {
    text = raw.content[0].text;
  } else {
    text = raw?.output ?? '';
  }
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: 'failed to parse tool output', raw: text };
  }
}

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
  {
    name: 'city-briefing',
    description:
      'Fetches live weather, local time, and composes a short city briefing using an agent. ' +
      'Uses three internal tools (weather API, timezone API, text stats) and one agent prompt. ' +
      'Spends LLM tokens.',
    inputSchema: z.object({
      city: z
        .string()
        .optional()
        .describe('City name to brief on. Defaults to London.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: false },
    async run({ fleetApi, args, signal, reportPhase }) {
      const result = await runCityBriefing({
        fleetApi,
        city: args.city,
        signal,
        reportPhase,
      });
      return `city briefing completed: ${JSON.stringify(result)}`;
    },
  },
  {
    name: 'weather',
    description:
      'Fetches current weather for a city using the wttr.in API. Returns temperature, ' +
      'humidity, wind, UV index, and a text description. Read-only, no LLM tokens.',
    inputSchema: z.object({
      city: z
        .string()
        .optional()
        .describe('City name to look up. Defaults to London.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args }) {
      const city = args.city || 'London';
      const script = path.join(toolsDir, 'weather', 'weather.py');
      const raw = await fleetApi.executeCommand({
        member_name: 'DEMO-DOER',
        command: `python3 "${script}" "${city}"`,
      });
      return parseToolOutput(raw);
    },
  },
  {
    name: 'timezone',
    description:
      'Fetches the current local time and timezone for a city using the World Time API. ' +
      'Returns datetime, UTC offset, and abbreviation. Read-only, no LLM tokens.',
    inputSchema: z.object({
      city: z
        .string()
        .optional()
        .describe('City name to look up. Defaults to London.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args }) {
      const city = args.city || 'London';
      const script = path.join(toolsDir, 'timezone', 'timezone.py');
      const raw = await fleetApi.executeCommand({
        member_name: 'DEMO-DOER',
        command: `python3 "${script}" "${city}"`,
      });
      return parseToolOutput(raw);
    },
  },
  {
    name: 'textstats',
    description:
      'Analyzes a text string and returns character count, word count, sentence count, ' +
      'unique words, and average word length. Read-only, no LLM tokens.',
    inputSchema: z.object({
      text: z
        .string()
        .describe('The text to analyze.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args }) {
      const escaped = args.text.replace(/"/g, '\\"').replace(/\n/g, ' ');
      const script = path.join(toolsDir, 'textstats', 'textstats.py');
      const raw = await fleetApi.executeCommand({
        member_name: 'DEMO-DOER',
        command: `python3 "${script}" "${escaped}"`,
      });
      return parseToolOutput(raw);
    },
  },
];
