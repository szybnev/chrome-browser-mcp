import { rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'vite';

const pkgDir = resolve(import.meta.dirname, '..');
const distDir = resolve(pkgDir, 'dist');

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const started = performance.now();
await Promise.all([
  build({ configFile: resolve(pkgDir, 'vite.config.ts'), logLevel: 'warn' }),
  build({ configFile: resolve(pkgDir, 'vite.content.config.ts'), logLevel: 'warn' }),
  build({ configFile: resolve(pkgDir, 'vite.sw.config.ts'), logLevel: 'warn' }),
]);
copyFileSync(resolve(pkgDir, 'manifest.json'), resolve(distDir, 'manifest.json'));
console.log(
  `Built extension (single-process 3x parallel Rolldown) in ${Math.round(performance.now() - started)}ms`,
);
