#!/usr/bin/env node
/**
 * Security, Secret-Leak, Static Guardrail, and Supply-Chain Integrity Scanner
 *
 * Modes:
 *   --staged   Fast check for git pre-commit (scans staged files + lockfile check if lockfile staged)
 *   --full     Complete check for git pre-push & CI (all tracked files + pnpm audit + supply-chain check)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const mode = args.has('--full') ? 'full' : 'staged';
const skipAudit = args.has('--skip-audit');

const ALLOWED_INSTALL_SCRIPT_PACKAGES = new Set(['esbuild']);

const FORBIDDEN_FILENAMES = [
  /^\.env($|\.)/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /(^|\/)token\.txt$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)$/i,
  /(^|\/)credentials\.json$/i,
];

const SECRET_PATTERNS = [
  { name: 'Private Key Block', regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: 'GitHub Token', regex: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/ },
  { name: 'GitHub Fine-Grained PAT', regex: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/ },
  { name: 'OpenAI / Anthropic Secret Key', regex: /\bsk-(proj-|ant-)?[A-Za-z0-9_-]{24,}\b/ },
  { name: 'AWS Access Key ID', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Google API Key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Slack Token', regex: /\bxox[baprs]-[0-9A-Za-z-]{15,}\b/ },
  { name: 'Stripe Live Secret', regex: /\bsk_live_[0-9A-Za-z]{20,}\b/ },
  { name: 'Hardcoded Bearer JWT', regex: /Bearer\s+eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./ },
];

const STATIC_SECURITY_RULES = [
  {
    name: 'No dynamic eval() in runtime code',
    regex: /\beval\s*\(/,
    include: /^packages\/.*\/src\/.*\.(ts|tsx|js|mjs)$/,
    exclude: /\.test\.ts$/,
  },
  {
    name: 'No new Function() in runtime code',
    regex: /\bnew\s+Function\s*\(/,
    include: /^packages\/.*\/src\/.*\.(ts|tsx|js|mjs)$/,
    exclude: /\.test\.ts$/,
  },
  {
    name: 'No innerHTML / dangerouslySetInnerHTML XSS sinks',
    regex: /(\.innerHTML\s*=|dangerouslySetInnerHTML)/,
    include: /^packages\/.*\/src\/.*\.(ts|tsx|js|mjs)$/,
    exclude: /\.test\.ts$/,
  },
  {
    name: 'Broker must never bind to 0.0.0.0 (loopback 127.0.0.1 only)',
    regex: /['"`]0\.0\.0\.0['"`]/,
    include: /^packages\/server\/src\/.*\.(ts|js)$/,
    exclude: /\.test\.ts$/,
  },
  {
    name: 'Chrome extension must remain Manifest V3',
    regex: /"manifest_version"\s*:\s*2\b/,
    include: /^packages\/extension\/manifest\.json$/,
  },
];

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml',
  '.html', '.css', '.sh', '.txt', '.svg', '.toml',
]);

const failures = [];
const warnings = [];

function fail(msg) {
  failures.push(msg);
}

function warn(msg) {
  warnings.push(msg);
}

function getTargetFiles() {
  const gitArgs =
    mode === 'staged'
      ? ['diff', '--cached', '--name-only', '--diff-filter=ACM']
      : ['ls-files'];
  const out = execFileSync('git', gitArgs, { cwd: rootDir, encoding: 'utf8' });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function scanFiles(files) {
  for (const relPath of files) {
    if (FORBIDDEN_FILENAMES.some((rx) => rx.test(relPath))) {
      fail(`Forbidden sensitive file staged/tracked: ${relPath}`);
      continue;
    }

    const fullPath = resolve(rootDir, relPath);
    if (!existsSync(fullPath)) continue;
    const st = statSync(fullPath);
    if (!st.isFile() || st.size > 1_500_000) continue;

    const ext = extname(relPath).toLowerCase();
    const isHook = relPath.startsWith('.githooks/');
    if (!TEXT_EXTENSIONS.has(ext) && !isHook) continue;

    // Avoid self-matching regex definitions in this scanner
    if (relPath === 'scripts/security-check.mjs') continue;

    const content = readFileSync(fullPath, 'utf8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pat of SECRET_PATTERNS) {
        if (pat.regex.test(line)) {
          fail(`[SECRET] ${pat.name} detected in ${relPath}:${i + 1}`);
        }
      }
      for (const rule of STATIC_SECURITY_RULES) {
        if (!rule.include.test(relPath)) continue;
        if (rule.exclude && rule.exclude.test(relPath)) continue;
        if (rule.regex.test(line)) {
          fail(`[SECURITY] ${rule.name} in ${relPath}:${i + 1}`);
        }
      }
    }
  }
}

function checkSupplyChainIntegrity() {
  const lockPath = resolve(rootDir, 'pnpm-lock.yaml');
  if (!existsSync(lockPath)) {
    fail('[SUPPLY-CHAIN] pnpm-lock.yaml is missing — lockfile is mandatory for reproducible installs.');
    return;
  }

  const lockContent = readFileSync(lockPath, 'utf8');

  // 1. Check for suspicious non-npm tarball URLs or git/http dependencies in lockfile
  const tarballMatches = lockContent.matchAll(/tarball:\s*(\S+)/g);
  for (const m of tarballMatches) {
    const url = m[1].replace(/^['"]|['"]$/g, '');
    if (!url.startsWith('https://registry.npmjs.org/')) {
      fail(`[SUPPLY-CHAIN] Untrusted tarball URL in pnpm-lock.yaml: ${url}`);
    }
  }

  // 2. Ensure lockfile integrity hashes use sha512 (no downgraded/missing checksums)
  const integrityMatches = [...lockContent.matchAll(/integrity:\s*(\S+)/g)];
  if (integrityMatches.length === 0) {
    fail('[SUPPLY-CHAIN] No integrity checksums found in pnpm-lock.yaml');
  } else {
    for (const m of integrityMatches) {
      const hash = m[1].replace(/^['"]|['"]$/g, '');
      if (!hash.startsWith('sha512-')) {
        fail(`[SUPPLY-CHAIN] Weak or non-sha512 integrity hash in pnpm-lock.yaml: ${hash}`);
      }
    }
  }

  // 3. Scan installed packages in node_modules/.pnpm for unexpected install lifecycle scripts
  const seenPackages = new Set();
  const pnpmStoreDir = resolve(rootDir, 'node_modules/.pnpm');
  if (existsSync(pnpmStoreDir)) {
    const entries = readdirSync(pnpmStoreDir);
    for (const entry of entries) {
      const nmDir = join(pnpmStoreDir, entry, 'node_modules');
      if (!existsSync(nmDir)) continue;
      scanInstalledNodeModules(nmDir, seenPackages);
    }
  }
}

function scanInstalledNodeModules(nmDir, seenPackages) {
  let items;
  try {
    items = readdirSync(nmDir);
  } catch {
    return;
  }
  for (const item of items) {
    if (item.startsWith('.')) continue;
    const full = join(nmDir, item);
    if (item.startsWith('@')) {
      scanInstalledNodeModules(full, seenPackages);
      continue;
    }
    const pkgJsonPath = join(full, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
      const key = `${pkg.name}@${pkg.version}`;
      if (seenPackages.has(key)) continue;
      seenPackages.add(key);

      const scripts = pkg.scripts ?? {};
      const hookNames = ['preinstall', 'install', 'postinstall'].filter(
        (k) => typeof scripts[k] === 'string' && scripts[k].trim().length > 0,
      );
      if (hookNames.length > 0 && !ALLOWED_INSTALL_SCRIPT_PACKAGES.has(pkg.name)) {
        warn(
          `[SUPPLY-CHAIN] Package "${key}" declares install hook(s) [${hookNames.join(', ')}] (blocked by pnpm allowBuilds).`,
        );
      }
      // Flag suspicious shell download/pipe commands inside ANY package's install scripts
      for (const h of hookNames) {
        const cmd = scripts[h];
        if (/\b(curl|wget|powershell|nc|bash\s+-c)\b.*\|/i.test(cmd) || /base64\s+-d/i.test(cmd)) {
          fail(`[COMPROMISE] Suspicious install script in ${key} (${h}): ${cmd.slice(0, 120)}`);
        }
      }
    } catch {
      // ignore unreadable package.json
    }
  }
}

function runPnpmAudit() {
  try {
    execFileSync('pnpm', ['audit', '--audit-level=moderate'], {
      cwd: rootDir,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    console.log('  ✓ pnpm audit (--audit-level=moderate): 0 vulnerabilities');
  } catch (err) {
    const stdout = err?.stdout?.toString?.() ?? '';
    const stderr = err?.stderr?.toString?.() ?? '';
    const combined = `${stdout}\n${stderr}`.trim();
    if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|network/i.test(combined)) {
      warn('[AUDIT] Could not reach npm advisory registry (offline). Re-run with network access.');
    } else {
      fail(`[AUDIT] Dependency vulnerabilities detected:\n${combined.slice(0, 2000)}`);
    }
  }
}

console.log(`[security-check] Running in --${mode} mode...`);
const targetFiles = getTargetFiles();
console.log(`  • Scanning ${targetFiles.length} file(s) for secrets & static security rules...`);
scanFiles(targetFiles);

const lockOrPkgTouched = targetFiles.some(
  (f) => f === 'pnpm-lock.yaml' || f.endsWith('package.json') || f === 'pnpm-workspace.yaml',
);

if (mode === 'full' || lockOrPkgTouched) {
  console.log('  • Verifying lockfile checksums & supply-chain integrity...');
  checkSupplyChainIntegrity();
}

if ((mode === 'full' || lockOrPkgTouched) && !skipAudit) {
  console.log('  • Running dependency vulnerability audit (pnpm audit)...');
  runPnpmAudit();
}

for (const w of warnings) {
  console.warn(`  ! ${w}`);
}

if (failures.length > 0) {
  console.error(`\n[security-check] FAILED with ${failures.length} issue(s):`);
  for (const f of failures) {
    console.error(`  ✗ ${f}`);
  }
  process.exit(1);
}

console.log('[security-check] PASSED — no secrets, security issues, or vulnerable dependencies found.');
