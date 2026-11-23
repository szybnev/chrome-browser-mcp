#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadBrokerConfig, loadOrCreateToken, resolveDataDir } from './config.js';
import { startBrokerDaemon } from './broker.js';
import { createBrowserMcpServer } from './mcp-server.js';
import { RemoteBrokerHub } from './remote-hub.js';

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let command = 'stdio';
  let port: number | undefined;
  let dataDir: string | undefined;
  let idleExit = false;
  let rotate = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('-') && i === 0) {
      command = a;
    } else if (a === '--port' && args[i + 1]) {
      port = Number(args[++i]);
    } else if (a.startsWith('--port=')) {
      port = Number(a.split('=')[1]);
    } else if ((a === '--data-dir' || a === '--data_dir') && args[i + 1]) {
      dataDir = args[++i];
    } else if (a.startsWith('--data-dir=') || a.startsWith('--data_dir=')) {
      dataDir = a.split('=')[1];
    } else if (a === '--idle-exit') {
      idleExit = true;
    } else if (a === '--rotate') {
      rotate = true;
    } else if (a === '-h' || a === '--help') {
      command = 'help';
    }
  }

  return { command, port, dataDir, idleExit, rotate };
}

async function isBrokerHealthy(brokerUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${brokerUrl}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureBrokerRunning(config: ReturnType<typeof loadBrokerConfig>): Promise<void> {
  if (await isBrokerHealthy(config.brokerUrl)) return;

  const cliPath = fileURLToPath(import.meta.url);
  const child = spawn(
    process.execPath,
    [cliPath, 'daemon', '--idle-exit', `--port=${config.port}`, `--data-dir=${config.dataDir}`],
    {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    },
  );
  child.unref();

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await isBrokerHealthy(config.brokerUrl)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Failed to start local Chrome Browser MCP broker at ${config.brokerUrl}`);
}

async function runStdioShim(port?: number, dataDir?: string): Promise<void> {
  const config = loadBrokerConfig({ port, dataDir });
  await ensureBrokerRunning(config);

  // Acquire broker lease so broker stays alive while at least one stdio agent is active
  let leaseId: string | undefined;
  const renewLease = async () => {
    try {
      const res = await fetch(`${config.brokerUrl}/internal/lease`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-broker-token': config.token,
        },
        body: JSON.stringify(leaseId ? { leaseId } : {}),
      });
      if (res.ok) {
        const json = (await res.json()) as { data?: { leaseId?: string } };
        leaseId = json.data?.leaseId ?? leaseId;
      }
    } catch {
      // ignore transient heartbeat failure
    }
  };

  await renewLease();
  const heartbeat = setInterval(() => void renewLease(), 15_000);
  heartbeat.unref();

  const releaseLease = async () => {
    clearInterval(heartbeat);
    if (!leaseId) return;
    try {
      await fetch(`${config.brokerUrl}/internal/lease`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-broker-token': config.token,
        },
        body: JSON.stringify({ leaseId, release: true }),
      });
    } catch {
      // ignore
    }
  };

  const remoteHub = new RemoteBrokerHub(config.brokerUrl, config.token);
  const mcpServer = createBrowserMcpServer(remoteHub);
  const transport = new StdioServerTransport();

  const shutdown = async () => {
    await releaseLease();
    await mcpServer.close();
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  process.stdin.once('end', () => void shutdown());

  await mcpServer.connect(transport);
}

async function main(): Promise<void> {
  const { command, port, dataDir, idleExit, rotate } = parseArgs(process.argv);

  if (command === 'help') {
    console.log(`chrome-browser-mcp — Next-gen Chrome Extension & MCP Server

Usage:
  chrome-browser-mcp [stdio] [--port=43179] [--data-dir=PATH]   Run MCP stdio bridge (auto-starts shared broker)
  chrome-browser-mcp daemon [--port=43179] [--idle-exit]        Run shared local Broker Daemon (Streamable HTTP + WS)
  chrome-browser-mcp status [--port=43179]                      Show broker health & connected browser profiles
  chrome-browser-mcp token [--rotate] [--data-dir=PATH]         Print (or rotate) the local Chrome pairing token
`);
    return;
  }

  if (command === 'token') {
    const dir = resolveDataDir(dataDir);
    const token = loadOrCreateToken(dir, rotate);
    console.log(token);
    return;
  }

  if (command === 'status') {
    const config = loadBrokerConfig({ port, dataDir });
    try {
      const res = await fetch(`${config.brokerUrl}/health`);
      const health = await res.json();
      console.log(JSON.stringify(health, null, 2));
    } catch {
      console.error(`Broker is not running at ${config.brokerUrl}`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'daemon') {
    const handle = await startBrokerDaemon({ port, dataDir, idleExit });
    console.error(`[chrome-browser-mcp] Broker listening on ${handle.config.brokerUrl}`);
    console.error(`[chrome-browser-mcp] Streamable HTTP MCP: ${handle.config.mcpUrl}`);
    console.error(`[chrome-browser-mcp] Extension WebSocket: ${handle.config.wsUrl}`);
    console.error(`[chrome-browser-mcp] Pairing token file:  ${handle.config.dataDir}/token.txt`);

    const stop = async () => {
      await handle.close();
      process.exit(0);
    };
    process.once('SIGINT', () => void stop());
    process.once('SIGTERM', () => void stop());
    return;
  }

  await runStdioShim(port, dataDir);
}

main().catch((err) => {
  console.error('[chrome-browser-mcp] Fatal error:', err);
  process.exit(1);
});
