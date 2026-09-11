// host/tools/executor.mjs

export async function executeTool(tool, { fleetApi, args, signal, ...rest }) {
  if (tool.inputSchema) {
    const result = tool.inputSchema.safeParse(args);
    if (!result.success) {
      return { ok: false, error: 'validation_failed', details: result.error };
    }
  }

  try {
    const timeoutMs = tool.timeout ?? 300_000;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const merged = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;

    const result = await tool.run({ fleetApi, args, signal: merged, ...rest });
    return { ok: true, result };
  } catch (err) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      return { ok: false, error: 'timeout', message: `exceeded ${tool.timeout}ms` };
    }
    return { ok: false, error: 'tool_error', message: String(err?.message ?? err) };
  }
}
