// Zero-dependency OpenCode server plugin bundled inside the OpenChamber extension.
// Automatically registers the Chrome Browser MCP stdio server inside OpenChamber's OpenCode instance.
// Never falls back to third-party npm packages — fails closed if local or bundled cli.js is missing.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveServerCommand() {
  if (process.env.CHROME_BROWSER_MCP_CLI && existsSync(process.env.CHROME_BROWSER_MCP_CLI)) {
    return ['node', process.env.CHROME_BROWSER_MCP_CLI, 'stdio'];
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(here, '../../../packages/server/dist/cli.js'),
      resolve(here, '../server/cli.js'),
    ];
    for (const cli of candidates) {
      if (existsSync(cli)) {
        return ['node', cli, 'stdio'];
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export default {
  id: 'chrome-browser-mcp',
  async setup(ctx) {
    if (!ctx?.mcp?.transform) return;
    const command = resolveServerCommand();
    if (!command) {
      console.error(
        '[chrome-browser-mcp] Server CLI not found (missing bundled server/cli.js or repo build); skipping MCP auto-registration.',
      );
      return;
    }
    await ctx.mcp.transform((editor) => {
      if (!editor.get('chrome-browser')) {
        editor.set('chrome-browser', {
          type: 'local',
          command,
          enabled: true,
        });
      }
    });
  },
};
