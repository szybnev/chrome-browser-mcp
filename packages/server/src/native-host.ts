import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { loadBrokerConfig } from './config.js';

export const NATIVE_HOST_NAME = 'com.chromebrowsermcp.host';

function resolveNativeHostDir(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
  }
  if (process.platform === 'linux') {
    return join(homedir(), '.config', 'google-chrome', 'NativeMessagingHosts');
  }
  return join(homedir(), '.chrome-browser-mcp', 'native-messaging');
}

export function installNativeMessagingHost(options: {
  extensionId: string;
  dataDir?: string;
}): { manifestPath: string; wrapperPath: string } {
  const extId = options.extensionId.trim();
  if (!/^[a-p]{32}$/.test(extId)) {
    throw new Error(`Invalid Chrome extension ID "${extId}" (expected 32 lowercase letters a-p).`);
  }

  const config = loadBrokerConfig({ dataDir: options.dataDir });
  const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), 'cli.js');
  const wrapperPath = join(
    config.dataDir,
    process.platform === 'win32' ? 'native-host.cmd' : 'native-host.sh',
  );

  mkdirSync(config.dataDir, { recursive: true });
  if (process.platform === 'win32') {
    writeFileSync(wrapperPath, `@echo off\r\n"${process.execPath}" "${cliPath}" native-host\r\n`, 'utf8');
  } else {
    writeFileSync(
      wrapperPath,
      `#!/bin/sh\nexec "${process.execPath}" "${cliPath}" native-host\n`,
      { encoding: 'utf8', mode: 0o700 },
    );
    chmodSync(wrapperPath, 0o700);
  }

  const manifestDir = resolveNativeHostDir();
  mkdirSync(manifestDir, { recursive: true });
  const manifestPath = join(manifestDir, `${NATIVE_HOST_NAME}.json`);
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: 'Chrome Browser MCP Local Native Messaging Host',
    path: wrapperPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extId}/`],
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return { manifestPath, wrapperPath };
}

function writeNativeMessage(payload: unknown): void {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

/**
 * Runs a Chrome Native Messaging stdio bridge that forwards framed messages
 * between Chrome and the local Broker Daemon WebSocket (/ws).
 */
export async function runNativeMessagingHost(options?: {
  port?: number;
  dataDir?: string;
}): Promise<void> {
  const config = loadBrokerConfig(options);
  const ws = new WebSocket(config.wsUrl);
  const outboundQueue: string[] = [];

  ws.on('open', () => {
    while (outboundQueue.length > 0) {
      ws.send(outboundQueue.shift()!);
    }
  });

  ws.on('message', (raw) => {
    try {
      const parsed = JSON.parse(raw.toString('utf8'));
      writeNativeMessage(parsed);
    } catch {
      // ignore malformed frames
    }
  });

  ws.on('close', () => {
    process.exit(0);
  });

  let buffer = Buffer.alloc(0);
  process.stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const len = buffer.readUInt32LE(0);
      if (len > 4 * 1024 * 1024) {
        process.exit(1);
      }
      if (buffer.length < 4 + len) break;
      const msgStr = buffer.subarray(4, 4 + len).toString('utf8');
      buffer = buffer.subarray(4 + len);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msgStr);
      } else {
        outboundQueue.push(msgStr);
      }
    }
  });

  process.stdin.on('end', () => {
    ws.close();
    process.exit(0);
  });
}
