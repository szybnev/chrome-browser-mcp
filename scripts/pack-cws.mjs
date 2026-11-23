import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const distDir = resolve(rootDir, 'packages/extension/dist');
const releaseDir = resolve(rootDir, 'release');

if (!existsSync(resolve(distDir, 'manifest.json'))) {
  throw new Error('packages/extension/dist/manifest.json not found. Run extension build first.');
}

mkdirSync(releaseDir, { recursive: true });
const outZip = resolve(releaseDir, 'chrome-browser-mcp-extension.zip');

execFileSync('zip', ['-r', '-q', outZip, '.', '-x', '*.map', '*.DS_Store'], {
  cwd: distDir,
  stdio: 'inherit',
});
console.log(`Created Chrome Web Store package: ${outZip}`);
