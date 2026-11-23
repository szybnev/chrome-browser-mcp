import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startBrokerDaemon, type BrokerDaemonHandle } from './broker.js';
import { APP_VERSION, type BrokerToExtensionMessage } from '@chrome-browser-mcp/protocol';

const cleanupDirs: string[] = [];
let activeBroker: BrokerDaemonHandle | null = null;

afterEach(async () => {
  if (activeBroker) {
    await activeBroker.close();
    activeBroker = null;
  }
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cbmcp-test-'));
  cleanupDirs.push(dir);
  return dir;
}

function connectMockExtension(wsUrl: string, token: string, profileId: string) {
  return new Promise<{ ws: WebSocket; welcome: BrokerToExtensionMessage }>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.once('open', () => {
      ws.send(
        JSON.stringify({
          type: 'hello',
          token,
          profile: {
            profileId,
            browserName: 'Chrome',
            label: profileId,
            extensionVersion: APP_VERSION,
            connectedAt: Date.now(),
            lastSeenAt: Date.now(),
            tabGroupId: 42,
            allowAllTabs: false,
            paused: false,
            tabCount: 1,
          },
        }),
      );
    });
    ws.once('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8')) as BrokerToExtensionMessage;
      resolve({ ws, welcome: msg });
    });
    ws.once('close', (code) => {
      reject(new Error(`Closed with code ${code}`));
    });
  });
}

