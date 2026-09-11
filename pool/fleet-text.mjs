// Every Fleet call returns an MCP envelope (content[] / structuredContent),
// so text extraction is a shared helper rather than inline property access.
export function toolText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  const response = result.structuredContent?.response;
  if (typeof response === 'string' && response.length > 0) return response;
  const parts = result.content ?? [];
  if (parts.length > 0) {
    return parts.map((part) => part.text ?? '').join('\n');
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

// Matching must be token-exact. `WORKER-1-DOER` is a substring of
// `WORKER-11-DOER`, so includes() would report a missing worker as present
// once the pool size reaches double digits.
const BOUNDARY = '[^A-Za-z0-9_-]';

export function memberIsPresent(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|${BOUNDARY})${escaped}($|${BOUNDARY})`).test(String(text));
}

// Fleet reports failures two ways: an MCP isError envelope, or a text body
// starting with ❌ / ERROR:. Both mean the call did not do what it was asked.
export function toolResultLooksFailed(result) {
  if (result?.isError) return true;
  return /^\s*(❌|ERROR:)/m.test(toolText(result));
}
