import { copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
copyFileSync(resolve(__dirname, '../manifest.json'), resolve(__dirname, '../dist/manifest.json'));
console.log('Copied manifest.json -> packages/extension/dist/manifest.json');
