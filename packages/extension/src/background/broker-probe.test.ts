import { describe, expect, it, vi } from 'vitest';
import { deriveBrokerHealthUrl, probeBrokerHealth } from './broker-probe.js';

describe('broker-probe', () => {
  it('derives loopback /health URLs from ws:// and wss:// endpoints', () => {
    expect(deriveBrokerHealthUrl('ws://127.0.0.1:43179/ws')).toBe('http://127.0.0.1:43179/health');
    expect(deriveBrokerHealthUrl('wss://localhost:43179/ws?foo=bar#baz')).toBe(
      'https://localhost:43179/health',
    );
    expect(deriveBrokerHealthUrl('ws://[::1]:43179/ws')).toBe('http://[::1]:43179/health');
    expect(deriveBrokerHealthUrl('http://127.0.0.1:43179/ws')).toBeNull();
    expect(deriveBrokerHealthUrl('not a url')).toBeNull();
  });

  it('returns true when /health responds with 200 OK', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const ok = await probeBrokerHealth('ws://127.0.0.1:43179/ws', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:43179/health',
      expect.objectContaining({ method: 'GET', cache: 'no-store' }),
    );
  });

  it('returns false silently when broker port refuses connections or returns non-OK', async () => {
    const refused = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(
      probeBrokerHealth('ws://127.0.0.1:43179/ws', {
        fetchImpl: refused as unknown as typeof fetch,
      }),
    ).resolves.toBe(false);

    const unhealthy = vi.fn(async () => new Response('down', { status: 503 }));
    await expect(
      probeBrokerHealth('ws://127.0.0.1:43179/ws', {
        fetchImpl: unhealthy as unknown as typeof fetch,
      }),
    ).resolves.toBe(false);
  });
});
