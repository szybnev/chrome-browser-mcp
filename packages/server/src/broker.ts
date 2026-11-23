import { randomInt, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import {
  localhostHostValidation,
  localhostOriginValidation,
  NodeStreamableHTTPServerTransport,
} from '@modelcontextprotocol/node';
import { ExtensionToBrokerMessageSchema } from '@chrome-browser-mcp/protocol';
import { loadBrokerConfig, type BrokerConfig } from './config.js';
import { BrowserBrokerHub, SERVER_VERSION } from './hub.js';
import { createBrowserMcpServer } from './mcp-server.js';
import { attachCdpProxySocket, handleCdpDiscoveryRequest } from './cdp-proxy.js';

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

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
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

  let activePin: { code: string; expiresAt: number; attempts: number } | null = null;
  let activePairNonce: { value: string; expiresAt: number } | null = null;
  const createPairingPin = () => {
    const code = String(randomInt(100000, 1000000));
    const expiresAt = Date.now() + PIN_TTL_MS;
    activePin = { code, expiresAt, attempts: 0 };
    return { pin: code, expiresAt };
  };

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

      // Allow chrome-extension:// origin exclusively for 1-click PIN exchange & /health
      const originHeader = req.headers.origin;
      const isExtOrigin =
        typeof originHeader === 'string' && originHeader.startsWith('chrome-extension://');

      if (req.method === 'OPTIONS' && isExtOrigin && (url.pathname === '/pair/exchange' || url.pathname === '/health')) {
        res.writeHead(204, {
          'access-control-allow-origin': originHeader,
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
        });
        res.end();
        return;
      }

      if (!isExtOrigin && !validateOrigin(req, res)) return;

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

      // One-Click 6-digit PIN pairing page (browser-native, no npx/terminal required!)
      if (req.method === 'GET' && url.pathname === '/pair') {
        const nonce = randomUUID();
        activePairNonce = { value: nonce, expiresAt: Date.now() + PIN_TTL_MS };
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="dark light">
<title>Chrome Browser MCP — Local Pairing</title>
<style>
  :root { --bg:#111317; --surface:#181b21; --surface2:#1f232c; --border:#2b313e; --text:#e6e9ef; --muted:#9aa3b2; --accent:#2563eb; --accent2:#38e4d4; }
  @media (prefers-color-scheme: light) { :root { --bg:#f5f7fa; --surface:#fff; --surface2:#f0f2f6; --border:#d8dee9; --text:#151922; --muted:#5a6475; --accent:#2563eb; --accent2:#0d9488; } }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; background:var(--bg); color:var(--text); font:14px/1.5 system-ui,-apple-system,sans-serif; }
  .card { width:100%; max-width:480px; background:var(--surface); border:1px solid var(--border); border-radius:16px; padding:24px; box-shadow:0 16px 40px rgba(0,0,0,0.28); }
  h1 { margin:0 0 6px; font-size:19px; }
  p { margin:0 0 14px; color:var(--muted); font-size:13px; }
  .pin-box { display:none; align-items:center; justify-content:space-between; gap:12px; background:var(--surface2); border:1px solid var(--border); border-radius:12px; padding:14px 16px; margin:16px 0; }
  .pin-box.show { display:flex; }
  .pin-val { font:700 30px/1 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:0.24em; color:var(--accent2); }
  button { appearance:none; border:1px solid var(--border); background:var(--accent); color:#fff; border-radius:9px; padding:9px 14px; font:600 13px/1.2 inherit; cursor:pointer; }
  button.sec { background:var(--surface2); color:var(--text); }
  button:hover { opacity:0.92; }
  .hint { font-size:12px; color:var(--muted); margin-top:10px; }
  code { background:var(--surface2); border:1px solid var(--border); padding:2px 6px; border-radius:6px; font-family:ui-monospace,monospace; font-size:12px; }
</style></head><body>
<div class="card">
  <h1>Chrome Browser MCP — 1-Click Pairing</h1>
  <p>Local broker is running on <code>${config.brokerUrl}</code>. Click below to generate a single-use 6-digit PIN (valid for 2 minutes) — no terminal needed.</p>
  <button id="genBtn" type="button">Generate 6-Digit PIN</button>
  <div id="pinBox" class="pin-box">
    <span id="pinVal" class="pin-val">------</span>
    <button id="copyBtn" type="button" class="sec">Copy PIN</button>
  </div>
  <div id="msg" class="hint">Paste this PIN into the Chrome Browser MCP Welcome Wizard or Side Panel → Pair tab.</div>
</div>
<script>
  const nonce = ${JSON.stringify(nonce)};
  const genBtn = document.getElementById('genBtn');
  const pinBox = document.getElementById('pinBox');
  const pinVal = document.getElementById('pinVal');
  const copyBtn = document.getElementById('copyBtn');
  const msg = document.getElementById('msg');
  genBtn.addEventListener('click', async () => {
    genBtn.disabled = true;
    try {
      const r = await fetch('/pair/request-pin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce })
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || 'Failed to generate PIN');
      pinVal.textContent = j.data.pin;
      pinBox.classList.add('show');
      msg.textContent = 'PIN active for 2 minutes (single use). You can close this tab after pairing.';
    } catch (e) {
      msg.textContent = 'Error: ' + (e.message || e) + ' (reload this page to try again)';
      genBtn.disabled = false;
    }
  });
  copyBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(pinVal.textContent.trim());
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy PIN'; }, 1500);
  });
</script></body></html>`);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/pair/request-pin') {
        const body = (await readJsonBody(req)) as { nonce?: string };
        if (
          !activePairNonce ||
          Date.now() > activePairNonce.expiresAt ||
          typeof body.nonce !== 'string' ||
          body.nonce !== activePairNonce.value
        ) {
          writeJson(res, 403, { ok: false, error: 'Invalid or expired page nonce — reload /pair' });
          return;
        }
        activePairNonce = null;
        writeJson(res, 200, { ok: true, data: createPairingPin() });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/pair/exchange') {
        const corsHeaders: Record<string, string> = {
          'content-type': 'application/json; charset=utf-8',
          ...(isExtOrigin ? { 'access-control-allow-origin': originHeader } : {}),
        };
        const body = (await readJsonBody(req)) as { pin?: string };
        const submitted = String(body.pin ?? '').trim();
        if (!activePin || Date.now() > activePin.expiresAt) {
          activePin = null;
          res.writeHead(401, corsHeaders);
          res.end(JSON.stringify({ ok: false, error: 'No active pairing PIN — open http://127.0.0.1:43179/pair or run `pnpm pair`' }));
          return;
        }
        if (activePin.attempts >= MAX_PIN_ATTEMPTS) {
          activePin = null;
          res.writeHead(429, corsHeaders);
          res.end(JSON.stringify({ ok: false, error: 'Too many PIN attempts — generate a new PIN' }));
          return;
        }
        activePin.attempts += 1;
        if (submitted !== activePin.code) {
          res.writeHead(401, corsHeaders);
          res.end(JSON.stringify({ ok: false, error: 'Incorrect 6-digit PIN' }));
          return;
        }
        activePin = null; // Single-use PIN consumed
        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify({ ok: true, data: { token: config.token, wsUrl: config.wsUrl } }));
        return;
      }

      // Opt-in Local CDP Proxy discovery (/json/version, /json/list)
      if (handleCdpDiscoveryRequest(req, res, url, hub, config.brokerUrl, config.token)) {
        return;
      }

      // Streamable HTTP MCP Endpoint (2026 MCP v2 stateless handler)
      if (url.pathname === '/mcp') {
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
          case '/internal/resolve-secret':
            writeJson(res, 200, {
              ok: true,
              data: await hub.resolveSecret(String(body.secretRef ?? '')),
            });
            return;
          case '/internal/audit-export': {
            const fmt = body.format === 'html' ? 'html' : 'json';
            writeJson(res, 200, { ok: true, data: await hub.exportAudit(fmt) });
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
    const remote = req.socket.remoteAddress;
    if (remote && remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
      socket.destroy();
      return;
    }

    const url = new URL(req.url ?? '/', config.brokerUrl);
    if (url.pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
      return;
    }

    const cdpMatch = /^\/cdp\/(\d+)$/.exec(url.pathname);
    if (cdpMatch && hub.getPolicy().cdpProxyEnabled) {
      const tokenParam = url.searchParams.get('token') ?? '';
      const headerToken = req.headers['x-broker-token'];
      const candidate = typeof headerToken === 'string' ? headerToken : tokenParam;
      if (!hub.verifyToken(candidate)) {
        socket.destroy();
        return;
      }
      const tabId = Number(cdpMatch[1]);
      const profileId = url.searchParams.get('profileId') ?? undefined;
      cdpWss.handleUpgrade(req, socket, head, (ws) => {
        attachCdpProxySocket(ws, tabId, profileId, hub);
      });
      return;
    }

    socket.destroy();
  });

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      try {
        const json = JSON.parse(raw.toString('utf8'));
        const parsed = ExtensionToBrokerMessageSchema.safeParse(json);
        if (!parsed.success) {
          ws.close(4000, 'Invalid protocol message');
          return;
        }
        hub.handleExtensionMessage(ws, parsed.data);
      } catch {
        ws.close(4000, 'Malformed JSON');
      }
    });

    ws.on('close', () => {
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