describe('Broker Daemon, WebSocket Hub & Streamable HTTP MCP', () => {
  it('exposes /health without leaking token and rejects bad WS tokens', async () => {
    const port = 44000 + Math.floor(Math.random() * 1000);
    activeBroker = await startBrokerDaemon({ port, dataDir: createTempDataDir() });

    const healthRes = await fetch(`${activeBroker.config.brokerUrl}/health`);
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as Record<string, unknown>;
    expect(health.ok).toBe(true);
    expect(JSON.stringify(health)).not.toContain(activeBroker.config.token);

    // Bad pairing token must close with 4001
    await expect(
      connectMockExtension(activeBroker.config.wsUrl, 'wrong-token-1234', 'chrome-bad'),
    ).rejects.toThrow(/4001/);
  });

  it('supports multi-profile routing, pause guard, and approval gates', async () => {
    const port = 45000 + Math.floor(Math.random() * 1000);
    activeBroker = await startBrokerDaemon({ port, dataDir: createTempDataDir() });

    const ext1 = await connectMockExtension(
      activeBroker.config.wsUrl,
      activeBroker.config.token,
      'chrome-work',
    );
    const ext2 = await connectMockExtension(
      activeBroker.config.wsUrl,
      activeBroker.config.token,
      'arc-personal',
    );

    ext1.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8')) as BrokerToExtensionMessage;
      if (msg.type === 'rpc.request') {
        ext1.ws.send(
          JSON.stringify({
            type: 'rpc.response',
            id: msg.id,
            ok: true,
            result: { pong: true, from: 'chrome-work' },
          }),
        );
      }
    });

    const { profiles, defaultProfileId } = await activeBroker.hub.listProfiles();
    expect(profiles).toHaveLength(2);
    expect(defaultProfileId).toBe('chrome-work');

    const rpcRes = await activeBroker.hub.callExtension<{ from: string }>('ping');
    expect(rpcRes.profileId).toBe('chrome-work');
    expect(rpcRes.data.from).toBe('chrome-work');

    // Pause blocks subsequent RPCs
    await activeBroker.hub.setPaused(true);
    await expect(activeBroker.hub.callExtension('ping')).rejects.toThrow(/PAUSED/);
    await activeBroker.hub.setPaused(false);

    // Risky eval approval pauses until approved
    const approvalPromise = activeBroker.hub.requestApprovalIfNeeded({
      profileId: 'chrome-work',
      tabId: 1,
      origin: 'https://app.example.com',
      action: 'browser_eval',
      reason: 'Evaluate JS',
      risk: 'high',
      preview: 'document.title',
      kind: 'eval',
    });

    const state = await activeBroker.hub.getDeckState();
    expect(state.pendingApprovals).toHaveLength(1);
    await activeBroker.hub.resolveApproval(state.pendingApprovals[0]!.id, 'approved');
    await expect(approvalPromise).resolves.toBeUndefined();

    ext1.ws.close();
    ext2.ws.close();
  });

  it('serves MCP tools and SEP-1865 MCP App resource over Streamable HTTP /mcp', async () => {
    const port = 46000 + Math.floor(Math.random() * 1000);
    activeBroker = await startBrokerDaemon({ port, dataDir: createTempDataDir() });

    const mcpPost = async (body: unknown) => {
      const res = await fetch(activeBroker!.config.mcpUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      if (res.headers.get('content-type')?.includes('text/event-stream')) {
        const dataLine = text
          .split('\n')
          .find((l) => l.startsWith('data: '));
        return JSON.parse(dataLine!.slice(6));
      }
      return JSON.parse(text);
    };

    const toolsList = await mcpPost({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    const tools = toolsList.result.tools as Array<{
      name: string;
      inputSchema?: { properties?: Record<string, unknown> };
    }>;
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('browser_snapshot');
    expect(toolNames).toContain('browser_act');
    expect(toolNames).toContain('browser_webmcp_list');
    expect(toolNames).toContain('browser_workflows');
    expect(toolNames).toContain('browser_deck');

    const readTool = tools.find((t) => t.name === 'browser_read');
    expect(readTool?.inputSchema?.properties).toHaveProperty('offset');
    expect(readTool?.inputSchema?.properties).toHaveProperty('scope');
    expect(readTool?.inputSchema?.properties).toHaveProperty('format');

    expect(toolNames).toContain('browser_dialog');
    expect(toolNames).toContain('browser_downloads');
    expect(toolNames).toContain('browser_emulate');
    expect(toolNames).toContain('browser_audit_export');

    const resRead = await mcpPost({
      jsonrpc: '2.0',
      id: 2,
      method: 'resources/read',
      params: { uri: 'ui://chrome-browser/deck.html' },
    });
    const contents = resRead.result.contents as Array<{ mimeType: string; text: string }>;
    expect(contents[0]?.mimeType).toBe('text/html;profile=mcp-app');
    expect(contents[0]?.text).toContain('Browser Control Deck');
  });

  it('supports 6-digit single-use PIN pairing, Zero-Secret env resolution, opt-in CDP proxy & audit export', async () => {
    const port = 47000 + Math.floor(Math.random() * 1000);
    const dataDir = createTempDataDir();
    writeFileSync(join(dataDir, 'secrets.env'), 'STAGING_PASS="s3cr3t-v2-pass"\n', 'utf8');
    activeBroker = await startBrokerDaemon({ port, dataDir });

    // 1. 6-digit PIN pairing flow
    const { pin } = activeBroker.createPairingPin();
    expect(pin).toMatch(/^\d{6}$/);

    const badPin = await fetch(`${activeBroker.config.brokerUrl}/pair/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: '000000' }),
    });
    expect(badPin.status).toBe(401);

    const goodPin = await fetch(`${activeBroker.config.brokerUrl}/pair/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    expect(goodPin.status).toBe(200);
    const pairJson = (await goodPin.json()) as { ok: boolean; data: { token: string } };
    expect(pairJson.data.token).toBe(activeBroker.config.token);

    // Single-use PIN cannot be reused
    const reusePin = await fetch(`${activeBroker.config.brokerUrl}/pair/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    expect(reusePin.status).toBe(401);

    // 1b. Browser-native /pair page (1-click PIN via CSRF nonce, no npx/terminal required)
    const pairPage = await fetch(`${activeBroker.config.brokerUrl}/pair`);
    expect(pairPage.status).toBe(200);
    const pairHtml = await pairPage.text();
    const nonceMatch = /const nonce = "([^"]+)"/.exec(pairHtml);
    expect(nonceMatch?.[1]).toBeTruthy();

    const badNonceRes = await fetch(`${activeBroker.config.brokerUrl}/pair/request-pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: 'wrong-nonce' }),
    });
    expect(badNonceRes.status).toBe(403);

    const browserPinRes = await fetch(`${activeBroker.config.brokerUrl}/pair/request-pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: nonceMatch![1] }),
    });
    expect(browserPinRes.status).toBe(200);
    const browserPinJson = (await browserPinRes.json()) as { ok: boolean; data: { pin: string } };
    expect(browserPinJson.data.pin).toMatch(/^\d{6}$/);

    // 2. Zero-Secret resolution
    const secret = await activeBroker.hub.resolveSecret('env:STAGING_PASS');
    expect(secret.value).toBe('s3cr3t-v2-pass');
    expect(secret.maskedLabel).toBe('[SECRET:env:STAGING_PASS]');

    // 3. Opt-in CDP Proxy (disabled by default -> 403, enabled -> 200)
    const cdpOff = await fetch(`${activeBroker.config.brokerUrl}/json/version`);
    expect(cdpOff.status).toBe(403);

    await activeBroker.hub.updatePolicy({ cdpProxyEnabled: true });
    const cdpOn = await fetch(
      `${activeBroker.config.brokerUrl}/json/version?token=${encodeURIComponent(activeBroker.config.token)}`,
    );
    expect(cdpOn.status).toBe(200);
    const cdpMeta = (await cdpOn.json()) as { Browser: string; webSocketDebuggerUrl: string };
    expect(cdpMeta.Browser).toContain('Chrome-Browser-MCP');

    // 4. Audit Export (JSON + standalone HTML)
    const auditJson = await activeBroker.hub.exportAudit('json');
    expect(auditJson.contentType).toContain('application/json');
    expect(JSON.parse(auditJson.content).policySummary.cdpProxyEnabled).toBe(true);

    const auditHtml = await activeBroker.hub.exportAudit('html');
    expect(auditHtml.contentType).toContain('text/html');
    expect(auditHtml.content).toContain('Session Audit Report');
  });
});
