#!/usr/bin/env node
/**
 * Packages a 1-click Claude Desktop `.mcpb` (MCP Bundle) archive for Claude Desktop's Chat tab.
 * Output: release/chrome-browser-mcp.mcpb
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

function loadEsbuild() {
  const req = createRequire(resolve(rootDir, 'package.json'));
  for (const base of [resolve(rootDir, 'package.json'), resolve(rootDir, 'packages/mcp-app/package.json')]) {
    try {
      return createRequire(base)('esbuild');
    } catch {
      // try next
    }
  }
  const pnpmDir = resolve(rootDir, 'node_modules/.pnpm');
  if (existsSync(pnpmDir)) {
    const match = readdirSync(pnpmDir).find((entry) => entry.startsWith('esbuild@'));
    if (match) {
      return req(resolve(pnpmDir, match, 'node_modules/esbuild'));
    }
  }
  throw new Error('Could not resolve esbuild from workspace node_modules');
}

const esbuild = loadEsbuild();

const serverCliSrc = resolve(rootDir, 'packages/server/dist/cli.js');
const deckHtmlSrc = resolve(rootDir, 'packages/server/dist/app/deck.html');
if (!existsSync(serverCliSrc) || !existsSync(deckHtmlSrc)) {
  console.error('[pack-mcpb] Server dist or deck.html missing. Run `pnpm build` first.');
  process.exit(1);
}

const releaseDir = resolve(rootDir, 'release');
const stageDir = resolve(releaseDir, '.mcpb-stage');
const outFile = resolve(releaseDir, 'chrome-browser-mcp.mcpb');

rmSync(stageDir, { recursive: true, force: true });
rmSync(outFile, { force: true });
mkdirSync(resolve(stageDir, 'server/app'), { recursive: true });

// Bundle self-contained Node server CLI (zero node_modules required inside .mcpb)
await esbuild.build({
  entryPoints: [serverCliSrc],
  outfile: resolve(stageDir, 'server/cli.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  banner: {
    js: "import { createRequire as __cbmcpCreateRequire } from 'node:module'; const require = __cbmcpCreateRequire(import.meta.url);",
  },
});

copyFileSync(deckHtmlSrc, resolve(stageDir, 'server/app/deck.html'));
copyFileSync(resolve(rootDir, 'plugins/claude/mcpb/manifest.json'), resolve(stageDir, 'manifest.json'));
copyFileSync(resolve(rootDir, 'packages/extension/public/icons/icon-128.png'), resolve(stageDir, 'icon.png'));

execFileSync('zip', ['-r', '-q', outFile, 'manifest.json', 'icon.png', 'server'], {
  cwd: stageDir,
  stdio: 'inherit',
});
rmSync(stageDir, { recursive: true, force: true });

console.log(`[pack-mcpb] Created Claude Desktop MCP Bundle -> ${outFile}`);
