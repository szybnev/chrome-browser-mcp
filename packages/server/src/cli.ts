#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { startBrokerDaemon } from './broker.js';
import { loadBrokerConfig, loadOrCreateToken, resolveDataDir } from './config.js';
import { SERVER_VERSION } from './hub.js';
import { createBrowserMcpServer } from './mcp-server.js';
import { installNativeMessagingHost, runNativeMessagingHost } from './native-host.js';
import { RemoteBrokerHub } from './remote-hub.js';

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let command = 'stdio';
  let port: number | undefined;
  let dataDir: string | undefined;
  let idleExit = false;
  let rotate = false;
  let enableCdpProxy = false;
  let extensionId: string | undefined;

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
    } else if (a === '--extension-id' && args[i + 1]) {
      extensionId = args[++i];
    } else if (a.startsWith('--extension-id=')) {
      extensionId = a.split('=')[1];
    } else if (a === '--idle-exit') {
      idleExit = true;
    } else if (a === '--rotate') {
      rotate = true;
    } else if (a === '--enable-cdp-proxy') {
      enableCdpProxy = true;
    } else if (a === '-h' || a === '--help') {
      command = 'help';
    }
  }

  return { command, port, dataDir, idleExit, rotate, enableCdpProxy, extensionId };
}

async function getBrokerHealth(
  brokerUrl: string,
): Promise<{ ok: boolean; version?: string; activeLeases?: number } | null> {
  try {
    const res = await fetch(`${brokerUrl}/health`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return null;
    return (await res.json()) as { ok: boolean; version?: string; activeLeases?: number };
  } catch {
    return null;
  }
}

async function ensureBrokerRunning(config: ReturnType<typeof loadBrokerConfig>): Promise<void> {
  const existing = await getBrokerHealth(config.brokerUrl);
  if (existing) {
    if (existing.version && existing.version !== SERVER_VERSION) {
      console.error(
        `[chrome-browser-mcp] Warning: running broker at ${config.brokerUrl} is v${existing.version} (client is v${SERVER_VERSION}, activeLeases=${existing.activeLeases ?? 0}). Leaving active broker running; restart the broker daemon if newer routes (e.g. /internal/deck-tool) are needed.`,
      );
    }
    return;
  }

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
    if (await getBrokerHealth(config.brokerUrl)) return;
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
  const { command, port, dataDir, idleExit, rotate, enableCdpProxy, extensionId } = parseArgs(process.argv);

  if (command === 'help') {
    console.log(`chrome-browser-mcp — Next-gen Chrome Extension & MCP Server

Usage:
  chrome-browser-mcp [stdio] [--port=43179] [--data-dir=PATH]           Run MCP stdio bridge (auto-starts shared broker)
  chrome-browser-mcp daemon [--port=43179] [--enable-cdp-proxy]         Run shared local Broker Daemon (HTTP + WS)
  chrome-browser-mcp pair [--port=43179]                                Generate a 2-minute 6-digit pairing PIN
  chrome-browser-mcp install-host --extension-id=<ID>                   Install Chrome Native Messaging Host manifest
  chrome-browser-mcp native-host                                        Run Chrome Native Messaging stdio bridge
  chrome-browser-mcp status [--port=43179]                              Show broker health & connected browser profiles
  chrome-browser-mcp token [--rotate] [--data-dir=PATH]                 Print (or rotate) the local Chrome pairing token
`);
    return;
  }

  if (command === 'pair') {
    const config = loadBrokerConfig({ port, dataDir });
    await ensureBrokerRunning(config);
    const res = await fetch(`${config.brokerUrl}/internal/create-pin`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-broker-token': config.token,
      },
      body: '{}',
    });
    const json = (await res.json()) as {
      ok: boolean;
      data?: { pin: string; expiresAt: number };
      error?: string;
    };
    if (!res.ok || !json.ok || !json.data) {
      console.error(`Failed to generate pairing PIN: ${json.error || res.statusText}`);
      process.exitCode = 1;
      return;
    }
    console.log('Chrome Browser MCP — 1-Click Pairing PIN (valid for 2 minutes):');
    console.log(`\n    PIN:  ${json.data.pin}\n`);
    console.log('Enter this PIN in the Chrome Browser MCP Welcome Tour or Side Panel -> Pair tab.');
    console.log(`Helper page: ${config.brokerUrl}/pair`);
    return;
  }

  if (command === 'install-host') {
    if (!extensionId) {
      console.error('Missing --extension-id=<32-char Chrome extension ID>');
      process.exitCode = 1;
      return;
    }
    const { manifestPath, wrapperPath } = installNativeMessagingHost({ extensionId, dataDir });
    console.log('Installed Chrome Native Messaging Host:');
    console.log(`  Manifest: ${manifestPath}`);
    console.log(`  Wrapper:  ${wrapperPath}`);
    return;
  }

  if (command === 'native-host') {
    await runNativeMessagingHost({ port, dataDir });
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
    const handle = await startBrokerDaemon({ port, dataDir, idleExit, enableCdpProxy });
    console.error(`[chrome-browser-mcp] Broker listening on ${handle.config.brokerUrl}`);
    console.error(`[chrome-browser-mcp] Streamable HTTP MCP: ${handle.config.mcpUrl}`);
    console.error(`[chrome-browser-mcp] Extension WebSocket: ${handle.config.wsUrl}`);
    console.error(`[chrome-browser-mcp] Pairing token file:  ${handle.config.dataDir}/token.txt`);
    if (handle.hub.getPolicy().cdpProxyEnabled) {
      console.error(`[chrome-browser-mcp] Opt-in CDP Proxy:    ${handle.config.brokerUrl}/json/version`);
    }

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
