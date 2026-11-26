import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BrokerDaemonHandle, startBrokerDaemon } from '../packages/server/src/broker.js';
import { DECK_APP_URI } from '../packages/server/src/mcp-server.js';
import {
  type ClaudeModApi,
  PANE_ID,
  register as registerClaudeMod,
  resetModStateForTest,
} from '../plugins/claude/src/register.js';
import { createOpenChamberServiceServer } from '../plugins/openchamber/src/service.js';

const ROOT_DIR = resolve(import.meta.dirname, '..');

describe('Multi-Harness Desktop GUI Integrations', () => {
  let tempDir: string;
  let broker: BrokerDaemonHandle;
  let brokerPort: number;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cbmcp-desktop-test-'));
    brokerPort = 43900 + Math.floor(Math.random() * 900);
    broker = await startBrokerDaemon({ port: brokerPort, dataDir: tempDir });
  });

  afterAll(async () => {
    await broker.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. Shared Broker /internal/deck-tool
  // -------------------------------------------------------------------------
  describe('Shared Broker /internal/deck-tool endpoint', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const res = await fetch(`${broker.config.brokerUrl}/internal/deck-tool`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'deck_get_state' }),
      });
      expect(res.status).toBe(401);
    });

    it('executes deck_get_state, deck_set_paused, and deck_create_pin with broker token', async () => {
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const res = await fetch(`${broker.config.brokerUrl}/internal/deck-tool`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-broker-token': broker.config.token,
          },
          body: JSON.stringify({ name, arguments: args }),
        });
        return { status: res.status, json: (await res.json()) as Record<string, unknown> };
      };

      const stateRes = await call('deck_get_state');
      expect(stateRes.status).toBe(200);
      expect(stateRes.json.ok).toBe(true);
      expect((stateRes.json.data as { state: { paused: boolean } }).state.paused).toBe(false);

      const pauseRes = await call('deck_set_paused', { paused: true });
      expect(pauseRes.status).toBe(200);
      expect((pauseRes.json.data as { state: { paused: boolean } }).state.paused).toBe(true);

      await call('deck_set_paused', { paused: false });

      const pinRes = await call('deck_create_pin');
      expect(pinRes.status).toBe(200);
      expect((pinRes.json.data as { pin: string }).pin).toMatch(/^\d{6}$/);

      const unknownRes = await call('deck_nonexistent');
      expect(unknownRes.status).toBe(400);
    });

    it('clears latestScreenshot via deck_clear_diagnostics(target="screenshot")', async () => {
      broker.hub.recordScreenshot({
        tabId: 42,
        url: 'https://example.com/demo',
        mimeType: 'image/webp',
        dataUrl: 'data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=',
        setOfMark: false,
        timestamp: Date.now(),
      });

      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const res = await fetch(`${broker.config.brokerUrl}/internal/deck-tool`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-broker-token': broker.config.token,
          },
          body: JSON.stringify({ name, arguments: args }),
        });
        return { status: res.status, json: (await res.json()) as Record<string, unknown> };
      };

      const beforeRes = await call('deck_get_state');
      expect(beforeRes.status).toBe(200);
      expect(
        (beforeRes.json.data as { state: { latestScreenshot: { tabId: number } | null } }).state
          .latestScreenshot?.tabId,
      ).toBe(42);

      const clearRes = await call('deck_clear_diagnostics', { target: 'screenshot' });
      expect(clearRes.status).toBe(200);
      expect(
        (clearRes.json.data as { state: { latestScreenshot: unknown } }).state.latestScreenshot,
      ).toBeNull();

      const afterRes = await call('deck_get_state');
      expect(
        (afterRes.json.data as { state: { latestScreenshot: unknown } }).state.latestScreenshot,
      ).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 2. Codex Desktop Plugin & OpenAI MCP Apps Entrypoints
  // -------------------------------------------------------------------------
  describe('Codex Desktop plugin & MCP Apps metadata', () => {
    it('exposes both Antigravity and OpenAI Codex UI entrypoints on browser_deck over /mcp', async () => {
      const res = await fetch(broker.config.mcpUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'x-broker-token': broker.config.token,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
      });
      expect(res.status).toBe(200);
      const raw = await res.text();
      // Streamable HTTP may return JSON directly or SSE `data: {...}`
      const jsonLine = raw
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('data:') || l.startsWith('{'));
      expect(jsonLine).toBeDefined();
      const payload = JSON.parse((jsonLine ?? '').replace(/^data:\s*/, '')) as {
        result: { tools: Array<{ name: string; _meta?: Record<string, unknown> }> };
      };
      const deckTool = payload.result.tools.find((t) => t.name === 'browser_deck');
      expect(deckTool).toBeDefined();
      const meta = deckTool?._meta as Record<string, unknown>;
      expect(meta.ui).toEqual({ resourceUri: DECK_APP_URI });
      expect(meta['openai/ui']).toEqual({
        entrypoints: [{ type: 'global' }, { type: 'thread' }],
      });
      expect(meta['com.google.antigravity/ui']).toEqual({
        entrypoints: [
          { type: 'aux_pane', title: 'Browser Deck' },
          { type: 'global', title: 'Browser Deck' },
        ],
      });
    });

    it('ships valid Agent Plugins 1.0, .codex-plugin, and marketplace manifests', () => {
      const rootPkg = JSON.parse(readFileSync(resolve(ROOT_DIR, 'package.json'), 'utf8'));
      const codexPlugin = JSON.parse(readFileSync(resolve(ROOT_DIR, 'plugins/codex/plugin.json'), 'utf8'));
      const codexCompat = JSON.parse(
        readFileSync(resolve(ROOT_DIR, 'plugins/codex/.codex-plugin/plugin.json'), 'utf8'),
      );
      const marketplace = JSON.parse(
        readFileSync(resolve(ROOT_DIR, '.agents/plugins/marketplace.json'), 'utf8'),
      );

      expect(codexPlugin.version).toBe(rootPkg.version);
      expect(codexCompat.version).toBe(rootPkg.version);
      expect(codexPlugin.extensions['com.openai'].interface.displayName).toBe('Chrome Browser MCP');
      expect(marketplace.plugins[0].source.path).toBe('./plugins/codex');
      expect(existsSync(resolve(ROOT_DIR, 'plugins/codex/mcp.json'))).toBe(true);
      expect(existsSync(resolve(ROOT_DIR, 'plugins/codex/.mcp.json'))).toBe(true);
      expect(existsSync(resolve(ROOT_DIR, 'plugins/codex/skills/chrome-browser-mcp/SKILL.md'))).toBe(true);
      expect(existsSync(resolve(ROOT_DIR, 'plugins/codex/server/cli.js'))).toBe(true);
      expect(existsSync(resolve(ROOT_DIR, 'plugins/codex/server/app/deck.html'))).toBe(true);

      // Must never fall back to unrelated third-party npm `chrome-browser-mcp` package
      const launcher = readFileSync(resolve(ROOT_DIR, 'plugins/codex/bin/start-server.sh'), 'utf8');
      expect(launcher).not.toContain('npx');
      expect(launcher).not.toContain('chrome-browser-mcp@');
    });

    it('runs cleanly from an isolated copied Codex plugin cache directory over stdio', async () => {
      const isolatedRoot = mkdtempSync(join(tmpdir(), 'cbmcp-codex-cache-'));
      const cacheCopy = join(isolatedRoot, 'cache', 'chrome-browser-mcp', 'chrome-browser-mcp', '2.1.1');
      cpSync(resolve(ROOT_DIR, 'plugins/codex'), cacheCopy, { recursive: true });

      const child = spawn('bash', ['./bin/start-server.sh'], {
        cwd: cacheCopy,
        env: {
          HOME: homedir(),
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          CHROME_BROWSER_MCP_PORT: String(brokerPort),
          CHROME_BROWSER_MCP_DATA_DIR: tempDir,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });

      const pending = new Map<number, (msg: Record<string, unknown>) => void>();
      let stdoutBuf = '';
      child.stdout.on('data', (chunk) => {
        stdoutBuf += chunk.toString('utf8');
        let nl = stdoutBuf.indexOf('\n');
        while (nl !== -1) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (line) {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            if (typeof parsed.id === 'number' && pending.has(parsed.id)) {
              pending.get(parsed.id)?.(parsed);
              pending.delete(parsed.id);
            }
          }
          nl = stdoutBuf.indexOf('\n');
        }
      });

      let seq = 0;
      const rpc = (method: string, params: Record<string, unknown> = {}) =>
        new Promise<Record<string, unknown>>((resolveRpc, rejectRpc) => {
          const id = ++seq;
          const timer = setTimeout(
            () => rejectRpc(new Error(`stdio MCP timeout on ${method}; stderr=${stderr}`)),
            8000,
          );
          pending.set(id, (msg) => {
            clearTimeout(timer);
            resolveRpc(msg);
          });
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        });

      try {
        await rpc('initialize', {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'codex-cache-test', version: '1.0.0' },
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

        const toolsResp = await rpc('tools/list');
        const tools = (
          toolsResp.result as { tools: Array<{ name: string; _meta?: Record<string, unknown> }> }
        ).tools;
        const names = tools.map((t) => t.name);
        expect(names).toContain('browser_deck');
        expect(names).toContain('browser_tabs');
        expect(names).toContain('browser_profiles');
        expect(names).not.toContain('browser_status');
        expect(names).not.toContain('page_list');

        const deckTool = tools.find((t) => t.name === 'browser_deck');
        expect(deckTool?._meta?.ui).toEqual({ resourceUri: DECK_APP_URI });
        expect(deckTool?._meta?.['openai/ui']).toEqual({
          entrypoints: [{ type: 'global' }, { type: 'thread' }],
        });

        const resResp = await rpc('resources/read', { uri: DECK_APP_URI });
        const contents = (resResp.result as { contents: Array<{ mimeType: string; text: string }> }).contents;
        expect(contents[0]?.mimeType).toBe('text/html;profile=mcp-app');
        expect(contents[0]?.text).toContain('__CBMCP_DECK_SECRET__');
        expect(contents[0]?.text).not.toContain('Deck UI bundle not found');
      } finally {
        child.stdin.end();
        child.kill('SIGTERM');
        rmSync(isolatedRoot, { recursive: true, force: true });
      }
    });

    it('fails closed with a clear error when bundled server is removed from cache', () => {
      const brokenDir = mkdtempSync(join(tmpdir(), 'cbmcp-codex-broken-'));
      cpSync(resolve(ROOT_DIR, 'plugins/codex'), brokenDir, { recursive: true });
      rmSync(join(brokenDir, 'server'), { recursive: true, force: true });

      try {
        const res = spawnSync('bash', ['./bin/start-server.sh'], {
          cwd: brokenDir,
          env: { HOME: homedir(), PATH: process.env.PATH ?? '/usr/bin:/bin' },
          encoding: 'utf8',
          timeout: 5000,
        });
        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('bundled server CLI not found');
      } finally {
        rmSync(brokenDir, { recursive: true, force: true });
      }
    });
    it('install-local.mjs --codex registers marketplace, installs plugin cache, and cleans stale versions', () => {
      const rootPkg = JSON.parse(readFileSync(resolve(ROOT_DIR, 'package.json'), 'utf8'));
      const expectedVersion = String(rootPkg.version);

      // 1. Direct fallback path (when `codex` CLI is not on PATH)
      const fallbackCodexHome = mkdtempSync(join(tmpdir(), 'cbmcp-codex-home-fallback-'));
      const staleDir = join(
        fallbackCodexHome,
        'plugins',
        'cache',
        'chrome-browser-mcp',
        'chrome-browser-mcp',
        '2.2.0',
      );
      mkdirSync(staleDir, { recursive: true });
      try {
        const res = spawnSync(process.execPath, [resolve(ROOT_DIR, 'scripts/install-local.mjs'), '--codex'], {
          cwd: ROOT_DIR,
          env: {
            HOME: homedir(),
            PATH: dirname(process.execPath),
            CODEX_HOME: fallbackCodexHome,
          },
          encoding: 'utf8',
          timeout: 10_000,
        });
        expect(res.status).toBe(0);
        const toml = readFileSync(join(fallbackCodexHome, 'config.toml'), 'utf8');
        expect(toml).toContain('[marketplaces.chrome-browser-mcp]');
        expect(toml).toContain('[plugins."chrome-browser-mcp@chrome-browser-mcp"]');
        expect(toml).toContain('enabled = true');
        const installedDir = join(
          fallbackCodexHome,
          'plugins',
          'cache',
          'chrome-browser-mcp',
          'chrome-browser-mcp',
          expectedVersion,
        );
        expect(existsSync(join(installedDir, 'plugin.json'))).toBe(true);
        expect(existsSync(join(installedDir, 'server/cli.js'))).toBe(true);
        expect(existsSync(staleDir)).toBe(false);
      } finally {
        rmSync(fallbackCodexHome, { recursive: true, force: true });
      }

      // 2. Native `codex` CLI path (when `codex` binary is available on this machine)
      const codexProbe = spawnSync('codex', ['--version'], { stdio: 'ignore' });
      if (!codexProbe.error && codexProbe.status === 0) {
        const cliCodexHome = mkdtempSync(join(tmpdir(), 'cbmcp-codex-home-cli-'));
        try {
          const res = spawnSync(
            process.execPath,
            [resolve(ROOT_DIR, 'scripts/install-local.mjs'), '--codex'],
            {
              cwd: ROOT_DIR,
              env: {
                ...process.env,
                CODEX_HOME: cliCodexHome,
              },
              encoding: 'utf8',
              timeout: 15_000,
            },
          );
          expect(res.status).toBe(0);
          const listRes = spawnSync('codex', ['plugin', 'list'], {
            env: { ...process.env, CODEX_HOME: cliCodexHome },
            encoding: 'utf8',
            timeout: 15_000,
          });
          expect(listRes.stdout).toMatch(
            new RegExp(
              `chrome-browser-mcp@chrome-browser-mcp\\s+installed,\\s+enabled\\s+${expectedVersion.replaceAll('.', '\\.')}`,
            ),
          );
        } finally {
          rmSync(cliCodexHome, { recursive: true, force: true });
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // 3. OpenChamber Desktop Extension & Loopback Service Proxy
  // -------------------------------------------------------------------------
  describe('OpenChamber Desktop extension', () => {
    it('enforces Bearer auth, serves Work Status, and proxies /deck-tool to Broker', async () => {
      const serviceToken = 'openchamber-test-token-12345';
      const srv = createOpenChamberServiceServer(serviceToken, {
        port: brokerPort,
        dataDir: tempDir,
      });

      await new Promise<void>((res) => srv.listen(0, '127.0.0.1', () => res()));
      const { port } = srv.address() as AddressInfo;
      const base = `http://127.0.0.1:${port}`;

      try {
        const unauth = await fetch(`${base}/health`);
        expect(unauth.status).toBe(401);

        const health = await fetch(`${base}/health`, {
          headers: { authorization: `Bearer ${serviceToken}` },
        });
        expect(health.status).toBe(200);

        const statusRes = await fetch(`${base}/status`, {
          headers: { authorization: `Bearer ${serviceToken}` },
        });
        expect(statusRes.status).toBe(200);
        const statusJson = (await statusRes.json()) as {
          rows: unknown[];
          controls: Array<{ id: string }>;
        };
        expect(statusJson.rows.length).toBeGreaterThan(0);
        expect(statusJson.controls.some((c) => c.id === 'pause' || c.id === 'resume')).toBe(true);

        const toolRes = await fetch(`${base}/deck-tool`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${serviceToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ name: 'deck_create_pin', arguments: {} }),
        });
        expect(toolRes.status).toBe(200);
        const toolJson = (await toolRes.json()) as {
          ok: boolean;
          structuredContent: { pin: string };
        };
        expect(toolJson.ok).toBe(true);
        expect(toolJson.structuredContent.pin).toMatch(/^\d{6}$/);
      } finally {
        await new Promise<void>((res) => srv.close(() => res()));
      }
    });

    it('ships valid manifest and prebuilt IIFE panel + service + bundled server + opencodePlugin without npx fallback', () => {
      const manifest = JSON.parse(
        readFileSync(resolve(ROOT_DIR, 'plugins/openchamber/package.json'), 'utf8'),
      );
      expect(manifest.openchamber.apiVersion).toBe(1);
      expect(manifest.openchamber.contributes.panel.entry).toBe('panel/index.html');
      expect(manifest.openchamber.contributes.statusSection.entry).toBe('status/index.html');
      expect(manifest.openchamber.contributes.service.entry).toBe('service/main.js');
      expect(manifest.openchamber.contributes.opencodePlugin).toBe('opencode-plugin');
      expect(existsSync(resolve(ROOT_DIR, 'plugins/openchamber/panel/main.js'))).toBe(true);
      expect(existsSync(resolve(ROOT_DIR, 'plugins/openchamber/panel/styles.css'))).toBe(true);
      expect(existsSync(resolve(ROOT_DIR, 'plugins/openchamber/status/index.html'))).toBe(true);
      expect(existsSync(resolve(ROOT_DIR, 'plugins/openchamber/service/main.js'))).toBe(true);
      expect(existsSync(resolve(ROOT_DIR, 'plugins/openchamber/server/cli.js'))).toBe(true);
      expect(existsSync(resolve(ROOT_DIR, 'plugins/openchamber/server/app/deck.html'))).toBe(true);
      expect(existsSync(resolve(ROOT_DIR, 'plugins/openchamber/opencode-plugin/index.js'))).toBe(true);

      const serviceBundle = readFileSync(resolve(ROOT_DIR, 'plugins/openchamber/service/main.js'), 'utf8');
      const ocPlugin = readFileSync(
        resolve(ROOT_DIR, 'plugins/openchamber/opencode-plugin/index.js'),
        'utf8',
      );
      expect(serviceBundle).not.toContain('chrome-browser-mcp@');
      expect(ocPlugin).not.toContain('chrome-browser-mcp@');
    });

    it('runs cleanly from an isolated copy outside the repo and diagnoses stale brokers clearly', async () => {
      const copyRoot = mkdtempSync(join(tmpdir(), 'cbmcp-openchamber-copy-'));
      const extCopy = join(copyRoot, 'chrome-browser-mcp');
      cpSync(resolve(ROOT_DIR, 'plugins/openchamber'), extCopy, { recursive: true });

      const staleBroker = createServer((req, res) => {
        if (req.url === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, version: '2.1.0', activeLeases: 3 }));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Unknown internal route' }));
      });
      await new Promise<void>((r) => staleBroker.listen(0, '127.0.0.1', () => r()));
      const stalePort = (staleBroker.address() as AddressInfo).port;

      const svc = createOpenChamberServiceServer('stale-check-tok', {
        port: stalePort,
        dataDir: tempDir,
      });
      await new Promise<void>((r) => svc.listen(0, '127.0.0.1', () => r()));
      const svcPort = (svc.address() as AddressInfo).port;

      try {
        // 1. Copied opencode-plugin resolves bundled server/cli.js inside the copy
        const copiedOcPlugin = (await import(join(extCopy, 'opencode-plugin/index.js'))) as {
          resolveServerCommand: () => string[] | null;
        };
        const cmd = copiedOcPlugin.resolveServerCommand();
        expect(cmd).not.toBeNull();
        expect(realpathSync(cmd?.[1] ?? '')).toBe(realpathSync(join(extCopy, 'server/cli.js')));

        // 2. Stale broker (404 on /internal/deck-tool) produces clear actionable error
        const res = await fetch(`http://127.0.0.1:${svcPort}/deck-tool`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer stale-check-tok',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ name: 'deck_get_state', arguments: {} }),
        });
        expect(res.status).toBe(502);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain('v2.1.0');
        expect(body.error).toContain('/internal/deck-tool');
      } finally {
        await new Promise<void>((r) => svc.close(() => r()));
        await new Promise<void>((r) => staleBroker.close(() => r()));
        rmSync(copyRoot, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // 4. OpenCode Desktop GUI Plugin
  // -------------------------------------------------------------------------
  describe('OpenCode Desktop GUI plugin', () => {
    it('server plugin auto-registers chrome-browser MCP via ctx.mcp.transform', async () => {
      const mod = (await import('../plugins/opencode/bundle/server.js')) as {
        default: { id: string; setup: (ctx: unknown) => Promise<void> };
      };
      expect(mod.default.id).toBe('chrome-browser-mcp');

      const servers = new Map<string, unknown>();
      await mod.default.setup({
        mcp: {
          async transform(
            cb: (editor: { get: (k: string) => unknown; set: (k: string, v: unknown) => void }) => void,
          ) {
            cb({
              get: (k) => servers.get(k),
              set: (k, v) => servers.set(k, v),
            });
          },
        },
      });

      const cfg = servers.get('chrome-browser') as { type: string; command: string[]; enabled: boolean };
      expect(cfg.type).toBe('local');
      expect(cfg.enabled).toBe(true);
      expect(cfg.command).toContain('stdio');
    });

    it('prebuilt ./gui-experimental CJS bundle keeps OpenCode runtime modules external and has no npx fallback', () => {
      const pkg = JSON.parse(readFileSync(resolve(ROOT_DIR, 'plugins/opencode/package.json'), 'utf8'));
      expect(pkg.exports['./gui-experimental']).toBe('./bundle/gui-experimental.cjs');
      expect(existsSync(resolve(ROOT_DIR, 'plugins/opencode/server/cli.js'))).toBe(true);
      expect(existsSync(resolve(ROOT_DIR, 'plugins/opencode/server/app/deck.html'))).toBe(true);

      const bundle = readFileSync(resolve(ROOT_DIR, 'plugins/opencode/bundle/gui-experimental.cjs'), 'utf8');
      const serverBundle = readFileSync(resolve(ROOT_DIR, 'plugins/opencode/bundle/server.js'), 'utf8');
      expect(bundle).toContain('require("@opencode/plugin/gui")');
      expect(bundle).toContain('require("effect")');
      expect(bundle).toContain('require("solid-js")');
      expect(bundle).not.toContain('chrome-browser-mcp@');
      expect(serverBundle).not.toContain('chrome-browser-mcp@');
    });

    it('resolves bundled server/cli.js when copied outside the repository', async () => {
      const copyRoot = mkdtempSync(join(tmpdir(), 'cbmcp-opencode-copy-'));
      const pluginCopy = join(copyRoot, 'opencode-chrome-browser-mcp');
      cpSync(resolve(ROOT_DIR, 'plugins/opencode'), pluginCopy, { recursive: true });
      try {
        const copiedMod = (await import(join(pluginCopy, 'bundle/server.js'))) as {
          resolveServerCommand: () => string[] | null;
        };
        const cmd = copiedMod.resolveServerCommand();
        expect(cmd).not.toBeNull();
        expect(realpathSync(cmd?.[1] ?? '')).toBe(realpathSync(join(pluginCopy, 'server/cli.js')));
      } finally {
        rmSync(copyRoot, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // 5. Claude Desktop Mod & MCPB Bundle
  // -------------------------------------------------------------------------
  describe('Claude Desktop Mod & MCPB manifest', () => {
    it('registers /browser-deck, renders 5-tab Desktop Pane & AbovePrompt via sandboxed $ APIs', async () => {
      resetModStateForTest();
      type Handler = (
        api: ClaudeModApi,
        ev: Record<string, unknown>,
        next: (e: Record<string, unknown>) => unknown,
      ) => Promise<unknown>;
      const hooks: Array<{ event: string; matcher?: Record<string, unknown>; handler: Handler }> = [];
      const registeredCommands: Array<{ name: string; immediate?: boolean }> = [];
      const openedPanes: Array<{ id: string; title?: string }> = [];
      const store = new Map<string, unknown>();
      let invalidateCount = 0;

      const makeEl =
        (tag: string) =>
        (props: Record<string, unknown> = {}) => ({ tag, ...props });

      const envVars: Record<string, string | undefined> = {
        CHROME_BROWSER_MCP_PORT: String(brokerPort),
        CHROME_BROWSER_MCP_DATA_DIR: tempDir,
      };

      const mockApi: ClaudeModApi = {
        env: {
          async get(name) {
            return envVars[name];
          },
        },
        fs: {
          async exists(path) {
            return existsSync(path);
          },
          async read(path) {
            return readFileSync(path, 'utf8');
          },
        },
        http: {
          async fetch(url, init) {
            const res = await fetch(url, {
              method: init?.method,
              headers: init?.headers,
              body: init?.body,
            });
            return {
              status: res.status,
              ok: res.ok,
              text: await res.text(),
            };
          },
        },
        store: {
          async get(k) {
            return store.get(k);
          },
          async set(k, v) {
            store.set(k, v);
          },
        },
        clock: {
          every() {
            // no-op timer in unit test
          },
        },
        command: {
          async register(def) {
            registeredCommands.push(def);
          },
        },
        ui: {
          async open(opts) {
            openedPanes.push(opts);
            return { isPlaced: true };
          },
          async close() {},
          invalidate() {
            invalidateCount += 1;
          },
          resolve() {
            return {
              Box: makeEl('Box'),
              Text: makeEl('Text'),
              Button: makeEl('Button'),
              Input: makeEl('Input'),
              Select: makeEl('Select'),
              Link: makeEl('Link'),
              Svg: makeEl('Svg'),
            };
          },
        },
      };

      registerClaudeMod((event, matcherOrHandler, maybeHandler) => {
        if (typeof matcherOrHandler === 'function') {
          hooks.push({ event, handler: matcherOrHandler as Handler });
        } else if (maybeHandler) {
          hooks.push({ event, matcher: matcherOrHandler, handler: maybeHandler as Handler });
        }
      });

      const findHook = (event: string, matcherKey?: string, matcherVal?: string) =>
        hooks.find((h) => h.event === event && (!matcherKey || h.matcher?.[matcherKey] === matcherVal));

      // 1. session.start
      await findHook('session.start')?.handler(mockApi, {}, (e) => e);
      expect(registeredCommands.some((c) => c.name === 'browser-deck' && c.immediate === true)).toBe(true);

      // 2. /browser-deck command opens side Pane
      await findHook('command.run', 'command', 'browser-deck')?.handler(mockApi, { args: '' }, (e) => e);
      expect(openedPanes.some((p) => p.id === PANE_ID)).toBe(true);

      // Wait briefly for initial broker fetch
      await new Promise((r) => setTimeout(r, 80));
      expect(invalidateCount).toBeGreaterThan(0);

      // 3. Render Desktop Pane
      const paneTree = (await findHook('ui.render', 'component', 'Pane')?.handler(
        mockApi,
        { requestId: PANE_ID, surface: 'desktop' },
        (e) => e,
      )) as { tag: string; children: unknown[] };
      expect(paneTree.tag).toBe('Box');
      const serializedPane = JSON.stringify(paneTree);
      expect(serializedPane).toContain('Browser Control Deck');
      expect(serializedPane).toContain('tab-overview');
      expect(serializedPane).toContain('tab-timeline');
      expect(serializedPane).toContain('tab-devtools');
      expect(serializedPane).toContain('tab-workflows');
      expect(serializedPane).toContain('tab-security');
      expect(serializedPane).toContain('"tag":"Svg"');

      // 4. Render AbovePrompt status bar
      const bandTree = (await findHook('ui.render', 'component', 'AbovePrompt')?.handler(
        mockApi,
        { props: { hasSurvey: false } },
        (e) => e,
      )) as { tag: string };
      expect(bandTree.tag).toBe('Box');
      expect(JSON.stringify(bandTree)).toContain('band-deck');

      // 5. /browser-deck pin command generates 6-digit PIN
      const pinCmdRes = (await findHook('command.run', 'command', 'browser-deck')?.handler(
        mockApi,
        { args: 'pin' },
        (e) => e,
      )) as { text: string };
      expect(pinCmdRes.text).toMatch(/Pairing PIN: \d{6}/);
    });

    it('ships Claude Code validator-compliant hooks/register.js, self-contained server, and patched LTS Node floor', () => {
      const rootPkg = JSON.parse(readFileSync(resolve(ROOT_DIR, 'package.json'), 'utf8'));
      const claudePlugin = JSON.parse(
        readFileSync(resolve(ROOT_DIR, 'plugins/claude/.claude-plugin/plugin.json'), 'utf8'),
      );
      const mcpbManifest = JSON.parse(
        readFileSync(resolve(ROOT_DIR, 'plugins/claude/mcpb/manifest.json'), 'utf8'),
      );
      expect(claudePlugin.name).toBe('chrome-browser-mcp');
      expect(mcpbManifest.manifest_version).toBe('0.3');
      expect(rootPkg.engines.node).toBe('^22.23.0 || ^24.19.0 || >=26.0.0');
      expect(mcpbManifest.compatibility.runtimes.node).toBe('>=22.23.0');
      expect(existsSync(resolve(ROOT_DIR, 'plugins/claude/hooks/register.js'))).toBe(true);
      expect(existsSync(resolve(ROOT_DIR, 'plugins/claude/.mcp.json'))).toBe(true);
      expect(existsSync(resolve(ROOT_DIR, 'plugins/claude/server/cli.js'))).toBe(true);
      expect(existsSync(resolve(ROOT_DIR, 'plugins/claude/server/app/deck.html'))).toBe(true);

      // Static checks mirroring `claude plugin validate` rules on hooks/register.js
      const bundle = readFileSync(resolve(ROOT_DIR, 'plugins/claude/hooks/register.js'), 'utf8');
      // 1. No bare/Node imports (only relative paths or `claude-code` are allowed)
      const importSpecifiers = [...bundle.matchAll(/^\s*import\s+[\s\S]*?from\s+["']([^"']+)["']/gm)].map(
        (m) => m[1] ?? '',
      );
      for (const spec of importSpecifiers) {
        expect(spec === 'claude-code' || spec.startsWith('./') || spec.startsWith('../')).toBe(true);
      }
      expect(bundle).not.toContain('node:child_process');
      expect(bundle).not.toContain('node:fs');
      expect(bundle).not.toContain('node:os');
      expect(bundle).not.toContain('node:path');
      expect(bundle).not.toContain('node:url');
      // 2. No CommonJS require, dynamic import(), Node globals, timer globals, or npx fallback
      expect(bundle).not.toMatch(/\brequire\s*\(/);
      expect(bundle).not.toMatch(/\bimport\s*\(/);
      expect(bundle).not.toMatch(/\bprocess\./);
      expect(bundle).not.toMatch(/\bsetTimeout\s*\(/);
      expect(bundle).not.toContain('chrome-browser-mcp@');
      expect(bundle).not.toContain('npx');
      // 3. No aliasing `$` or its namespaces, and all $.env.get() calls use string literals
      expect(bundle).not.toMatch(/\bconst\s+\$\s*=/);
      expect(bundle).not.toMatch(/\bconst\s+\w+\s*=\s*\$\.\w+\s*[;,]/);
      const envGets = [...bundle.matchAll(/\$\.env\.get\(([^)]+)\)/g)];
      expect(envGets.length).toBeGreaterThan(0);
      for (const m of envGets) {
        expect(m[1]?.trim()).toMatch(/^["'][A-Z0-9_]+["']$/);
      }
      // 4. Exports top-level register(on) function
      expect(bundle).toMatch(/function register\(on\)/);
      // 5. Claude launcher fails closed without npx when bundled server is removed
      const claudeLauncher = readFileSync(resolve(ROOT_DIR, 'plugins/claude/bin/start-server.sh'), 'utf8');
      expect(claudeLauncher).not.toContain('npx');
      expect(claudeLauncher).not.toContain('chrome-browser-mcp@');

      const brokenClaude = mkdtempSync(join(tmpdir(), 'cbmcp-claude-broken-'));
      cpSync(resolve(ROOT_DIR, 'plugins/claude'), brokenClaude, { recursive: true });
      rmSync(join(brokenClaude, 'server'), { recursive: true, force: true });
      try {
        const res = spawnSync('bash', ['./bin/start-server.sh'], {
          cwd: brokenClaude,
          env: { HOME: homedir(), PATH: process.env.PATH ?? '/usr/bin:/bin' },
          encoding: 'utf8',
          timeout: 5000,
        });
        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('bundled server CLI not found');
      } finally {
        rmSync(brokenClaude, { recursive: true, force: true });
      }
    });
  });
});
