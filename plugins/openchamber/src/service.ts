/**
 * OpenChamber Guest Local Service for Chrome Browser MCP.
 *
 * Runs under OpenChamber's own Node runtime on 127.0.0.1:$OPENCHAMBER_SERVICE_PORT,
 * authenticated strictly by Authorization: Bearer $OPENCHAMBER_SERVICE_TOKEN.
 *
 * Responsibilities:
 *  - Auto-starts/connects to the shared Chrome Browser MCP Broker Daemon (127.0.0.1:43179)
 *  - Proxies POST /deck-tool to Broker /internal/deck-tool without exposing broker token to the iframe
 *  - Serves GET/POST /status for OpenChamber's native Work Status strip
 */
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_BROKER_PORT = 43179;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface BrokerClientOptions {
  port?: number;
  dataDir?: string;
  cliPath?: string;
}

interface DeckProfileSummary {
  profileId: string;
  browserName?: string;
  profileLabel?: string;
  tabCount?: number;
}

interface DeckTabSummary {
  tabId: number;
  inAgentGroup?: boolean;
}

interface DeckStateSummary {
  brokerVersion: string;
  paused: boolean;
  defaultProfileId: string | null;
  profiles: DeckProfileSummary[];
  tabs: Record<string, DeckTabSummary[]>;
  pendingApprovals: Array<{ id: string }>;
  pendingDialogs?: Record<string, unknown>;
}

