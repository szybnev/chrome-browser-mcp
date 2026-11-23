import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcHtml = resolve(__dirname, '../../mcp-app/dist/index.html');
const dstDir = resolve(__dirname, '../dist/app');
const dstHtml = resolve(dstDir, 'deck.html');

if (existsSync(srcHtml)) {
  mkdirSync(dstDir, { recursive: true });
  copyFileSync(srcHtml, dstHtml);
  console.log(`Bundled MCP App UI -> ${dstHtml}`);
} else {
  console.log('MCP App UI not yet built; skipping copy (will use fallback until mcp-app builds).');
}
