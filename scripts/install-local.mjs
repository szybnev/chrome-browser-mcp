#!/usr/bin/env node
/**
 * Opt-in local desktop harness installer for Chrome Browser MCP.
 *
 * Usage:
 *   node scripts/install-local.mjs --all
 *   node scripts/install-local.mjs --codex --opencode --openchamber --claude --antigravity
 *   node scripts/install-local.mjs --codex --dry-run
 */
import { spawnSync } from 'node:child_process';
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
  --codex         Register local marketplace and install chrome-browser-mcp@chrome-browser-mcp in Codex
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
  const codexHome = process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(home, '.codex');
  const codexConfig = join(codexHome, 'config.toml');
  const codexSrc = resolve(rootDir, 'plugins/codex');
  const codexManifest = JSON.parse(readFileSync(resolve(codexSrc, 'plugin.json'), 'utf8'));
  const pluginVersion = String(codexManifest.version);
  const pluginCacheParent = join(codexHome, 'plugins', 'cache', 'chrome-browser-mcp', 'chrome-browser-mcp');
  const cacheDir = join(pluginCacheParent, pluginVersion);

  const codexProbe = spawnSync('codex', ['--version'], { stdio: 'ignore' });
  const codexCliAvailable = !codexProbe.error && codexProbe.status === 0;

  if (dryRun) {
    if (codexCliAvailable) {
      console.log(`[dry-run][codex] Would run: codex plugin marketplace add ${rootDir}`);
      console.log('[dry-run][codex] Would run: codex plugin add chrome-browser-mcp@chrome-browser-mcp');
    } else {
      console.log(
        `[dry-run][codex] codex CLI not found on PATH; would register marketplace & enable plugin in ${codexConfig}`,
      );
      console.log(`[dry-run][codex] Would install plugin cache ${cacheDir} from ${codexSrc}`);
    }
  } else {
    let installedViaCli = false;

    if (codexCliAvailable) {
      const cliEnv = { ...process.env, CODEX_HOME: codexHome };
      const addMarket = spawnSync('codex', ['plugin', 'marketplace', 'add', rootDir], {
        encoding: 'utf8',
        env: cliEnv,
      });
      if (addMarket.status === 0) {
        const addPlugin = spawnSync('codex', ['plugin', 'add', 'chrome-browser-mcp@chrome-browser-mcp'], {
          encoding: 'utf8',
          env: cliEnv,
        });
        if (addPlugin.status === 0) {
          installedViaCli = true;
          console.log(
            `[codex] Registered local marketplace and installed chrome-browser-mcp@chrome-browser-mcp (v${pluginVersion}) via codex CLI`,
          );
        } else {
          const detail = (addPlugin.stderr || addPlugin.stdout || '').trim();
          console.warn(
            `[codex] Warning: 'codex plugin add chrome-browser-mcp@chrome-browser-mcp' failed (${detail || `exit ${addPlugin.status}`}); falling back to direct config/cache install.`,
          );
        }
      } else {
        const detail = (addMarket.stderr || addMarket.stdout || '').trim();
        console.warn(
          `[codex] Warning: 'codex plugin marketplace add' failed (${detail || `exit ${addMarket.status}`}); falling back to direct config/cache install.`,
        );
      }
    }

    if (!installedViaCli) {
      mkdirSync(codexHome, { recursive: true });
      let content = existsSync(codexConfig) ? readFileSync(codexConfig, 'utf8') : '';
      let updatedConfig = false;

      if (!content.includes('[marketplaces.chrome-browser-mcp]')) {
        const marketBlock = `\n[marketplaces.chrome-browser-mcp]\nsource_type = "local"\nsource = ${JSON.stringify(rootDir)}\n`;
        content = content ? `${content.trimEnd()}\n${marketBlock}` : marketBlock.trimStart();
        updatedConfig = true;
      }

      if (!content.includes('[plugins."chrome-browser-mcp@chrome-browser-mcp"]')) {
        const pluginBlock = `\n[plugins."chrome-browser-mcp@chrome-browser-mcp"]\nenabled = true\n`;
        content = `${content.trimEnd()}\n${pluginBlock}`;
        updatedConfig = true;
      }

      if (updatedConfig || !existsSync(codexConfig)) {
        writeFileSync(codexConfig, `${content.trimEnd()}\n`, 'utf8');
        console.log(`[codex] Registered local marketplace and enabled chrome-browser-mcp in ${codexConfig}`);
      } else {
        console.log(`[codex] Already registered in ${codexConfig}`);
      }

      rmSync(pluginCacheParent, { recursive: true, force: true });
      mkdirSync(pluginCacheParent, { recursive: true });
      cpSync(codexSrc, cacheDir, { recursive: true });
      console.log(`[codex] Installed plugin cache -> ${cacheDir}`);
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
  console.log(`  Validate plugin:   claude plugin validate ${modDir}`);
  console.log(`  Load in session:   claude --plugin-dir ${modDir}`);
  console.log('[claude] Chat tab (.mcpb MCP Bundle — HTML MCP App + 18 browser_* tools):');
  console.log(
    `  Run \`pnpm pack:mcpb\` and drag-drop ${mcpbPath} into Claude Desktop -> Settings -> Extensions`,
  );
}
