import { randomUUID } from 'node:crypto';
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

export interface BrokerDaemonHandle {
  config: BrokerConfig;
  hub: BrowserBrokerHub;
  close: () => Promise<void>;
}

const LEASE_TTL_MS = 45_000;
const IDLE_GRACE_MS = 20_000;

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
}): Promise<BrokerDaemonHandle> {
  const config = loadBrokerConfig({ port: options?.port, dataDir: options?.dataDir });
  const hub = new BrowserBrokerHub(config.dataDir, config.brokerUrl, config.token);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

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
      if (!validateOrigin(req, res)) return;

      const url = new URL(req.url ?? '/', config.brokerUrl);

      // Public loopback health endpoint (never leaks token)
      if (req.method === 'GET' && url.pathname === '/health') {
        const { profiles, defaultProfileId } = await hub.listProfiles();
        writeJson(res, 200, {
          ok: true,
          version: SERVER_VERSION,
          mcpUrl: config.mcpUrl,
          wsUrl: config.wsUrl,
          defaultProfileId,
          connectedProfiles: profiles.length,
          paused: hub.isPaused(),
          activeLeases: leases.size,
        });
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

  // WebSocket server strictly on /ws for Chrome Extensions
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const remote = req.socket.remoteAddress;
    if (remote && remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
      socket.destroy();
      return;
    }

    const url = new URL(req.url ?? '/', config.brokerUrl);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
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
    await new Promise<void>((res) => wss.close(() => res()));
    await new Promise<void>((res) => httpServer.close(() => res()));
  };

  return { config, hub, close };
}
