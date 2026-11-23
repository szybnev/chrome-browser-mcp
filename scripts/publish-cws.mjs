#!/usr/bin/env node
/**
 * Zero-dependency Chrome Web Store Publish API v2 uploader & publisher.
 *
 * Uses official Google Chrome Web Store API v2 endpoints:
 *   - GET  https://chromewebstore.googleapis.com/v2/publishers/{publisherId}/items/{itemId}:fetchStatus
 *   - POST https://chromewebstore.googleapis.com/upload/v2/publishers/{publisherId}/items/{itemId}:upload
 *   - POST https://chromewebstore.googleapis.com/v2/publishers/{publisherId}/items/{itemId}:publish
 *
 * Required environment variables:
 *   CWS_PUBLISHER_ID   - Publisher UUID from Chrome Web Store Developer Dashboard URL
 *   CWS_EXTENSION_ID   - 32-character Extension ID from Developer Dashboard (created once manually)
 *
 * Authentication (either OAuth refresh token OR pre-minted access token from GCP WIF):
 *   CWS_ACCESS_TOKEN   - Optional pre-minted OAuth2 access token (scope: https://www.googleapis.com/auth/chromewebstore)
 *   OR:
 *   CWS_CLIENT_ID
 *   CWS_CLIENT_SECRET
 *   CWS_REFRESH_TOKEN
 *
 * Optional flags / env:
 *   --dry-run          - Validate inputs & version comparison without uploading/publishing
 *   CWS_PUBLISH_TYPE   - DEFAULT_PUBLISH (default) | STAGED_PUBLISH
 *   CWS_ZIP_PATH       - Path to extension ZIP (default: release/chrome-browser-mcp-extension.zip)
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rootDir = resolve(import.meta.dirname, '..');
const dryRun = process.argv.includes('--dry-run');

const publisherId = (process.env.CWS_PUBLISHER_ID || '').trim();
const extensionId = (process.env.CWS_EXTENSION_ID || '').trim();
const directAccessToken = (process.env.CWS_ACCESS_TOKEN || '').trim();
const clientId = (process.env.CWS_CLIENT_ID || '').trim();
const clientSecret = (process.env.CWS_CLIENT_SECRET || '').trim();
const refreshToken = (process.env.CWS_REFRESH_TOKEN || '').trim();
const publishType =
  process.env.CWS_PUBLISH_TYPE === 'STAGED_PUBLISH' ? 'STAGED_PUBLISH' : 'DEFAULT_PUBLISH';

const zipPath = resolve(
  rootDir,
  process.env.CWS_ZIP_PATH || 'release/chrome-browser-mcp-extension.zip',
);
const manifestPath = resolve(rootDir, 'packages/extension/dist/manifest.json');

function compareVersions(a, b) {
  const pa = String(a || '0')
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b || '0')
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

async function getAccessToken() {
  if (directAccessToken) return directAccessToken;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(
      `Failed to exchange OAuth refresh token (${res.status}): ${json.error_description || json.error || JSON.stringify(json)}`,
    );
  }
  return json.access_token;
}

async function fetchItemStatus(token) {
  const url = `https://chromewebstore.googleapis.com/v2/publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(extensionId)}:fetchStatus`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `CWS fetchStatus failed (${res.status}): ${json.error?.message || JSON.stringify(json)}`,
    );
  }
  return json;
}

function extractHighestStoreVersion(status) {
  const versions = [];
  for (const rev of [status.publishedItemRevisionStatus, status.submittedItemRevisionStatus]) {
    if (!rev) continue;
    if (typeof rev.crxVersion === 'string') versions.push(rev.crxVersion);
    if (Array.isArray(rev.distributionChannels)) {
      for (const ch of rev.distributionChannels) {
        if (typeof ch.crxVersion === 'string') versions.push(ch.crxVersion);
      }
    }
  }
  if (versions.length === 0) return null;
  versions.sort(compareVersions);
  return versions[versions.length - 1];
}

async function uploadPackage(token, zipBuffer) {
  const url = `https://chromewebstore.googleapis.com/upload/v2/publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(extensionId)}:upload`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/zip',
    },
    body: zipBuffer,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `CWS upload failed (${res.status}): ${json.error?.message || JSON.stringify(json)}`,
    );
  }
  return json;
}

async function publishItem(token) {
  const url = `https://chromewebstore.googleapis.com/v2/publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(extensionId)}:publish`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ publishType }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `CWS publish failed (${res.status}): ${json.error?.message || JSON.stringify(json)}`,
    );
  }
  return json;
}

async function waitForUploadCompletion(token, initialUploadRes) {
  const initialState = initialUploadRes.uploadState;
  if (initialState === 'SUCCEEDED') return initialUploadRes;
  if (initialState === 'FAILED') {
    throw new Error(`CWS upload failed immediately: ${JSON.stringify(initialUploadRes)}`);
  }

  console.log(`[publish-cws] Upload state=${initialState ?? 'IN_PROGRESS'}, polling fetchStatus…`);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const status = await fetchItemStatus(token);
    const state = status.lastAsyncUploadState;
    console.log(`[publish-cws] lastAsyncUploadState=${state ?? 'unknown'}`);
    if (state === 'SUCCEEDED') return status;
    if (state === 'FAILED') {
      throw new Error(`CWS async upload failed: ${JSON.stringify(status)}`);
    }
  }
  throw new Error('Timed out after 90s waiting for CWS async upload to complete.');
}

async function main() {
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing ${manifestPath}. Run \`pnpm pack:cws\` first.`);
  }
  if (!existsSync(zipPath)) {
    throw new Error(`Missing ${zipPath}. Run \`pnpm pack:cws\` first.`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const localVersion = String(manifest.version || '').trim();
  if (!localVersion) {
    throw new Error('manifest.json is missing "version".');
  }

  const hasAuth = Boolean(directAccessToken || (clientId && clientSecret && refreshToken));
  if (!publisherId || !extensionId || !hasAuth) {
    console.log(
      '[publish-cws] Skipping Chrome Web Store publish: CWS secrets not configured yet (set CWS_PUBLISHER_ID, CWS_EXTENSION_ID, and OAuth/WIF credentials in GitHub Repository Secrets).',
    );
    return;
  }

  console.log(
    `[publish-cws] Target item=${extensionId} publisher=${publisherId} localVersion=${localVersion} zip=${zipPath}`,
  );

  const token = await getAccessToken();
  const status = await fetchItemStatus(token);
  const storeVersion = extractHighestStoreVersion(status);
  const submittedState = status.submittedItemRevisionStatus?.state;

  console.log(
    `[publish-cws] Store status: highestVersion=${storeVersion ?? 'none'} submittedState=${submittedState ?? 'none'}`,
  );

  if (storeVersion && compareVersions(localVersion, storeVersion) <= 0) {
    console.log(
      `[publish-cws] Local version ${localVersion} is not newer than Chrome Web Store version ${storeVersion}. Skipping upload (bump version via \`pnpm version:set <next>\` to trigger a store release).`,
    );
    return;
  }

  if (submittedState === 'PENDING_REVIEW') {
    console.log(
      '[publish-cws] An earlier revision is currently PENDING_REVIEW in Chrome Web Store. Skipping upload to avoid cancelling the active review.',
    );
    return;
  }

  if (dryRun) {
    console.log(`[publish-cws] --dry-run: would upload ${zipPath} (${localVersion}) and publish (${publishType}).`);
    return;
  }

  const zipBuffer = readFileSync(zipPath);
  console.log(`[publish-cws] Uploading ${zipBuffer.length} bytes to Chrome Web Store API v2…`);
  const uploadRes = await uploadPackage(token, zipBuffer);
  await waitForUploadCompletion(token, uploadRes);

  console.log(`[publish-cws] Submitting item for publication (publishType=${publishType})…`);
  const publishRes = await publishItem(token);
  console.log(`[publish-cws] Published! Response: ${JSON.stringify(publishRes)}`);
}

main().catch((err) => {
  console.error('[publish-cws] ERROR:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
