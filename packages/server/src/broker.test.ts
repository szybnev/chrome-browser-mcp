import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startBrokerDaemon, type BrokerDaemonHandle } from './broker.js';
import type { BrokerToExtensionMessage } from '@chrome-browser-mcp/protocol';

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
            extensionVersion: '0.1.0',
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
});
