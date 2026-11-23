import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
const ACCOUNT_RE = /^[A-Za-z0-9._:@/-]{1,120}$/;

function parseSecretsEnvFile(filePath: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(filePath)) return map;
  const raw = readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (ENV_KEY_RE.test(key)) {
      map.set(key, val);
    }
  }
  return map;
}

/**
 * Resolves a Zero-Secret Autofill reference locally on the Broker so plaintext
 * credentials never enter the LLM prompt, MCP tool result, or activity logs.
 *
 * Supported schemes:
 * - `env:VAR_NAME`      -> reads `<dataDir>/secrets.env` (fallback: `process.env.CBMCP_SECRET_<VAR_NAME>`)
 * - `keychain:ACCOUNT`  -> reads macOS Keychain item under service `chrome-browser-mcp`
 */
export async function resolveSecretRef(
  secretRef: string,
  dataDir: string,
): Promise<{ value: string; maskedLabel: string }> {
  const trimmed = secretRef.trim();
  const colon = trimmed.indexOf(':');
  if (colon <= 0) {
    throw new Error(
      `Invalid secretRef "${trimmed}". Expected "env:VAR_NAME" or "keychain:ACCOUNT".`,
    );
  }

  const scheme = trimmed.slice(0, colon).toLowerCase();
  const key = trimmed.slice(colon + 1).trim();
  const maskedLabel = `[SECRET:${scheme}:${key}]`;

  if (scheme === 'env') {
    if (!ENV_KEY_RE.test(key)) {
      throw new Error(`Invalid env secret name "${key}" (expected UPPER_SNAKE_CASE).`);
    }
    const secretsFile = resolve(dataDir, 'secrets.env');
    const fileMap = parseSecretsEnvFile(secretsFile);
    const fromFile = fileMap.get(key);
    if (fromFile !== undefined) {
      return { value: fromFile, maskedLabel };
    }
    const prefixedEnv = process.env[`CBMCP_SECRET_${key}`];
    if (prefixedEnv !== undefined) {
      return { value: prefixedEnv, maskedLabel };
    }
    throw new Error(
      `Secret "${key}" not found in ${secretsFile} or env CBMCP_SECRET_${key}.`,
    );
  }

  if (scheme === 'keychain') {
    if (process.platform !== 'darwin') {
      throw new Error('keychain: secretRef is currently supported on macOS only (use env: on Linux/Windows).');
    }
    if (!ACCOUNT_RE.test(key)) {
      throw new Error(`Invalid keychain account name "${key}".`);
    }
    try {
      const { stdout } = await execFileAsync(
        'security',
        ['find-generic-password', '-s', 'chrome-browser-mcp', '-a', key, '-w'],
        { timeout: 5000 },
      );
      const val = stdout.replace(/\r?\n$/, '');
      if (!val) {
        throw new Error(`Keychain entry "${key}" under service "chrome-browser-mcp" is empty.`);
      }
      return { value: val, maskedLabel };
    } catch {
      throw new Error(
        `Keychain entry "${key}" not found (add with: security add-generic-password -s chrome-browser-mcp -a ${key} -w).`,
      );
    }
  }

  throw new Error(`Unsupported secretRef scheme "${scheme}". Use "env:" or "keychain:".`);
}
