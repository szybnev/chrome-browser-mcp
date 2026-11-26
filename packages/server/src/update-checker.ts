import { APP_VERSION, compareSemver, type UpdateCheckStatus } from '@chrome-browser-mcp/protocol';

export const GITHUB_RELEASES_API_URL =
  'https://api.github.com/repos/szybnev/chrome-browser-mcp/releases/latest';
export const GITHUB_RELEASES_PAGE_URL = 'https://github.com/szybnev/chrome-browser-mcp/releases/latest';

const ALLOWED_RELEASE_URL_PREFIX = 'https://github.com/szybnev/chrome-browser-mcp/';

export interface CheckLatestReleaseOptions {
  currentVersion?: string;
  endpointUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Strictly on-demand, anonymous update check against GitHub Releases.
 * Never called automatically or on a background timer — zero telemetry by design.
 */
export async function checkLatestRelease(
  options: CheckLatestReleaseOptions = {},
): Promise<UpdateCheckStatus> {
  const currentVersion = options.currentVersion ?? APP_VERSION;
  const endpointUrl = options.endpointUrl ?? GITHUB_RELEASES_API_URL;
  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8000;

  const res = await fetchFn(endpointUrl, {
    method: 'GET',
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'chrome-browser-mcp',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    throw new Error(`Update check failed (GitHub HTTP ${res.status})`);
  }

  const payload = (await res.json()) as {
    tag_name?: unknown;
    html_url?: unknown;
    published_at?: unknown;
  };

  const rawTag = typeof payload.tag_name === 'string' ? payload.tag_name.trim() : '';
  const latestVersion = rawTag.replace(/^v/i, '');
  if (!latestVersion) {
    throw new Error('Update check returned no release tag');
  }

  const rawUrl = typeof payload.html_url === 'string' ? payload.html_url.trim() : '';
  const releaseUrl = rawUrl.startsWith(ALLOWED_RELEASE_URL_PREFIX) ? rawUrl : GITHUB_RELEASES_PAGE_URL;
  const publishedAt =
    typeof payload.published_at === 'string' && payload.published_at.trim()
      ? payload.published_at.trim()
      : undefined;

  return {
    currentVersion,
    latestVersion,
    updateAvailable: compareSemver(latestVersion, currentVersion) > 0,
    releaseUrl,
    publishedAt,
    checkedAt: Date.now(),
    source: 'github',
  };
}
