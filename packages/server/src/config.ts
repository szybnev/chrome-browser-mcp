import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_BROKER_HOST,
  DEFAULT_BROKER_PORT,
  type RecordedWorkflow,
  RecordedWorkflowSchema,
  type SecurityPolicy,
  SecurityPolicySchema,
} from '@chrome-browser-mcp/protocol';
import { z } from 'zod';

export interface BrokerConfig {
  host: string;
  port: number;
  dataDir: string;
  token: string;
  brokerUrl: string;
  wsUrl: string;
  mcpUrl: string;
}

export function resolveDataDir(explicitDir?: string): string {
  const dir =
    explicitDir || process.env.CHROME_BROWSER_MCP_DATA_DIR || join(homedir(), '.chrome-browser-mcp');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function loadOrCreateToken(dataDir: string, rotate = false): string {
  const envToken = process.env.CHROME_BROWSER_MCP_TOKEN?.trim();
  if (envToken && !rotate) {
    return envToken;
  }

  const tokenFile = join(dataDir, 'token.txt');
  if (!rotate && existsSync(tokenFile)) {
    const existing = readFileSync(tokenFile, 'utf8').trim();
    if (existing.length >= 16) {
      return existing;
    }
  }

  const fresh = randomBytes(24).toString('hex');
  writeFileSync(tokenFile, `${fresh}\n`, { mode: 0o600 });
  try {
    chmodSync(tokenFile, 0o600);
  } catch {
    // Ignore on platforms where chmod is unsupported
  }
  return fresh;
}

export function loadBrokerConfig(options?: { port?: number; dataDir?: string }): BrokerConfig {
  const host = DEFAULT_BROKER_HOST;
  const port =
    options?.port ??
    (process.env.CHROME_BROWSER_MCP_PORT ? Number(process.env.CHROME_BROWSER_MCP_PORT) : DEFAULT_BROKER_PORT);
  const dataDir = resolveDataDir(options?.dataDir);
  const token = loadOrCreateToken(dataDir);
  const brokerUrl = `http://${host}:${port}`;
  return {
    host,
    port,
    dataDir,
    token,
    brokerUrl,
    wsUrl: `ws://${host}:${port}/ws`,
    mcpUrl: `${brokerUrl}/mcp`,
  };
}

export function loadPersistedPolicy(dataDir: string): SecurityPolicy {
  const file = join(dataDir, 'policy.json');
  if (!existsSync(file)) {
    return SecurityPolicySchema.parse({});
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return SecurityPolicySchema.parse(parsed);
  } catch {
    return SecurityPolicySchema.parse({});
  }
}

export function savePersistedPolicy(dataDir: string, policy: SecurityPolicy): void {
  const file = join(dataDir, 'policy.json');
  writeFileSync(file, JSON.stringify(policy, null, 2), 'utf8');
}

export function loadPersistedWorkflows(dataDir: string): RecordedWorkflow[] {
  const file = join(dataDir, 'workflows.json');
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return z.array(RecordedWorkflowSchema).parse(parsed);
  } catch {
    return [];
  }
}

export function savePersistedWorkflows(dataDir: string, workflows: RecordedWorkflow[]): void {
  const file = join(dataDir, 'workflows.json');
  writeFileSync(file, JSON.stringify(workflows, null, 2), 'utf8');
}
