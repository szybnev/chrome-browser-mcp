#!/usr/bin/env node
/**
 * Builds prebuilt, self-contained artifacts for all desktop GUI harness plugins:
 *   1. Codex Desktop Plugin          (`plugins/codex/server/cli.js`, `server/app/deck.html`)
 *   2. OpenChamber Desktop Extension (`plugins/openchamber/panel/main.js`, `panel/styles.css`, `service/main.js`)
 *   3. OpenCode Desktop GUI Plugin   (`plugins/opencode/bundle/server.js`, `bundle/gui-experimental.cjs`)
 *   4. Claude Desktop Mod            (`plugins/claude/hooks/register.js`)
 *
 * Uses the workspace's pinned esbuild dev dependency.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const protocolEntry = resolve(rootDir, 'packages/protocol/dist/index.js');
const mcpAppNodeModules = resolve(rootDir, 'packages/mcp-app/node_modules');

const workspaceAliasPlugin = {
  name: 'workspace-aliases',
  setup(build) {
    build.onResolve({ filter: /^@chrome-browser-mcp\/protocol$/ }, () => ({
      path: protocolEntry,
    }));
  },
};

async function bundleStandaloneServer(pluginSubdir) {
  const serverCliSrc = resolve(rootDir, 'packages/server/dist/cli.js');
  const deckHtmlSrc = resolve(rootDir, 'packages/server/dist/app/deck.html');
  if (!existsSync(serverCliSrc) || !existsSync(deckHtmlSrc)) {
    throw new Error(
      '[build-plugins] packages/server/dist/cli.js or app/deck.html missing — run `pnpm build` first.',
    );
  }

  const serverOutDir = resolve(rootDir, pluginSubdir, 'server');
  const appOutDir = resolve(serverOutDir, 'app');
  mkdirSync(appOutDir, { recursive: true });

  await esbuild.build({
    entryPoints: [serverCliSrc],
    outfile: resolve(serverOutDir, 'cli.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node22'],
    minify: true,
    banner: {
      js: "import { createRequire as __cbmcpCreateRequire } from 'node:module'; const require = __cbmcpCreateRequire(import.meta.url);",
    },
  });

  copyFileSync(deckHtmlSrc, resolve(appOutDir, 'deck.html'));
}

async function buildCodex() {
  await bundleStandaloneServer('plugins/codex');
  console.log('[build-plugins] Codex Desktop plugin server bundled -> plugins/codex/server/');
}

async function buildOpenChamber() {
  await bundleStandaloneServer('plugins/openchamber');
  const panelOutDir = resolve(rootDir, 'plugins/openchamber/panel');
  const serviceOutDir = resolve(rootDir, 'plugins/openchamber/service');
  mkdirSync(panelOutDir, { recursive: true });
  mkdirSync(serviceOutDir, { recursive: true });

  // 1. Sandboxed iframe classic IIFE bundle (React + shared BrowserDeckView)
  await esbuild.build({
    entryPoints: [resolve(rootDir, 'plugins/openchamber/src/panel.tsx')],
    outfile: resolve(panelOutDir, 'main.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2022'],
    jsx: 'automatic',
    minify: true,
    nodePaths: [mcpAppNodeModules],
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [workspaceAliasPlugin],
  });

  // 2. Shared Deck CSS
  copyFileSync(resolve(rootDir, 'packages/mcp-app/src/styles.css'), resolve(panelOutDir, 'styles.css'));

  // 3. Loopback guest service process
  await esbuild.build({
    entryPoints: [resolve(rootDir, 'plugins/openchamber/src/service.ts')],
    outfile: resolve(serviceOutDir, 'main.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node22'],
    minify: false,
    plugins: [workspaceAliasPlugin],
  });

  console.log('[build-plugins] OpenChamber extension built -> plugins/openchamber/{panel,service}');
}

async function buildOpenCode() {
  await bundleStandaloneServer('plugins/opencode');
  const bundleDir = resolve(rootDir, 'plugins/opencode/bundle');
  mkdirSync(bundleDir, { recursive: true });

  // 1. Server plugin (auto-registers chrome-browser MCP server via ctx.mcp.transform)
  await esbuild.build({
    entryPoints: [resolve(rootDir, 'plugins/opencode/src/server.ts')],
    outfile: resolve(bundleDir, 'server.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node22'],
  });

  // 2. ./gui-experimental single CommonJS bundle (dual-process: setup + main)
  // Keep OpenCode host-provided modules external as required by @opencode/plugin/gui
  await esbuild.build({
    entryPoints: [resolve(rootDir, 'plugins/opencode/src/gui.tsx')],
    outfile: resolve(bundleDir, 'gui-experimental.cjs'),
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: ['es2022'],
    jsx: 'automatic',
    minify: true,
    nodePaths: [mcpAppNodeModules],
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.css': 'text' },
    external: [
      '@opencode/plugin/gui',
      '@opencode/plugin/gui/*',
      '@opencode/plugin/rpc',
      '@opencode/schema/rpc',
      '@opencode/client',
      '@opencode/client/*',
      'effect',
      'solid-js',
      'solid-js/*',
      'electron',
      'node:*',
    ],
    plugins: [workspaceAliasPlugin],
  });

  console.log('[build-plugins] OpenCode Desktop GUI plugin built -> plugins/opencode/bundle/');
}

async function buildClaudeMod() {
  await bundleStandaloneServer('plugins/claude');
  const hooksDir = resolve(rootDir, 'plugins/claude/hooks');
  mkdirSync(hooksDir, { recursive: true });

  await esbuild.build({
    entryPoints: [resolve(rootDir, 'plugins/claude/src/register.ts')],
    outfile: resolve(hooksDir, 'register.js'),
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    target: ['es2022'],
    minify: false,
    plugins: [workspaceAliasPlugin],
  });

  console.log('[build-plugins] Claude Desktop Mod built -> plugins/claude/{hooks/register.js,server/}');
}

await buildCodex();
await buildOpenChamber();
await buildOpenCode();
await buildClaudeMod();
