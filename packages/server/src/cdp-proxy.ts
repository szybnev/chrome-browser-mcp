import type { IncomingMessage, ServerResponse } from 'node:http';
import { APP_VERSION, isUrlBlocked } from '@chrome-browser-mcp/protocol';
import type { WebSocket } from 'ws';
import type { BrowserBrokerHub } from './hub.js';

export function handleCdpDiscoveryRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  hub: BrowserBrokerHub,
  brokerUrl: string,
  brokerToken: string,
): boolean {
  if (req.method !== 'GET') return false;
  if (url.pathname !== '/json/version' && url.pathname !== '/json/list' && url.pathname !== '/json') {
    return false;
  }

  if (!hub.getPolicy().cdpProxyEnabled) {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        ok: false,
        error:
          'Local CDP Proxy is disabled. Start daemon with --enable-cdp-proxy or enable it in Security -> Advanced Settings.',
      }),
    );
    return true;
  }

  const headerToken = req.headers['x-broker-token'];
  const queryToken = url.searchParams.get('token');
  const candidate = typeof headerToken === 'string' ? headerToken : (queryToken ?? '');
  if (!hub.verifyToken(candidate)) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({ ok: false, error: 'Unauthorized CDP proxy token (pass ?token= or x-broker-token)' }),
    );
    return true;
  }

  const wsBase = brokerUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');

  if (url.pathname === '/json/version') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        Browser: `Chrome-Browser-MCP/${APP_VERSION}`,
        'Protocol-Version': '1.3',
        'User-Agent': `Chrome-Browser-MCP/${APP_VERSION}`,
        'V8-Version': process.versions.v8,
        webSocketDebuggerUrl: `${wsBase}/cdp/browser?token=${encodeURIComponent(brokerToken)}`,
      }),
    );
    return true;
  }

  // /json or /json/list — expose ONLY scoped non-blocked tabs
  void (async () => {
    const state = await hub.getDeckState();
    const policy = hub.getPolicy();
    const targets: Array<Record<string, unknown>> = [];

    for (const [profileId, tabs] of Object.entries(state.tabs)) {
      for (const tab of tabs) {
        if (policy.scopeMode === 'agent-group' && !tab.inAgentGroup) continue;
        if (isUrlBlocked(tab.url, policy.blockedDomains, policy.allowedDomains).blocked) continue;
        targets.push({
          id: `${profileId}:${tab.tabId}`,
          type: 'page',
          title: tab.title,
          url: tab.url,
          webSocketDebuggerUrl: `${wsBase}/cdp/${tab.tabId}?profileId=${encodeURIComponent(profileId)}&token=${encodeURIComponent(brokerToken)}`,
        });
      }
    }

    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(targets));
  })();
  return true;
}

export function attachCdpProxySocket(
  ws: WebSocket,
  tabId: number,
  profileId: string | undefined,
  hub: BrowserBrokerHub,
): void {
  ws.on('message', (raw) => {
    void (async () => {
      let id: number | string | undefined;
      try {
        const msg = JSON.parse(raw.toString('utf8')) as {
          id?: number | string;
          method?: string;
          params?: Record<string, unknown>;
        };
        id = msg.id;
        if (!msg.method) {
          ws.send(JSON.stringify({ id, error: { code: -32600, message: 'Missing CDP method' } }));
          return;
        }
        const { data } = await hub.callExtension(
          'cdp.raw',
          { tabId, method: msg.method, params: msg.params ?? {} },
          { profileId, toolLabel: `cdp_proxy:${msg.method}` },
        );
        ws.send(JSON.stringify({ id, result: data ?? {} }));
      } catch (err) {
        ws.send(
          JSON.stringify({
            id,
            error: {
              code: -32000,
              message: err instanceof Error ? err.message : String(err),
            },
          }),
        );
      }
    })();
  });
}
