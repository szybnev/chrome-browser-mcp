#!/usr/bin/env node
/**
 * Opt-in local desktop harness installer for Chrome Browser MCP.
 *
 * Usage:
 *   node scripts/install-local.mjs --all
 *   node scripts/install-local.mjs --codex --opencode --openchamber --claude --antigravity
 *   node scripts/install-local.mjs --codex --dry-run
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const runAll = args.has('--all');

const targets = {
  antigravity: runAll || args.has('--antigravity'),
  codex: runAll || args.has('--codex'),
  opencode: runAll || args.has('--opencode'),
  openchamber: runAll || args.has('--openchamber'),
  claude: runAll || args.has('--claude'),
};

if (!Object.values(targets).some(Boolean) || args.has('--help') || args.has('-h')) {
  console.log(`Chrome Browser MCP — Desktop Harness Local Installer

Usage:
  node scripts/install-local.mjs [flags]

Flags:
  --antigravity   Symlink plugins/antigravity into ~/.gemini/config/plugins/chrome-browser-mcp
  --codex         Register local marketplace + enable plugin in ~/.codex/config.toml
  --opencode      Register plugins/opencode in ~/.config/opencode/opencode.json
  --openchamber   Print the exact local folder path to add in OpenChamber Settings -> Extensions
  --claude        Print exact Claude Desktop Code tab (Mod) & Chat tab (.mcpb) install instructions
  --all           Run all of the above
  --dry-run       Preview changes without modifying any files outside the repo`);
  process.exit(0);
}

const home = homedir();

if (targets.antigravity) {
  const src = resolve(rootDir, 'plugins/antigravity');
  const destDir = join(home, '.gemini', 'config', 'plugins');
  const dest = join(destDir, 'chrome-browser-mcp');
  if (dryRun) {
    console.log(`[dry-run][antigravity] Would symlink ${dest} -> ${src}`);
  } else {
    mkdirSync(destDir, { recursive: true });
    try {
      lstatSync(dest);
      unlinkSync(dest);
    } catch {
      // does not exist
    }
    symlinkSync(src, dest);
    console.log(`[antigravity] Linked ${dest} -> ${src}`);
  }
}

if (targets.codex) {
  const codexConfig = join(home, '.codex', 'config.toml');
  const marketplaceBlock = `\n[marketplaces.chrome-browser-mcp]\nsource_type = "local"\nsource = ${JSON.stringify(rootDir)}\n\n[plugins."chrome-browser-mcp@chrome-browser-mcp"]\nenabled = true\n`;
  if (!existsSync(codexConfig)) {
    console.log(
      `[codex] ${codexConfig} not found. Add the following once Codex is initialized:${marketplaceBlock}`,
    );
  } else {
    const content = readFileSync(codexConfig, 'utf8');
    if (content.includes('[marketplaces.chrome-browser-mcp]')) {
      console.log(`[codex] Already registered in ${codexConfig}`);
    } else if (dryRun) {
      console.log(`[dry-run][codex] Would append to ${codexConfig}:${marketplaceBlock}`);
    } else {
      writeFileSync(codexConfig, `${content.trimEnd()}\n${marketplaceBlock}`, 'utf8');
      console.log(`[codex] Registered local marketplace and enabled chrome-browser-mcp in ${codexConfig}`);
    }
  }

  // Refresh existing copied Codex plugin cache for the current version if present
  const codexSrc = resolve(rootDir, 'plugins/codex');
  const codexManifest = JSON.parse(readFileSync(resolve(codexSrc, 'plugin.json'), 'utf8'));
  const cacheDir = join(
    home,
    '.codex',
    'plugins',
    'cache',
    'chrome-browser-mcp',
    'chrome-browser-mcp',
    String(codexManifest.version),
  );
  if (existsSync(cacheDir)) {
    if (dryRun) {
      console.log(`[dry-run][codex] Would refresh plugin cache ${cacheDir} from ${codexSrc}`);
    } else {
      rmSync(cacheDir, { recursive: true, force: true });
      cpSync(codexSrc, cacheDir, { recursive: true });
      console.log(`[codex] Refreshed copied plugin cache -> ${cacheDir}`);
    }
  }
}

if (targets.opencode) {
  const opencodePluginDir = resolve(rootDir, 'plugins/opencode');
  const configPath = join(home, '.config', 'opencode', 'opencode.json');
  if (dryRun) {
    console.log(`[dry-run][opencode] Would add "${opencodePluginDir}" to plugins[] in ${configPath}`);
  } else {
    mkdirSync(dirname(configPath), { recursive: true });
    let json = { $schema: 'https://opencode.ai/config.json' };
    if (existsSync(configPath)) {
      json = JSON.parse(readFileSync(configPath, 'utf8'));
    }
    const list = Array.isArray(json.plugins) ? json.plugins : [];
    if (!list.includes(opencodePluginDir)) {
      list.push(opencodePluginDir);
      json.plugins = list;
      writeFileSync(configPath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
      console.log(`[opencode] Registered ${opencodePluginDir} in ${configPath}`);
    } else {
      console.log(`[opencode] Already registered in ${configPath}`);
    }
  }
}

if (targets.openchamber) {
  const extDir = resolve(rootDir, 'plugins/openchamber');
  console.log('[openchamber] Open OpenChamber -> Settings -> Extensions -> Add local folder:');
  console.log(`  ${extDir}`);
}

if (targets.claude) {
  const modDir = resolve(rootDir, 'plugins/claude');
  const mcpbPath = resolve(rootDir, 'release/chrome-browser-mcp.mcpb');
  console.log('[claude] Code tab (Claude Mod — native 5-tab Control Deck Pane + AbovePrompt):');
  console.log(`  Install plugin directory: ${modDir}`);
  console.log('[claude] Chat tab (.mcpb MCP Bundle — HTML MCP App + 18 browser_* tools):');
  console.log(
    `  Run \`pnpm pack:mcpb\` and drag-drop ${mcpbPath} into Claude Desktop -> Settings -> Extensions`,
  );
}