function timingSafeBearerMatch(header: string | undefined, expectedToken: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = header.slice('Bearer '.length);
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expectedToken, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function resolveBrokerConfig(opts?: BrokerClientOptions) {
  const port =
    opts?.port ??
    (process.env.CHROME_BROWSER_MCP_PORT ? Number(process.env.CHROME_BROWSER_MCP_PORT) : DEFAULT_BROKER_PORT);
  const dataDir =
    opts?.dataDir ?? process.env.CHROME_BROWSER_MCP_DATA_DIR ?? join(homedir(), '.chrome-browser-mcp');
  const brokerUrl = `http://127.0.0.1:${port}`;
  return { port, dataDir, brokerUrl };
}

function readBrokerToken(dataDir: string): string {
  const envToken = process.env.CHROME_BROWSER_MCP_TOKEN?.trim();
  if (envToken) return envToken;
  const tokenFile = join(dataDir, 'token.txt');
  if (existsSync(tokenFile)) {
    return readFileSync(tokenFile, 'utf8').trim();
  }
  return '';
}

function resolveServerCliPath(explicit?: string): string | null {
  if (explicit && existsSync(explicit)) return explicit;
  if (process.env.CHROME_BROWSER_MCP_CLI && existsSync(process.env.CHROME_BROWSER_MCP_CLI)) {
    return process.env.CHROME_BROWSER_MCP_CLI;
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(here, '../../../packages/server/dist/cli.js'),
      resolve(here, '../../../../packages/server/dist/cli.js'),
      resolve(here, '../server/cli.js'),
      resolve(here, '../../server/cli.js'),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  } catch {
    // ignore
  }
  return null;
}

async function getBrokerHealth(
  brokerUrl: string,
): Promise<{ ok: boolean; version?: string; activeLeases?: number } | null> {
  try {
    const res = await fetch(`${brokerUrl}/health`, { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return null;
    return (await res.json()) as { ok: boolean; version?: string; activeLeases?: number };
  } catch {
    return null;
  }
}

let brokerStartPromise: Promise<void> | null = null;

async function ensureBrokerRunning(
  opts?: BrokerClientOptions,
): Promise<{ brokerUrl: string; token: string }> {
  const cfg = resolveBrokerConfig(opts);
  if (await getBrokerHealth(cfg.brokerUrl)) {
    const token = readBrokerToken(cfg.dataDir);
    if (!token) throw new Error('Broker token missing in ~/.chrome-browser-mcp/token.txt');
    return { brokerUrl: cfg.brokerUrl, token };
  }

  if (!brokerStartPromise) {
    brokerStartPromise = (async () => {
      const cliPath = resolveServerCliPath(opts?.cliPath);
      if (!cliPath) {
        throw new Error(
          'Chrome Browser MCP server CLI not found (missing bundled server/cli.js or repo build). Rebuild with `pnpm build` or set CHROME_BROWSER_MCP_CLI.',
        );
      }
      const child = spawn(
        process.execPath,
        [cliPath, 'daemon', '--idle-exit', `--port=${cfg.port}`, `--data-dir=${cfg.dataDir}`],
        {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        },
      );
      child.unref();

      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (await getBrokerHealth(cfg.brokerUrl)) return;
        await new Promise((r) => setTimeout(r, 180));
      }
      throw new Error(`Could not start local Chrome Browser MCP broker at ${cfg.brokerUrl}`);
    })().finally(() => {
      brokerStartPromise = null;
    });
  }

  await brokerStartPromise;
  const token = readBrokerToken(cfg.dataDir);
  if (!token) throw new Error('Broker token missing after startup');
  return { brokerUrl: cfg.brokerUrl, token };
}

async function callBrokerDeckTool(
  name: string,
  args: Record<string, unknown>,
  opts?: BrokerClientOptions,
): Promise<{ data: Record<string, unknown>; text?: string }> {
  const { brokerUrl, token } = await ensureBrokerRunning(opts);
  const res = await fetch(`${brokerUrl}/internal/deck-tool`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-broker-token': token,
    },
    body: JSON.stringify({ name, arguments: args }),
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await res.text();
  let parsed: { ok?: boolean; data?: Record<string, unknown>; text?: string; error?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Broker returned non-JSON (${res.status})`);
  }
  if (!res.ok || parsed.ok === false) {
    if (res.status === 404) {
      const health = await getBrokerHealth(brokerUrl);
      const ver = health?.version ?? 'unknown';
      const leases = typeof health?.activeLeases === 'number' ? `, activeLeases=${health.activeLeases}` : '';
      throw new Error(
        `Incompatible local Chrome Browser MCP broker v${ver} at ${brokerUrl}${leases} (missing /internal/deck-tool; requires >=2.1.1). Restart the local broker daemon to upgrade.`,
      );
    }
    throw new Error(parsed.error || `Broker HTTP error ${res.status}`);
  }
  return { data: parsed.data ?? {}, text: parsed.text };
}

type StatusTone = 'default' | 'muted' | 'accent' | 'success' | 'warning' | 'error' | 'info';
type StatusRow =
  | {
      kind: 'line';
      id: string;
      label: string;
      dot?: StatusTone;
      content?: { kind: 'text'; text: string; tone?: StatusTone };
      value?: string;
    }
  | { kind: 'note'; id: string; text: string; tone?: 'muted' | 'info' | 'warning' | 'error' };
type StatusControl = { kind: 'button'; id: string; label: string; disabled?: boolean };

export function buildWorkStatusView(
  state: DeckStateSummary | null,
  errMessage?: string,
): {
  rows: StatusRow[];
  controls: StatusControl[];
} {
  if (!state) {
    return {
      rows: [
        {
          kind: 'note',
          id: 'offline',
          text: errMessage ? `Broker offline: ${errMessage}` : 'Chrome Browser MCP broker offline.',
          tone: 'warning',
        },
      ],
      controls: [{ kind: 'button', id: 'start', label: 'Start Broker' }],
    };
  }

  const activeProfileId = state.defaultProfileId ?? state.profiles[0]?.profileId ?? '';
  const activeProfile = state.profiles.find((p) => p.profileId === activeProfileId) ?? state.profiles[0];
  const tabs = activeProfileId ? (state.tabs[activeProfileId] ?? []) : [];
  const agentTabCount = tabs.filter((t) => t.inAgentGroup).length;
  const pendingCount = state.pendingApprovals.length + Object.keys(state.pendingDialogs ?? {}).length;

  const rows: StatusRow[] = [];
  if (state.profiles.length === 0) {
    rows.push({
      kind: 'note',
      id: 'no-profile',
      text: 'No Chrome profile paired yet — click PIN and paste into the Chrome extension.',
      tone: 'info',
    });
  } else {
    rows.push({
      kind: 'line',
      id: 'profile',
      label: activeProfile?.browserName
        ? `${activeProfile.browserName}: ${activeProfile.profileLabel || activeProfile.profileId}`
        : activeProfileId,
      dot: state.paused ? 'warning' : 'success',
      content: {
        kind: 'text',
        text: state.paused
          ? `Paused · ${agentTabCount} AI tabs`
          : `${agentTabCount} AI tabs · ${tabs.length} total`,
        tone: state.paused ? 'warning' : 'muted',
      },
      value: `v${state.brokerVersion}`,
    });
  }

  if (pendingCount > 0) {
    rows.push({
      kind: 'note',
      id: 'pending',
      text: `${pendingCount} pending approval/dialog waiting in Browser Deck`,
      tone: 'warning',
    });
  }

  const controls: StatusControl[] = [
    {
      kind: 'button',
      id: state.paused ? 'resume' : 'pause',
      label: state.paused ? 'Resume' : 'Pause',
    },
    {
      kind: 'button',
      id: 'pin',
      label: 'PIN',
    },
  ];

  return { rows, controls };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

export function createOpenChamberServiceServer(token: string, brokerOpts?: BrokerClientOptions) {
  const send = (res: ServerResponse, status: number, body: unknown) => {
    if (res.headersSent) return;
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(body));
  };

  return http.createServer((req, res) => {
    if (!timingSafeBearerMatch(req.headers.authorization, token)) {
      send(res, 401, { error: 'unauthorized' });
      return;
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/health') {
      send(res, 200, { ok: true });
      return;
    }

    void (async () => {
      try {
        if (url.pathname === '/status') {
          if (method === 'GET') {
            try {
              const { data } = await callBrokerDeckTool('deck_get_state', {}, brokerOpts);
              send(res, 200, buildWorkStatusView((data.state as DeckStateSummary) ?? null));
            } catch (err) {
              send(res, 200, buildWorkStatusView(null, err instanceof Error ? err.message : String(err)));
            }
            return;
          }
          if (method === 'POST') {
            const body = await readJsonBody(req);
            const id = typeof body.id === 'string' ? body.id : '';
            if (id === 'start') {
              await ensureBrokerRunning(brokerOpts);
              send(res, 200, { ok: true });
              return;
            }
            if (id === 'pause' || id === 'resume') {
              await callBrokerDeckTool('deck_set_paused', { paused: id === 'pause' }, brokerOpts);
              send(res, 200, { ok: true });
              return;
            }
            if (id === 'pin') {
              const resPin = await callBrokerDeckTool('deck_create_pin', {}, brokerOpts);
              send(res, 200, { ok: true, pin: resPin.data.pin });
              return;
            }
            send(res, 400, { message: `Unknown status control: ${id}` });
            return;
          }
        }

        if (method === 'POST' && url.pathname === '/deck-tool') {
          const body = await readJsonBody(req);
          const name = typeof body.name === 'string' ? body.name : '';
          const args =
            body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments)
              ? (body.arguments as Record<string, unknown>)
              : {};
          if (!name) {
            send(res, 400, { error: 'Missing tool name' });
            return;
          }
          const result = await callBrokerDeckTool(name, args, brokerOpts);
          send(res, 200, { ok: true, structuredContent: result.data, text: result.text });
          return;
        }

        send(res, 404, { error: 'Not found' });
      } catch (err) {
        send(res, 502, {
          error: err instanceof Error ? err.message : String(err),
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  });
}

// Direct entrypoint when spawned by OpenChamber host
const isEntrypoint =
  typeof process !== 'undefined' &&
  Boolean(process.env.OPENCHAMBER_SERVICE_PORT) &&
  Boolean(process.env.OPENCHAMBER_SERVICE_TOKEN) &&
  process.env.VITEST !== 'true';

if (isEntrypoint) {
  const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
  const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
  const server = createOpenChamberServiceServer(token);
  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  server.listen(port, '127.0.0.1');
}
