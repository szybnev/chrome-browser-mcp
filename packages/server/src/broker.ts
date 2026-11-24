import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ExtensionToBrokerMessageSchema, isUrlBlocked } from '@chrome-browser-mcp/protocol';
import {
  localhostHostValidation,
  localhostOriginValidation,
  NodeStreamableHTTPServerTransport,
} from '@modelcontextprotocol/node';
import { WebSocketServer } from 'ws';
import { attachCdpProxySocket, handleCdpDiscoveryRequest } from './cdp-proxy.js';
import { type BrokerConfig, loadBrokerConfig } from './config.js';
import { BrowserBrokerHub, SERVER_VERSION } from './hub.js';
import { createBrowserMcpServer } from './mcp-server.js';

export interface BrokerDaemonHandle {
  config: BrokerConfig;
  hub: BrowserBrokerHub;
  createPairingPin: () => { pin: string; expiresAt: number };
  close: () => Promise<void>;
}

const LEASE_TTL_MS = 45_000;
const IDLE_GRACE_MS = 20_000;
const PIN_TTL_MS = 120_000;
const MAX_PIN_ATTEMPTS = 5;
const MAX_JSON_BODY_BYTES = 10 * 1024 * 1024;
const WS_HANDSHAKE_TIMEOUT_MS = 5_000;

class HttpBodyError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

const EXT_ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/;

function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const trimmed = hostHeader.trim().toLowerCase();
  return (
    /^127\.0\.0\.1(?::\d{1,5})?$/.test(trimmed) ||
    /^localhost(?::\d{1,5})?$/.test(trimmed) ||
    /^\[::1\](?::\d{1,5})?$/.test(trimmed)
  );
}

