/**
 * Pre-flight HTTP `/health` probe for the local broker daemon.
 *
 * In Chrome Manifest V3 Service Workers, calling `new WebSocket("ws://127.0.0.1:43179/ws")`
 * while the local broker is stopped causes Blink to emit an un-suppressible
 * `WebSocket connection to ... failed: net::ERR_CONNECTION_REFUSED` console error
 * with a service-worker stack trace, which Chrome surfaces in `chrome://extensions` → Errors.
 *
 * Probing `GET /health` via `fetch()` first (caught silently in JS) avoids opening a WebSocket
 * against a closed port and keeps `chrome://extensions` clean whenever the broker is offline
 * or restarting.
 */

export function deriveBrokerHealthUrl(wsUrl: string): string | null {
  try {
    const parsed = new URL(wsUrl);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      return null;
    }
    parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
    parsed.pathname = '/health';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

export async function probeBrokerHealth(
  wsUrl: string,
  options?: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  },
): Promise<boolean> {
  const healthUrl = deriveBrokerHealthUrl(wsUrl);
  if (!healthUrl) return false;

  const fetchFn = options?.fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') return false;

  const timeoutMs = options?.timeoutMs ?? 1200;
  try {
    const signal =
      typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(timeoutMs)
        : undefined;
    const res = await fetchFn(healthUrl, {
      method: 'GET',
      cache: 'no-store',
      signal,
    });
    return Boolean(res.ok);
  } catch {
    return false;
  }
}
