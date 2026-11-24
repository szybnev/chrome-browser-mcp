#!/usr/bin/env node

/**
 * Publishes @szybnev/chrome-browser-mcp-protocol and @szybnev/chrome-browser-mcp
 * to GitHub Packages (https://npm.pkg.github.com) using GITHUB_TOKEN / NODE_AUTH_TOKEN.
 *
 * Stages temporary publish directories in /tmp so workspace package names remain
 * untouched for local monorepo development and npmjs.com compatibility.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const rootDir = resolve(import.meta.dirname, '..');
const repoOwner = (process.env.GITHUB_REPOSITORY_OWNER || 'szybnev').toLowerCase();
const repoUrl = `https://github.com/${repoOwner}/chrome-browser-mcp.git`;
const registry = 'https://npm.pkg.github.com';
const token = (process.env.NODE_AUTH_TOKEN || process.env.GITHUB_TOKEN || '').trim();

if (!token) {
  console.log('[publish-gh-packages] Skipping: NODE_AUTH_TOKEN / GITHUB_TOKEN not set.');
  process.exit(0);
}

const rootPkg = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8'));
const version = rootPkg.version;
const stageRoot = resolve(tmpdir(), `chrome-browser-mcp-gh-pkg-${Date.now()}`);
mkdirSync(stageRoot, { recursive: true });

function isAlreadyPublished(pkgName, pkgVersion, npmrcPath) {
  try {
    const out = execFileSync(
      'npm',
      ['view', `${pkgName}@${pkgVersion}`, 'version', '--userconfig', npmrcPath, '--registry', registry],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    return out === pkgVersion;
  } catch {
    return false;
  }
}

function stageAndPublish(spec) {
  const npmrcPath = resolve(stageRoot, '.npmrc');
  writeFileSync(
    npmrcPath,
    `@${repoOwner}:registry=${registry}\n//npm.pkg.github.com/:_authToken=${token}\n`,
    { mode: 0o600 },
  );

  if (isAlreadyPublished(spec.name, version, npmrcPath)) {
    console.log(
      `[publish-gh-packages] ${spec.name}@${version} already exists on GitHub Packages — skipping.`,
    );
    return;
  }

  const pkgStage = resolve(stageRoot, spec.dirName);
  mkdirSync(pkgStage, { recursive: true });
  cpSync(resolve(rootDir, spec.distDir), resolve(pkgStage, 'dist'), { recursive: true });

  for (const extra of ['README.md', 'LICENSE']) {
    const src = resolve(rootDir, extra);
    if (existsSync(src)) cpSync(src, resolve(pkgStage, extra));
  }

  const srcPkg = JSON.parse(readFileSync(resolve(rootDir, spec.pkgJsonPath), 'utf8'));
  const { '@chrome-browser-mcp/protocol': protocolDep, ...restDeps } = srcPkg.dependencies || {};
  const deps = { ...restDeps };
  if (protocolDep !== undefined) {
    deps[`@${repoOwner}/chrome-browser-mcp-protocol`] = version;
  }

  // Rewrite compiled imports from @chrome-browser-mcp/protocol -> @<owner>/chrome-browser-mcp-protocol
  if (spec.rewriteProtocolImport) {
    const walk = (dir) => {
      for (const entry of execFileSync(
        'find',
        [dir, '-type', 'f', '(', '-name', '*.js', '-o', '-name', '*.d.ts', ')'],
        { encoding: 'utf8' },
      )
        .split('\n')
        .filter(Boolean)) {
        const content = readFileSync(entry, 'utf8');
        if (content.includes('@chrome-browser-mcp/protocol')) {
          writeFileSync(
            entry,
            content.replaceAll('@chrome-browser-mcp/protocol', `@${repoOwner}/chrome-browser-mcp-protocol`),
          );
        }
      }
    };
    walk(resolve(pkgStage, 'dist'));
  }

  const outPkg = {
    name: spec.name,
    version,
    description: srcPkg.description || rootPkg.description,
    license: srcPkg.license || rootPkg.license || 'MIT',
    type: 'module',
    repository: { type: 'git', url: repoUrl },
    publishConfig: { registry },
    ...(srcPkg.bin ? { bin: srcPkg.bin } : {}),
    ...(srcPkg.main ? { main: srcPkg.main } : {}),
    ...(srcPkg.types ? { types: srcPkg.types } : {}),
    ...(srcPkg.exports ? { exports: srcPkg.exports } : {}),
    files: ['dist', 'README.md', 'LICENSE'],
    engines: rootPkg.engines,
    dependencies: deps,
  };

  writeFileSync(resolve(pkgStage, 'package.json'), `${JSON.stringify(outPkg, null, 2)}\n`);

  console.log(`[publish-gh-packages] Publishing ${spec.name}@${version} to ${registry}…`);
  execFileSync('npm', ['publish', '--userconfig', npmrcPath, '--registry', registry], {
    cwd: pkgStage,
    stdio: 'inherit',
  });
}

try {
  stageAndPublish({
    dirName: 'protocol',
    name: `@${repoOwner}/chrome-browser-mcp-protocol`,
    pkgJsonPath: 'packages/protocol/package.json',
    distDir: 'packages/protocol/dist',
    rewriteProtocolImport: false,
  });

  stageAndPublish({
    dirName: 'server',
    name: `@${repoOwner}/chrome-browser-mcp`,
    pkgJsonPath: 'packages/server/package.json',
    distDir: 'packages/server/dist',
    rewriteProtocolImport: true,
  });
} finally {
  rmSync(stageRoot, { recursive: true, force: true });
}