function extractBearerOrBrokerToken(req: IncomingMessage): string {
  const headerToken = req.headers['x-broker-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim();
  }
  return '';
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    const host = parsed.hostname.toLowerCase();
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]')
    );
  } catch {
    return false;
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      throw new HttpBodyError(413, 'Request body exceeds 10 MB limit');
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpBodyError(400, 'Malformed JSON request body');
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export async function startBrokerDaemon(options?: {
  port?: number;
  dataDir?: string;
  idleExit?: boolean;
  enableCdpProxy?: boolean;
}): Promise<BrokerDaemonHandle> {
  const config = loadBrokerConfig({ port: options?.port, dataDir: options?.dataDir });
  const hub = new BrowserBrokerHub(config.dataDir, config.brokerUrl, config.token);
  if (options?.enableCdpProxy) {
    await hub.updatePolicy({ cdpProxyEnabled: true });
  }
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  // Separate scoped CDP token so ?token= in /json/version never leaks the master brokerToken
  const cdpToken = randomBytes(24).toString('hex');
  const verifyCdpToken = (candidate: string) =>
    typeof candidate === 'string' && candidate.length > 0 && timingSafeStringEqual(candidate, cdpToken);

  let activePin: { code: string; expiresAt: number; attempts: number } | null = null;
  const createPairingPin = () => {
    const code = String(randomInt(100000, 1000000));
    const expiresAt = Date.now() + PIN_TTL_MS;
    activePin = { code, expiresAt, attempts: 0 };
    return { pin: code, expiresAt };
  };
  hub.setPinFactory(createPairingPin);

  const leases = new Map<string, number>();
  let hadLeases = false;
  let idleExitTimer: NodeJS.Timeout | null = null;

  const scheduleIdleCheck = () => {
    if (!options?.idleExit) return;
    const now = Date.now();
    for (const [id, expiresAt] of leases.entries()) {
      if (expiresAt < now) leases.delete(id);
    }
    if (hadLeases && leases.size === 0) {
      if (!idleExitTimer) {
        idleExitTimer = setTimeout(() => {
          if (leases.size === 0) {
            void close();
          }
        }, IDLE_GRACE_MS);
      }
    } else if (idleExitTimer) {
      clearTimeout(idleExitTimer);
      idleExitTimer = null;
    }
  };

  const leaseSweeper = setInterval(scheduleIdleCheck, 10_000);
  leaseSweeper.unref();

  const httpServer = createServer(async (req, res) => {
    try {
      if (!validateHost(req, res)) return;

      const url = new URL(req.url ?? '/', config.brokerUrl);

      // Allow strict 32-char chrome-extension:// origin ONLY for PIN exchange & /health (NEVER /mcp or /internal/*)
      const originHeader = req.headers.origin;
      const isExtOrigin = typeof originHeader === 'string' && EXT_ORIGIN_RE.test(originHeader);
      const isExtAllowedRoute = url.pathname === '/pair/exchange' || url.pathname === '/health';

      if (req.method === 'OPTIONS' && isExtOrigin && isExtAllowedRoute) {
        res.writeHead(204, {
          'access-control-allow-origin': originHeader,
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
        });
        res.end();
        return;
      }

      if (!(isExtOrigin && isExtAllowedRoute) && !validateOrigin(req, res)) return;

      // Public loopback health endpoint (never leaks token)
      if (req.method === 'GET' && url.pathname === '/health') {
        const { profiles, defaultProfileId } = await hub.listProfiles();
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          ...(isExtOrigin ? { 'access-control-allow-origin': originHeader } : {}),
        });
        res.end(
          JSON.stringify({
            ok: true,
            version: SERVER_VERSION,
            mcpUrl: config.mcpUrl,
            wsUrl: config.wsUrl,
            defaultProfileId,
            connectedProfiles: profiles.length,
            paused: hub.isPaused(),
            activeLeases: leases.size,
            cdpProxyEnabled: hub.getPolicy().cdpProxyEnabled,
          }),
        );
        return;
      }

      // Informational local pairing helper page (never mints PINs unauthenticated)
      if (req.method === 'GET' && url.pathname === '/pair') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-frame-options': 'DENY',
          'cross-origin-resource-policy': 'same-origin',
          'content-security-policy':
            "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
        });
        res.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="dark light">
<title>Chrome Browser MCP — Local Pairing</title>
<style>
  :root { --bg:#111317; --surface:#181b21; --surface2:#1f232c; --border:#2b313e; --text:#e6e9ef; --muted:#9aa3b2; --accent:#2563eb; }
  @media (prefers-color-scheme: light) { :root { --bg:#f5f7fa; --surface:#fff; --surface2:#f0f2f6; --border:#d8dee9; --text:#151922; --muted:#5a6475; --accent:#2563eb; } }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; background:var(--bg); color:var(--text); font:14px/1.5 system-ui,-apple-system,sans-serif; }
  .card { width:100%; max-width:520px; background:var(--surface); border:1px solid var(--border); border-radius:16px; padding:24px; box-shadow:0 16px 40px rgba(0,0,0,0.28); }
  h1 { margin:0 0 8px; font-size:19px; }
  p, li { color:var(--muted); font-size:13px; }
  ol { padding-left:20px; margin:12px 0; }
  li { margin-bottom:8px; }
  code { background:var(--surface2); border:1px solid var(--border); padding:2px 6px; border-radius:6px; font-family:ui-monospace,monospace; font-size:12px; color:var(--text); }
</style></head><body>
<div class="card">
  <h1>Chrome Browser MCP — Secure Local Pairing</h1>
  <p>Local broker is running on <code>${config.brokerUrl}</code>. For security, one-time 6-digit PINs can only be minted by an authenticated local host holding your broker token:</p>
  <ol>
    <li><strong>In Antigravity:</strong> Open <strong>Browser Control Deck</strong> and click <strong>Generate PIN</strong> in the top bar.</li>
    <li><strong>Or in your terminal</strong> (inside the cloned repository): run <code>node packages/server/dist/cli.js pair</code>.</li>
  </ol>
  <p>Then paste the 6-digit PIN into the Chrome Browser MCP Welcome Wizard or Side Panel → Pair tab.</p>
</div></body></html>`);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/pair/exchange') {
        const corsHeaders: Record<string, string> = {
          'content-type': 'application/json; charset=utf-8',
          ...(isExtOrigin ? { 'access-control-allow-origin': originHeader } : {}),
        };
        const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
        if (!contentType.includes('application/json')) {
          res.writeHead(415, corsHeaders);
          res.end(JSON.stringify({ ok: false, error: 'Content-Type must be application/json' }));
          return;
        }
        const body = (await readJsonBody(req)) as { pin?: string };
        const submitted = String(body.pin ?? '').trim();
        if (!activePin || Date.now() > activePin.expiresAt) {
          activePin = null;
          res.writeHead(401, corsHeaders);
          res.end(
            JSON.stringify({
              ok: false,
              error: 'No active pairing PIN — generate one in Browser Deck or via CLI pair',
            }),
          );
          return;
        }
        if (activePin.attempts >= MAX_PIN_ATTEMPTS) {
          activePin = null;
          res.writeHead(429, corsHeaders);
          res.end(JSON.stringify({ ok: false, error: 'Too many PIN attempts — generate a new PIN' }));
          return;
        }
        activePin.attempts += 1;
        if (!timingSafeStringEqual(submitted, activePin.code)) {
          res.writeHead(401, corsHeaders);
          res.end(JSON.stringify({ ok: false, error: 'Incorrect 6-digit PIN' }));
          return;
        }
        activePin = null; // Single-use PIN consumed
        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify({ ok: true, data: { token: config.token, wsUrl: config.wsUrl } }));
        return;
      }

      // Opt-in Local CDP Proxy discovery (/json/version, /json/list) — scoped cdpToken
      if (handleCdpDiscoveryRequest(req, res, url, hub, config.brokerUrl, cdpToken, verifyCdpToken)) {
        return;
      }

      // Streamable HTTP MCP Endpoint (requires broker token authentication)
      if (url.pathname === '/mcp') {
        const mcpToken = extractBearerOrBrokerToken(req);
        if (!hub.verifyToken(mcpToken)) {
          writeJson(res, 401, {
            ok: false,
            error: 'Unauthorized: pass Authorization: Bearer <token> or x-broker-token header.',
          });
          return;
        }
        const mcpServer = createBrowserMcpServer(hub);
        const transport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        res.on('close', () => {
          void transport.close();
          void mcpServer.close();
        });
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }

      // Internal authenticated endpoints for stdio shims & CLI
      if (url.pathname.startsWith('/internal/')) {
        const headerToken = req.headers['x-broker-token'];
        if (typeof headerToken !== 'string' || !hub.verifyToken(headerToken)) {
          writeJson(res, 401, { ok: false, error: 'Unauthorized broker token' });
          return;
        }

        const body = (await readJsonBody(req)) as Record<string, unknown>;

        switch (url.pathname) {
          case '/internal/lease': {
            const leaseId = typeof body.leaseId === 'string' ? body.leaseId : randomUUID();
            if (body.release === true) {
              leases.delete(leaseId);
              scheduleIdleCheck();
              writeJson(res, 200, { ok: true, data: { released: true } });
            } else {
              hadLeases = true;
              leases.set(leaseId, Date.now() + LEASE_TTL_MS);
              scheduleIdleCheck();
              writeJson(res, 200, { ok: true, data: { leaseId } });
            }
            return;
          }
          case '/internal/deck-state':
            writeJson(res, 200, { ok: true, data: await hub.getDeckState() });
            return;
          case '/internal/profiles':
            writeJson(res, 200, { ok: true, data: await hub.listProfiles() });
            return;
          case '/internal/select-profile':
            writeJson(res, 200, {
              ok: true,
              data: await hub.selectDefaultProfile(String(body.profileId ?? '')),
            });
            return;
          case '/internal/set-paused':
            writeJson(res, 200, { ok: true, data: await hub.setPaused(Boolean(body.paused)) });
            return;
          case '/internal/update-policy':
            writeJson(res, 200, { ok: true, data: await hub.updatePolicy(body) });
            return;
          case '/internal/resolve-approval':
            writeJson(res, 200, {
              ok: true,
              data: await hub.resolveApproval(
                String(body.approvalId ?? ''),
                body.decision === 'approved' ? 'approved' : 'rejected',
              ),
            });
            return;
          case '/internal/call-extension': {
            const result = await hub.callExtension(
              body.method as never,
              (body.params as Record<string, unknown>) ?? {},
              body.options as never,
            );
            writeJson(res, 200, { ok: true, data: result });
            return;
          }
          case '/internal/request-approval':
            await hub.requestApprovalIfNeeded(body as never);
            writeJson(res, 200, { ok: true, data: { approved: true } });
            return;
          case '/internal/record-screenshot':
            hub.recordScreenshot(body as never);
            writeJson(res, 200, { ok: true, data: { recorded: true } });
            return;
          case '/internal/workflows':
            writeJson(res, 200, { ok: true, data: await hub.listWorkflows() });
            return;
          case '/internal/delete-workflow':
            writeJson(res, 200, {
              ok: true,
              data: await hub.deleteWorkflow(String(body.workflowId ?? '')),
            });
            return;
          case '/internal/create-pin':
            writeJson(res, 200, { ok: true, data: createPairingPin() });
            return;
          case '/internal/policy':
            writeJson(res, 200, { ok: true, data: await hub.getLivePolicy() });
            return;
          case '/internal/tab-url': {
            const pId = typeof body.profileId === 'string' ? body.profileId : undefined;
            const tId = typeof body.tabId === 'number' ? body.tabId : undefined;
            const foundUrl = await hub.getLiveTabUrl(pId, tId);
            writeJson(res, 200, { ok: true, data: { url: foundUrl ?? null } });
            return;
          }
          case '/internal/audit-export': {
            const fmt = body.format === 'html' ? 'html' : 'json';
            writeJson(res, 200, { ok: true, data: await hub.exportAudit(fmt) });
            return;
          }
          case '/internal/clear-diagnostics': {
            const target = body.target === 'console' || body.target === 'network' ? body.target : 'all';
            await hub.clearDiagnostics(target);
            writeJson(res, 200, { ok: true, data: { cleared: target } });
            return;
          }
          default:
            writeJson(res, 404, { ok: false, error: 'Unknown internal route' });
            return;
        }
      }

      writeJson(res, 404, {
        ok: false,
        error: 'Not found. Use POST /mcp for Streamable HTTP MCP or GET /health.',
      });
    } catch (err) {
      if (err instanceof HttpBodyError) {
        writeJson(res, err.status, { ok: false, error: err.message });
        return;
      }
      writeJson(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // WebSocket server on /ws for Chrome Extensions & opt-in /cdp/:tabId proxy
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const cdpWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  httpServer.on('upgrade', (req, socket, head) => {
    try {
      const remote = req.socket.remoteAddress;
      if (remote && remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
        socket.destroy();
        return;
      }
      if (!isLoopbackHostHeader(req.headers.host)) {
        socket.destroy();
        return;
      }

      const url = new URL(req.url ?? '/', config.brokerUrl);
      const originHeader = req.headers.origin;

      if (url.pathname === '/ws') {
        // Allow absent Origin (Node clients), loopback origins, or strict 32-char chrome-extension:// ONLY
        if (
          typeof originHeader === 'string' &&
          originHeader.length > 0 &&
          !EXT_ORIGIN_RE.test(originHeader) &&
          !isLoopbackOrigin(originHeader)
        ) {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
        return;
      }

      const cdpTabMatch = /^\/cdp\/(\d+)$/.exec(url.pathname);
      const isCdpBrowser = url.pathname === '/cdp/browser';
      if ((cdpTabMatch || isCdpBrowser) && hub.getPolicy().cdpProxyEnabled) {
        // Reject cross-site browser origins on CDP WebSocket upgrades (CSWSH protection)
        if (typeof originHeader === 'string' && originHeader.length > 0 && !isLoopbackOrigin(originHeader)) {
          socket.destroy();
          return;
        }
        const tokenParam = url.searchParams.get('token') ?? '';
        const headerToken = req.headers['x-broker-token'];
        const candidate = typeof headerToken === 'string' ? headerToken : tokenParam;
        if (!verifyCdpToken(candidate) && !hub.verifyToken(candidate)) {
          socket.destroy();
          return;
        }
        const profileId = url.searchParams.get('profileId') ?? undefined;

        const upgradeToTab = (tabId: number) => {
          cdpWss.handleUpgrade(req, socket, head, (ws) => {
            attachCdpProxySocket(ws, tabId, profileId, hub);
          });
        };

        if (cdpTabMatch) {
          upgradeToTab(Number(cdpTabMatch[1]));
          return;
        }

        // /cdp/browser: resolve first scoped non-blocked agent tab
        void (async () => {
          try {
            const state = await hub.getDeckState();
            const targetProfile = profileId ?? state.defaultProfileId ?? state.profiles[0]?.profileId;
            const tabs = targetProfile ? (state.tabs[targetProfile] ?? []) : [];
            const scoped = (
              state.policy.scopeMode === 'agent-group' ? tabs.filter((t) => t.inAgentGroup) : tabs
            ).filter(
              (t) => !isUrlBlocked(t.url, state.policy.blockedDomains, state.policy.allowedDomains).blocked,
            );
            const chosen = scoped.find((t) => t.active) ?? scoped[0];
            if (!chosen) {
              socket.destroy();
              return;
            }
            upgradeToTab(chosen.tabId);
          } catch {
            socket.destroy();
          }
        })();
        return;
      }

      socket.destroy();
    } catch {
      socket.destroy();
    }
  });

  wss.on('connection', (ws) => {
    const handshakeTimer = setTimeout(() => {
      if (!hub.isSocketRegistered(ws)) {
        ws.close(4008, 'Handshake timeout');
      }
    }, WS_HANDSHAKE_TIMEOUT_MS);
    handshakeTimer.unref();

    ws.on('message', (raw) => {
      try {
        const json = JSON.parse(raw.toString('utf8'));
        const parsed = ExtensionToBrokerMessageSchema.safeParse(json);
        if (!parsed.success) {
          ws.close(4000, 'Invalid protocol message');
          return;
        }
        hub.handleExtensionMessage(ws, parsed.data);
        if (hub.isSocketRegistered(ws)) {
          clearTimeout(handshakeTimer);
        }
      } catch {
        ws.close(4000, 'Malformed JSON');
      }
    });

    ws.on('close', () => {
      clearTimeout(handshakeTimer);
      hub.unregisterExtension(ws);
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    httpServer.once('error', rejectListen);
    httpServer.listen(config.port, config.host, () => {
      httpServer.off('error', rejectListen);
      resolveListen();
    });
  });

  const close = async () => {
    clearInterval(leaseSweeper);
    if (idleExitTimer) clearTimeout(idleExitTimer);
    for (const client of wss.clients) {
      client.close(1001, 'Broker shutting down');
    }
    for (const client of cdpWss.clients) {
      client.close(1001, 'Broker shutting down');
    }
    await new Promise<void>((res) => wss.close(() => res()));
    await new Promise<void>((res) => cdpWss.close(() => res()));
    await new Promise<void>((res) => httpServer.close(() => res()));
  };

  return { config, hub, createPairingPin, close };
}
