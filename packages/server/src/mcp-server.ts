import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ActionStep,
  ActionStepSchema,
  type AuditResult,
  type BatchActResult,
  type ConsoleEntry,
  computeSnapshotDiff,
  type DownloadItem,
  EmulationConfigSchema,
  type ExtensionActionStep,
  exportWorkflowToPlaywright,
  extractWorkflowParamNames,
  formatFullSnapshot,
  frameUntrustedPageContent,
  interpolateWorkflowSteps,
  isUrlBlocked,
  isUrlReadOnly,
  type NetworkEntry,
  PageSnapshotSchema,
  type PendingDialog,
  type SecurityPolicy,
  SecurityPolicySchema,
  sanitizePageText,
  type TabInfo,
  type WebMcpToolInfo,
} from '@chrome-browser-mcp/protocol';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { type BrowserHubInterface, SERVER_VERSION } from './hub.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DECK_APP_URI = 'ui://chrome-browser/deck.html';

const PAYMENT_KEYWORDS =
  /\b(pay\s*now|place\s*order|confirm\s*purchase|checkout|complete\s*payment|transfer\s*funds|delete\s*account)\b/i;

function loadDeckHtml(deckSecret: string): string {
  const candidates = [
    process.env.CHROME_BROWSER_MCP_APP_HTML,
    resolve(__dirname, 'app/deck.html'),
    resolve(__dirname, '../../mcp-app/dist/index.html'),
  ].filter(Boolean) as string[];

  const secretTag = `<script>window.__CBMCP_DECK_SECRET__=${JSON.stringify(deckSecret)};</script>`;

  for (const path of candidates) {
    if (existsSync(path)) {
      const html = readFileSync(path, 'utf8');
      return html.includes('</head>')
        ? html.replace('</head>', `${secretTag}</head>`)
        : `${secretTag}${html}`;
    }
  }

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="color-scheme" content="light dark" />
  <title>Browser Control Deck</title>
  ${secretTag}
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; padding: 20px; background: var(--color-background-primary, #111); color: var(--color-text-primary, #eee); }
  </style>
</head>
<body>
  <h2>Chrome Browser MCP — Control Deck</h2>
  <p>Deck UI bundle not found. Run <code>pnpm build</code> to bundle <code>packages/mcp-app</code>.</p>
</body>
</html>`;
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
  };
}

function isPathInsideDir(targetPath: string, baseDir: string): boolean {
  const rel = relative(baseDir, targetPath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function getSensitiveUploadDenylist(): string[] {
  const home = homedir();
  const candidates = [
    join(home, '.chrome-browser-mcp'),
    join(home, '.ssh'),
    join(home, '.aws'),
    join(home, '.gnupg'),
    join(home, '.config'),
    join(home, '.kube'),
    '/etc',
    '/private/etc',
  ];
  const resolved: string[] = [];
  for (const dir of candidates) {
    try {
      resolved.push(existsSync(dir) ? realpathSync(dir) : resolve(dir));
    } catch {
      resolved.push(resolve(dir));
    }
  }
  return resolved;
}

function validateUploadPaths(
  rawFiles: string[],
  policy: SecurityPolicy,
): { ok: true; files: string[] } | { ok: false; error: string } {
  const home = homedir();
  // Fail closed by default: when uploadAllowedDirs is empty, restrict strictly to ~/Downloads
  const configuredDirs =
    policy.uploadAllowedDirs.length > 0 ? policy.uploadAllowedDirs : [join(home, 'Downloads')];
  const allowedRealDirs: string[] = [];
  for (const dir of configuredDirs) {
    const abs = resolve(dir);
    if (!existsSync(abs)) continue;
    try {
      allowedRealDirs.push(realpathSync(abs));
    } catch {
      // skip inaccessible dir
    }
  }
  if (allowedRealDirs.length === 0) {
    return {
      ok: false,
      error:
        'No valid upload directory is available. Configure uploadAllowedDirs in Security settings or ensure ~/Downloads exists.',
    };
  }

  const deniedDirs = getSensitiveUploadDenylist();
  const canonicalFiles: string[] = [];
  for (const rawPath of rawFiles) {
    const abs = resolve(rawPath);
    if (!existsSync(abs)) {
      return { ok: false, error: `Upload file does not exist: ${abs}` };
    }
    const real = realpathSync(abs);
    if (deniedDirs.some((denied) => isPathInsideDir(real, denied))) {
      return {
        ok: false,
        error: `Upload path "${real}" is inside a protected sensitive directory and cannot be uploaded`,
      };
    }
    if (!allowedRealDirs.some((base) => isPathInsideDir(real, base))) {
      return {
        ok: false,
        error: `Upload path "${real}" is outside allowed upload directories (${allowedRealDirs.join(', ')})`,
      };
    }
    canonicalFiles.push(real);
  }
  return { ok: true, files: canonicalFiles };
}

function safeOriginFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin && parsed.origin !== 'null' ? parsed.origin : 'opaque-origin';
  } catch {
    return 'unknown-origin';
  }
}

export function createBrowserMcpServer(
  hub: BrowserHubInterface,
  options?: { deckSecret?: string },
): McpServer {
  // Per-server (or per-broker HTTP) capability secret embedded strictly in deck.html
  const deckSecret = options?.deckSecret || randomBytes(24).toString('hex');
  const assertDeckSecret = (candidate?: string): void => {
    if (typeof candidate !== 'string' || !candidate) {
      throw new Error(
        'Unauthorized: privileged Deck control tools require an active Browser Control Deck UI session.',
      );
    }
    const a = Buffer.from(candidate, 'utf8');
    const b = Buffer.from(deckSecret, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error(
        'Unauthorized: privileged Deck control tools require an active Browser Control Deck UI session.',
      );
    }
  };

  const server = new McpServer(
    {
      name: 'chrome-browser-mcp',
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  // -------------------------------------------------------------------------
  // MCP App Resource (SEP-1865)
  // -------------------------------------------------------------------------

  server.registerResource(
    'browser-control-deck',
    DECK_APP_URI,
    {
      title: 'Browser Control Deck',
      description:
        'Live Antigravity MCP App for controlling connected Chrome tabs, approvals, DevTools errors, and recorded workflows.',
      mimeType: 'text/html;profile=mcp-app',
      _meta: {
        ui: {
          prefersBorder: false,
        },
      },
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/html;profile=mcp-app',
          text: loadDeckHtml(deckSecret),
        },
      ],
    }),
  );

  // -------------------------------------------------------------------------
  // 1. browser_profiles
  // -------------------------------------------------------------------------

  server.registerTool(
    'browser_profiles',
    {
      title: 'Browser Profiles',
      description:
        'List connected browser profiles (Chrome, Arc, Brave, Edge) or switch the default active profile.',
      inputSchema: z.object({
        action: z.enum(['list', 'select']).default('list'),
        profileId: z.string().optional().describe('Target profileId when action is "select"'),
      }),
    },
    async ({ action, profileId }) => {
      try {
        if (action === 'select') {
          if (!profileId) {
            return errorResult('profileId is required when action is "select"');
          }
          const selected = await hub.selectDefaultProfile(profileId);
          return {
            content: [
              {
                type: 'text',
                text: `Switched default browser profile to "${selected.profileId}" (${selected.browserName}: ${selected.label}).`,
              },
            ],
          };
        }

        const { defaultProfileId, profiles } = await hub.listProfiles();
        if (profiles.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No browser profiles connected yet. Load the Chrome Browser MCP extension and pair via http://127.0.0.1:43179/pair.',
              },
            ],
          };
        }
        const lines = profiles.map(
          (p) =>
            `${p.profileId === defaultProfileId ? '* ' : '  '}${p.profileId} — ${p.browserName} (${p.label}), tabs=${p.tabCount}, scope=${p.allowAllTabs ? 'all-tabs' : 'agent-group'}${p.paused ? ' [PAUSED]' : ''}`,
        );
        return {
          content: [{ type: 'text', text: `Connected browser profiles:\n${lines.join('\n')}` }],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 2. browser_tabs
  // -------------------------------------------------------------------------

  server.registerTool(
    'browser_tabs',
    {
      title: 'Browser Tabs',
      description:
        'List, open, focus, close, or detach browser tabs inside the AI Agent tab group. Only the user can attach existing private tabs via Chrome Side Panel or Browser Deck.',
      inputSchema: z.object({
        action: z.enum(['list', 'open', 'focus', 'close', 'detach']).default('list'),
        tabId: z.number().int().optional(),
        url: z.string().url().optional().describe('URL to open when action is "open"'),
        active: z.boolean().default(true).describe('Focus newly opened tab'),
        bringToFront: z
          .boolean()
          .default(false)
          .describe('Also raise the browser window to foreground when focusing a tab'),
        profileId: z.string().optional(),
      }),
    },
    async ({ action, tabId, url, active, bringToFront, profileId }) => {
      try {
        if (action === 'open' && url) {
          const policy = await hub.getLivePolicy();
          const check = isUrlBlocked(url, policy.blockedDomains, policy.allowedDomains);
          if (check.blocked) {
            return errorResult(`Blocked by domain policy: ${check.reason}`);
          }
        }

        const methodMap = {
          list: 'tabs.list',
          open: 'tabs.open',
          focus: 'tabs.focus',
          close: 'tabs.close',
          detach: 'tabs.detach',
        } as const;

        const { data } = await hub.callExtension<TabInfo | TabInfo[] | { closed: boolean }>(
          methodMap[action],
          { tabId, url, active, bringToFront },
          { profileId, toolLabel: `browser_tabs:${action}` },
        );

        if (action === 'list' && Array.isArray(data)) {
          if (data.length === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'No accessible tabs in the AI Agent group. Use browser_tabs(action="open", url="...") or attach a tab from Chrome Side Panel.',
                },
              ],
            };
          }
          const lines = data.map(
            (t) =>
              `[${t.tabId}]${t.active ? ' (active)' : ''}${t.inAgentGroup ? ' [agent-group]' : ''}${t.cdpAttached ? ' [CDP]' : ''} ${t.title || '(untitled)'} — ${t.url}`,
          );
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
          };
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 3. browser_navigate
  // -------------------------------------------------------------------------

  server.registerTool(
    'browser_navigate',
    {
      title: 'Navigate Page',
      description: 'Navigate a tab to a URL, go back/forward, reload, or wait for selector/text/load state.',
      inputSchema: z.object({
        action: z.enum(['goto', 'back', 'forward', 'reload', 'wait']).default('goto'),
        url: z.string().optional(),
        tabId: z.number().int().optional(),
        waitSelector: z.string().optional(),
        waitText: z.string().optional(),
        timeoutMs: z.number().int().min(500).max(30000).default(15000),
        profileId: z.string().optional(),
      }),
    },
    async ({ action, url, tabId, waitSelector, waitText, timeoutMs, profileId }) => {
      try {
        const policy = await hub.getLivePolicy();
        if (action === 'goto') {
          if (!url) return errorResult('url is required for action="goto"');
          const check = isUrlBlocked(url, policy.blockedDomains, policy.allowedDomains);
          if (check.blocked) return errorResult(`Blocked by domain policy: ${check.reason}`);
        }

        const { data } = await hub.callExtension<{
          tabId: number;
          url: string;
          title: string;
          redirectedFrom?: string;
        }>(
          'page.navigate',
          { action, url, tabId, waitSelector, waitText, timeoutMs },
          { profileId, timeoutMs: timeoutMs + 5000, toolLabel: `browser_navigate:${action}` },
        );

        const postCheck = isUrlBlocked(data.url, policy.blockedDomains, policy.allowedDomains);
        if (postCheck.blocked) {
          return errorResult(`Blocked by domain policy after navigation: ${postCheck.reason}`);
        }

        const redirectNote = data.redirectedFrom ? ` [redirected from ${data.redirectedFrom}]` : '';
        return {
          content: [
            {
              type: 'text',
              text: `Tab ${data.tabId} ready: "${data.title}" (${data.url})${redirectNote}`,
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 4. browser_snapshot (Compact a11y/DOM + Diff + Prompt-Injection Shield)
  // -------------------------------------------------------------------------

  server.registerTool(
    'browser_snapshot',
    {
      title: 'Page Semantic Snapshot',
      description:
        'Capture a compact, token-efficient accessibility/DOM tree with short element refs (e1, e2…). Use mode="diff" on subsequent calls to receive only changes. Protected by Prompt-Injection Shield.',
      inputSchema: z.object({
        tabId: z.number().int().optional(),
        mode: z.enum(['full', 'diff']).default('diff'),
        includeOffscreen: z.boolean().default(false),
        includeIframes: z
          .boolean()
          .default(true)
          .describe('Traverse cross-origin & nested iframes (prefixed f<frameId>:e1)'),
        includeClosedShadow: z
          .boolean()
          .default(false)
          .describe('Escalate to CDP Accessibility tree to inspect closed Shadow DOM'),
        useCdp: z.boolean().default(false).describe('Escalate to chrome.debugger Accessibility tree'),
        maxNodes: z.number().int().min(20).max(500).default(220),
        profileId: z.string().optional(),
      }),
    },
    async ({
      tabId,
      mode,
      includeOffscreen,
      includeIframes,
      includeClosedShadow,
      useCdp,
      maxNodes,
      profileId,
    }) => {
      try {
        const { profileId: resolvedProfile, data } = await hub.callExtension<unknown>(
          'page.snapshot',
          { tabId, includeOffscreen, includeIframes, includeClosedShadow, useCdp, maxNodes },
          { profileId, toolLabel: 'browser_snapshot' },
        );

        const snapshot = PageSnapshotSchema.parse(data);
        const policy = await hub.getLivePolicy();
        const urlCheck = isUrlBlocked(snapshot.url, policy.blockedDomains, policy.allowedDomains);
        if (urlCheck.blocked) {
          return errorResult(`Blocked by domain policy: ${urlCheck.reason}`);
        }

        const previous = hub.getPreviousSnapshot(resolvedProfile, snapshot.tabId);
        hub.rememberSnapshot(resolvedProfile, snapshot);

        const body =
          mode === 'diff'
            ? computeSnapshotDiff(previous, snapshot, maxNodes).formatted
            : formatFullSnapshot(snapshot, maxNodes);

        const framed = frameUntrustedPageContent({
          origin: snapshot.origin,
          url: snapshot.url,
          title: snapshot.title,
          content: body,
          filteredHiddenCount: snapshot.filteredHiddenCount,
          shieldEnabled: policy.promptInjectionShield,
        });

        return {
          content: [{ type: 'text', text: framed.text }],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 5. browser_read (Clean Markdown Article Extractor + Shield)
  // -------------------------------------------------------------------------

  server.registerTool(
    'browser_read',
    {
      title: 'Read Page Markdown',
      description:
        'Extract clean readable Markdown, structured HTML tables (JSON/CSV), or PDF text from the page, with chunk pagination (offset + maxChars up to 200k), interactive tab hints, and Prompt-Injection Shield.',
      inputSchema: z.object({
        tabId: z.number().int().optional(),
        selector: z.string().optional(),
        format: z
          .enum(['markdown', 'tables_json', 'tables_csv'])
          .default('markdown')
          .describe('Output format: readable Markdown (default), or structured HTML tables as JSON/CSV'),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe('Character offset for paginating long pages without reloading'),
        maxChars: z.number().int().min(500).max(200000).default(30000),
        scope: z
          .enum(['main', 'body'])
          .default('main')
          .describe('Read primary content ("main") or entire document body ("body")'),
        profileId: z.string().optional(),
      }),
    },
    async ({ tabId, selector, format, offset, maxChars, scope, profileId }) => {
      try {
        const { data } = await hub.callExtension<{
          tabId: number;
          url: string;
          origin: string;
          title: string;
          markdown: string;
          totalChars?: number;
          offset?: number;
          returnedChars?: number;
          hasMore?: boolean;
          nextOffset?: number | null;
          filteredHiddenCount: number;
          tabsSummary?: string[];
          alternateLinks?: string[];
          tableCount?: number;
          isPdf?: boolean;
        }>(
          'page.read',
          { tabId, selector, format, offset, maxChars, scope },
          { profileId, toolLabel: 'browser_read' },
        );

        const policy = await hub.getLivePolicy();
        const urlCheck = isUrlBlocked(data.url, policy.blockedDomains, policy.allowedDomains);
        if (urlCheck.blocked) {
          return errorResult(`Blocked by domain policy: ${urlCheck.reason}`);
        }

        const metaHints: string[] = [];
        if (data.tabsSummary && data.tabsSummary.length > 0) {
          metaHints.push(
            `[TABS: ${data.tabsSummary.join(', ')} — call browser_snapshot + browser_act(click) to view inactive tabs]`,
          );
        }
        if (data.alternateLinks && data.alternateLinks.length > 0) {
          metaHints.push(`[ALTERNATE_LINKS: ${data.alternateLinks.join('; ')}]`);
        }

        let body = data.markdown;
        if (metaHints.length > 0) {
          body = `${metaHints.join('\n')}\n\n${body}`;
        }
        if (data.hasMore && data.nextOffset !== null && data.nextOffset !== undefined) {
          const total = data.totalChars ?? data.nextOffset;
          const remaining = Math.max(0, total - data.nextOffset);
          body += `\n\n[PAGINATION: Showing chars ${data.offset ?? offset}..${data.nextOffset} of ${total} (${remaining} remaining). Call browser_read(tabId=${data.tabId}, offset=${data.nextOffset}, maxChars=${maxChars}) to read the next chunk without reloading.]`;
        }

        const framed = frameUntrustedPageContent({
          origin: data.origin,
          url: data.url,
          title: data.title,
          content: body,
          filteredHiddenCount: data.filteredHiddenCount,
          shieldEnabled: hub.getPolicy().promptInjectionShield,
        });

        return {
          content: [{ type: 'text', text: framed.text }],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 6. browser_screenshot (Compressed + Optional Set-of-Mark Overlay)
  // -------------------------------------------------------------------------

  server.registerTool(
    'browser_screenshot',
    {
      title: 'Capture Screenshot',
      description:
        'Capture a compressed screenshot of the tab, optionally with Set-of-Mark element ref badges (e1, e2…) for visual grounding.',
      inputSchema: z.object({
        tabId: z.number().int().optional(),
        setOfMark: z
          .boolean()
          .default(false)
          .describe('Overlay element ref badges on interactive elements before capture'),
        fullPage: z.boolean().default(false),
        format: z.enum(['jpeg', 'webp', 'png']).default('webp'),
        quality: z.number().int().min(30).max(95).default(70),
        maxWidth: z
          .number()
          .int()
          .min(320)
          .max(3840)
          .optional()
          .describe(
            'Optional max width in pixels to downscale screenshot in-browser for faster vision inference',
          ),
        profileId: z.string().optional(),
      }),
    },
    async ({ tabId, setOfMark, fullPage, format, quality, maxWidth, profileId }) => {
      try {
        const { data } = await hub.callExtension<{
          tabId: number;
          url: string;
          mimeType: string;
          base64: string;
          width?: number;
          height?: number;
        }>(
          'page.screenshot',
          { tabId, setOfMark, fullPage, format, quality, maxWidth },
          { profileId, toolLabel: 'browser_screenshot' },
        );

        hub.recordScreenshot({
          tabId: data.tabId,
          url: data.url,
          mimeType: data.mimeType,
          dataUrl: `data:${data.mimeType};base64,${data.base64}`,
          setOfMark,
          timestamp: Date.now(),
        });

        return {
          content: [
            {
              type: 'text',
              text: `Captured ${data.mimeType} screenshot of tab ${data.tabId} (${data.url})${setOfMark ? ' with Set-of-Mark ref badges' : ''}.`,
            },
            {
              type: 'image',
              data: data.base64,
              mimeType: data.mimeType,
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 7. browser_act (Single or Batch Actions + Risky Action Gates)
  // -------------------------------------------------------------------------

  // Shared policy/approval pipeline used by BOTH browser_act AND browser_workflows(replay)
  async function executeGatedBatchAct(opts: {
    tabId?: number;
    steps: ActionStep[];
    returnSnapshot: 'diff' | 'full' | 'none';
    forceCdp: boolean;
    profileId?: string;
    toolLabel: string;
    timeoutMs: number;
  }): Promise<{ profileId: string; data: BatchActResult; policy: SecurityPolicy }> {
    const resolvedProfiles = await hub.listProfiles();
    const activeProfileId = opts.profileId || resolvedProfiles.defaultProfileId || 'default';
    const policy = await hub.getLivePolicy();

    const prevSnap =
      opts.tabId !== undefined ? hub.getPreviousSnapshot(activeProfileId, opts.tabId) : undefined;
    const liveUrl = (await hub.getLiveTabUrl(activeProfileId, opts.tabId)) ?? prevSnap?.url ?? '';
    const origin = liveUrl ? safeOriginFromUrl(liveUrl) : (prevSnap?.origin ?? 'active-tab');

    if (liveUrl) {
      const blocked = isUrlBlocked(liveUrl, policy.blockedDomains, policy.allowedDomains);
      if (blocked.blocked) {
        throw new Error(`Blocked by domain policy: ${blocked.reason}`);
      }
    }

    const hasMutatingStep = opts.steps.some((s) => s.kind !== 'scroll' && s.kind !== 'wait');
    if (liveUrl && hasMutatingStep) {
      const roCheck = isUrlReadOnly(liveUrl, policy.readOnlyDomains);
      if (roCheck.readOnly) {
        await hub.requestApprovalIfNeeded({
          profileId: activeProfileId,
          tabId: opts.tabId,
          origin,
          action: 'browser_act:read_only_override',
          reason: `Mutating action requested on read-only domain (${roCheck.reason})`,
          risk: 'high',
          preview: `Allow ${opts.steps.length} step(s) on read-only ${origin}`,
          kind: 'read-only-override',
        });
      }
    }

    const preparedSteps: ExtensionActionStep[] = [];
    for (const rawInputStep of opts.steps) {
      // Defense-in-depth: strip any caller-supplied internal approval/secret flags
      const {
        preApproved: _ignoredPreApproved,
        isSecret: _ignoredIsSecret,
        ...cleanStep
      } = rawInputStep as ActionStep & { preApproved?: unknown; isSecret?: unknown };
      const step = cleanStep as ActionStep;
      if (step.kind === 'upload') {
        const preCheck = validateUploadPaths(step.files, policy);
        if (!preCheck.ok) {
          throw new Error(preCheck.error);
        }
        await hub.requestApprovalIfNeeded({
          profileId: activeProfileId,
          tabId: opts.tabId,
          origin,
          action: 'browser_act:file_upload',
          reason: `Uploading ${preCheck.files.length} local file(s) to ${origin}`,
          risk: 'high',
          preview: `Upload ${preCheck.files.join(', ')} to ${origin}`,
          kind: 'upload',
        });
        // Re-verify canonical realpath AFTER approval to close symlink TOCTOU window
        const postCheck = validateUploadPaths(step.files, await hub.getLivePolicy());
        if (!postCheck.ok) {
          throw new Error(postCheck.error);
        }
        preparedSteps.push({ ...step, files: postCheck.files });
        continue;
      }

      if ((step.kind === 'fill' || step.kind === 'type') && step.secretRef) {
        await hub.requestApprovalIfNeeded({
          profileId: activeProfileId,
          tabId: opts.tabId,
          origin,
          action: 'browser_act:secret_autofill',
          reason: `Filling secret "${step.secretRef}" into ${step.ref || step.selector || 'input'} on ${origin}`,
          risk: 'high',
          preview: `Zero-Secret autofill ${step.secretRef} on ${origin}`,
          kind: 'password',
        });
        // Keep secretRef intact so BrowserBrokerHub resolves & scrubs it locally (never over HTTP)
        preparedSteps.push({ ...step, preApproved: true });
        continue;
      }

      if ((step.kind === 'fill' || step.kind === 'type') && step.ref && prevSnap) {
        const targetNode = prevSnap.nodes.find((n) => n.ref === step.ref);
        if (targetNode?.inputType === 'password') {
          await hub.requestApprovalIfNeeded({
            profileId: activeProfileId,
            tabId: opts.tabId,
            origin,
            action: 'browser_act:password_input',
            reason: `Filling password field "${targetNode.name || targetNode.ref}" on ${origin}`,
            risk: 'high',
            preview: `Fill password input [${targetNode.ref}] on ${origin}`,
            kind: 'password',
          });
          preparedSteps.push({ ...step, preApproved: true });
          continue;
        }
      }

      if (step.kind === 'click' && step.ref && prevSnap) {
        const targetNode = prevSnap.nodes.find((n) => n.ref === step.ref);
        if (targetNode && PAYMENT_KEYWORDS.test(targetNode.name)) {
          await hub.requestApprovalIfNeeded({
            profileId: activeProfileId,
            tabId: opts.tabId,
            origin,
            action: 'browser_act:sensitive_submit',
            reason: `Clicking sensitive control "${targetNode.name}" on ${origin}`,
            risk: 'critical',
            preview: `Click [${targetNode.ref}] "${targetNode.name}" on ${origin}`,
            kind: 'payment',
          });
          preparedSteps.push({ ...step, preApproved: true });
          continue;
        }
      }

      preparedSteps.push(step);
    }

    let currentSteps = preparedSteps;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { profileId: usedProfile, data } = await hub.callExtension<BatchActResult>(
        'page.act',
        {
          tabId: opts.tabId,
          steps: currentSteps,
          returnSnapshot: opts.returnSnapshot,
          forceCdp: opts.forceCdp,
          expectedOrigin: /^https?:\/\//i.test(origin) ? origin : undefined,
        },
        { profileId: opts.profileId, timeoutMs: opts.timeoutMs, toolLabel: opts.toolLabel },
      );

      // Handle DOM-level approval challenges returned by the extension for selector/(x,y)/Enter/password targets
      const failedChallenge = data.outcomes.find(
        (o) => !o.ok && typeof o.error === 'string' && o.error.startsWith('APPROVAL_REQUIRED:'),
      );
      if (!failedChallenge?.error) {
        return { profileId: usedProfile, data, policy };
      }

      const parts = failedChallenge.error.split(':');
      const kindRaw = parts[1];
      const detailRaw = parts.slice(2).join(':');
      const kind = kindRaw === 'password' ? 'password' : 'payment';
      const detail = detailRaw || `Step ${failedChallenge.index + 1} (${failedChallenge.kind})`;
      const liveAfter = (await hub.getLiveTabUrl(usedProfile, data.tabId)) ?? liveUrl;
      const challengeOrigin = liveAfter ? safeOriginFromUrl(liveAfter) : origin;

      await hub.requestApprovalIfNeeded({
        profileId: usedProfile,
        tabId: data.tabId,
        origin: challengeOrigin,
        action: kind === 'password' ? 'browser_act:password_input' : 'browser_act:sensitive_submit',
        reason: `${detail} on ${challengeOrigin}`,
        risk: kind === 'payment' ? 'critical' : 'high',
        preview: `${detail} on ${challengeOrigin}`,
        kind,
      });

      // Retry remaining steps starting at the challenged step with preApproved=true
      const remaining = currentSteps
        .slice(failedChallenge.index)
        .map((s, idx) =>
          idx === 0 && (s.kind === 'click' || s.kind === 'fill' || s.kind === 'type' || s.kind === 'press')
            ? { ...s, preApproved: true }
            : s,
        );
      currentSteps = remaining;
    }

    throw new Error('Action aborted after repeated approval challenges.');
  }

  server.registerTool(
    'browser_act',
    {
      title: 'Act on Page (Single or Batch)',
      description:
        'Execute one action or an ordered batch of actions (click, fill, type, press, select, check, scroll, hover, drag, upload, wait) in a single round-trip. Supports f<frameId>:e1 iframe refs and Zero-Secret Autofill via secretRef ("env:VAR" or "keychain:ACCOUNT"). Stops on first error or JS dialog and returns an automatic diff snapshot.',
      inputSchema: z.object({
        tabId: z.number().int().optional(),
        steps: z.array(ActionStepSchema).min(1).max(30),
        returnSnapshot: z.enum(['diff', 'full', 'none']).default('diff'),
        forceCdp: z.boolean().default(false).describe('Force chrome.debugger hardware-level input events'),
        profileId: z.string().optional(),
      }),
    },
    async ({ tabId, steps, returnSnapshot, forceCdp, profileId }) => {
      try {
        const {
          profileId: usedProfile,
          data,
          policy,
        } = await executeGatedBatchAct({
          tabId,
          steps,
          returnSnapshot,
          forceCdp,
          profileId,
          toolLabel: `browser_act(${steps.length})`,
          timeoutMs: 45_000,
        });

        const summaryLines = [
          `Executed ${data.completedSteps}/${data.totalSteps} step(s) on tab ${data.tabId} (${data.ok ? 'OK' : 'STOPPED ON ERROR'}):`,
          ...data.outcomes.map(
            (o) =>
              `  ${o.index + 1}. ${o.kind} [${o.ok ? 'ok' : 'FAIL'}${o.engine ? `, ${o.engine}` : ''}, ${o.durationMs}ms]${o.detail ? ` — ${o.detail}` : ''}${o.error ? ` — ERROR: ${o.error}` : ''}`,
          ),
        ];

        if (data.pendingDialog) {
          const cleanDialogMsg = sanitizePageText(data.pendingDialog.message).sanitized;
          const framedDialog = frameUntrustedPageContent({
            origin: data.pendingDialog.url ? safeOriginFromUrl(data.pendingDialog.url) : 'browser-dialog',
            url: data.pendingDialog.url || `tab://${data.tabId}`,
            content: `[PENDING_DIALOG type="${data.pendingDialog.type}" message=${JSON.stringify(cleanDialogMsg)}]`,
            shieldEnabled: policy.promptInjectionShield,
          });
          summaryLines.push(
            '',
            framedDialog.text,
            'Call browser_dialog(action="accept"|"dismiss") to handle this dialog.',
          );
        }

        if (data.snapshot && returnSnapshot !== 'none') {
          const parsedSnap = PageSnapshotSchema.parse(data.snapshot);
          const prev = hub.getPreviousSnapshot(usedProfile, parsedSnap.tabId);
          hub.rememberSnapshot(usedProfile, parsedSnap);
          const snapText =
            returnSnapshot === 'diff'
              ? computeSnapshotDiff(prev, parsedSnap).formatted
              : formatFullSnapshot(parsedSnap);
          const framed = frameUntrustedPageContent({
            origin: parsedSnap.origin,
            url: parsedSnap.url,
            title: parsedSnap.title,
            content: snapText,
            filteredHiddenCount: parsedSnap.filteredHiddenCount,
            shieldEnabled: policy.promptInjectionShield,
          });
          summaryLines.push('', framed.text);
        }

        return {
          isError: !data.ok,
          content: [{ type: 'text', text: summaryLines.join('\n') }],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 8. browser_console
  // -------------------------------------------------------------------------

  server.registerTool(
    'browser_console',
    {
      title: 'Console Logs',
      description: 'Read recent browser console messages (errors, warnings, logs) from a tab.',
      inputSchema: z.object({
        tabId: z.number().int().optional(),
        level: z.enum(['all', 'error', 'warn', 'info', 'log']).default('all'),
        limit: z.number().int().min(1).max(200).default(50),
        attachCdp: z
          .boolean()
          .default(true)
          .describe('Ensure CDP Console/Runtime capture is active on the tab'),
        profileId: z.string().optional(),
      }),
    },
    async ({ tabId, level, limit, attachCdp, profileId }) => {
      try {
        const { data } = await hub.callExtension<ConsoleEntry[]>(
          'devtools.console',
          { tabId, level, limit, attachCdp },
          { profileId, toolLabel: 'browser_console' },
        );
        if (!data || data.length === 0) {
          return { content: [{ type: 'text', text: 'No console messages captured.' }] };
        }
        const lines = data.map(
          (c) =>
            `[${new Date(c.timestamp).toISOString().slice(11, 23)}] [${c.level.toUpperCase()}] ${c.text}${c.source ? ` (${c.source}${c.line ? `:${c.line}` : ''})` : ''}`,
        );
        const policy = await hub.getLivePolicy();
        const framed = frameUntrustedPageContent({
          origin: 'browser-console',
          url: `tab://${tabId ?? 'active'}`,
          content: lines.join('\n'),
          shieldEnabled: policy.promptInjectionShield,
        });
        return { content: [{ type: 'text', text: framed.text }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 9. browser_network
  // -------------------------------------------------------------------------

  server.registerTool(
    'browser_network',
    {
      title: 'Network Requests',
      description:
        'Inspect recent XHR/Fetch/document network requests and failures (sensitive headers redacted). Pass includeBodyForRequestId to inspect a specific response body with JWT/secret redaction.',
      inputSchema: z.object({
        tabId: z.number().int().optional(),
        onlyFailed: z.boolean().default(false),
        urlFilter: z.string().optional(),
        includeBodyForRequestId: z
          .string()
          .optional()
          .describe('Fetch redacted UTF-8 response body for a specific requestId'),
        limit: z.number().int().min(1).max(200).default(40),
        profileId: z.string().optional(),
      }),
    },
    async ({ tabId, onlyFailed, urlFilter, includeBodyForRequestId, limit, profileId }) => {
      try {
        if (includeBodyForRequestId) {
          const { data: bodyData } = await hub.callExtension<{
            requestId: string;
            body: string;
            base64Encoded: boolean;
            truncated: boolean;
            redactedCount: number;
          }>(
            'devtools.networkBody',
            { tabId, requestId: includeBodyForRequestId },
            { profileId, toolLabel: 'browser_network:body' },
          );
          const bodyPolicy = await hub.getLivePolicy();
          const framed = frameUntrustedPageContent({
            origin: 'network-response',
            url: `request://${bodyData.requestId}`,
            content: bodyData.body,
            shieldEnabled: bodyPolicy.promptInjectionShield,
          });
          const note = `[requestId=${bodyData.requestId} redacted=${bodyData.redactedCount}${bodyData.truncated ? ' truncated=true' : ''}]\n`;
          return { content: [{ type: 'text', text: `${note}${framed.text}` }] };
        }

        const { data } = await hub.callExtension<NetworkEntry[]>(
          'devtools.network',
          { tabId, onlyFailed, urlFilter, limit },
          { profileId, toolLabel: 'browser_network' },
        );
        if (!data || data.length === 0) {
          return { content: [{ type: 'text', text: 'No network entries captured yet.' }] };
        }
        const lines = data.map(
          (n) =>
            `[${n.requestId}] ${n.method} ${n.status ?? (n.failed ? 'FAIL' : 'PENDING')} ${n.url}${n.durationMs ? ` (${n.durationMs}ms)` : ''}${n.errorText ? ` — ${n.errorText}` : ''}${n.responsePreview ? `\n    preview: ${n.responsePreview.slice(0, 180)}` : ''}`,
        );
        const policy = await hub.getLivePolicy();
        const framed = frameUntrustedPageContent({
          origin: 'browser-network',
          url: `tab://${tabId ?? 'active'}`,
          content: lines.join('\n'),
          shieldEnabled: policy.promptInjectionShield,
        });
        return { content: [{ type: 'text', text: framed.text }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 10. browser_eval (Guarded by Approval Gate on New Origins)
  // -------------------------------------------------------------------------

  server.registerTool(
    'browser_eval',
    {
      title: 'Evaluate JavaScript',
      description:
        'Evaluate a JavaScript expression in the target page context via CDP Runtime.evaluate. Subject to user approval on new origins when enabled.',
      inputSchema: z.object({
        tabId: z.number().int().optional(),
        expression: z.string().min(1).max(20000),
        awaitPromise: z.boolean().default(true),
        profileId: z.string().optional(),
      }),
    },
    async ({ tabId, expression, awaitPromise, profileId }) => {
      try {
        const { defaultProfileId } = await hub.listProfiles();
        const activeProfile = profileId || defaultProfileId || 'default';
        const policy = await hub.getLivePolicy();
        const prevSnap = tabId !== undefined ? hub.getPreviousSnapshot(activeProfile, tabId) : undefined;
        const knownUrl = (await hub.getLiveTabUrl(activeProfile, tabId)) ?? prevSnap?.url ?? '';
        const origin = knownUrl ? safeOriginFromUrl(knownUrl) : (prevSnap?.origin ?? 'active-tab');

        if (knownUrl) {
          const blocked = isUrlBlocked(knownUrl, policy.blockedDomains, policy.allowedDomains);
          if (blocked.blocked) {
            return errorResult(`Blocked by domain policy: ${blocked.reason}`);
          }
          const roCheck = isUrlReadOnly(knownUrl, policy.readOnlyDomains);
          if (roCheck.readOnly) {
            await hub.requestApprovalIfNeeded({
              profileId: activeProfile,
              tabId,
              origin,
              action: 'browser_eval:read_only_override',
              reason: `JavaScript eval requested on read-only domain (${roCheck.reason})`,
              risk: 'high',
              preview: expression.slice(0, 260),
              kind: 'read-only-override',
            });
          }
        }

        await hub.requestApprovalIfNeeded({
          profileId: activeProfile,
          tabId,
          origin,
          action: 'browser_eval',
          reason: `Evaluate JavaScript on ${origin}`,
          risk: 'high',
          preview: expression.slice(0, 260),
          kind: 'eval',
        });

        const { data } = await hub.callExtension<{ value: unknown; exception?: string }>(
          'devtools.eval',
          {
            tabId,
            expression,
            awaitPromise,
            expectedOrigin: /^https?:\/\//i.test(origin) ? origin : undefined,
          },
          { profileId, toolLabel: 'browser_eval' },
        );

        if (data.exception) {
          return errorResult(`JS exception: ${data.exception}`);
        }
        const serialized = typeof data.value === 'string' ? data.value : JSON.stringify(data.value, null, 2);
        const framed = frameUntrustedPageContent({
          origin,
          url: knownUrl || `tab://${tabId ?? 'active'}`,
          content: serialized ?? 'undefined',
          shieldEnabled: policy.promptInjectionShield,
        });
        return {
          content: [{ type: 'text', text: framed.text }],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 11. browser_audit
  // -------------------------------------------------------------------------

  server.registerTool(
    'browser_audit',
    {
      title: 'Audit Page (a11y / Perf / Storage)',
      description:
        'Run quick accessibility, performance timing (LCP/CLS/DOM size), and storage key audits on the tab.',
      inputSchema: z.object({
        tabId: z.number().int().optional(),
        profileId: z.string().optional(),
      }),
    },
    async ({ tabId, profileId }) => {
      try {
        const policy = await hub.getLivePolicy();
        const { data } = await hub.callExtension<AuditResult>(
          'devtools.audit',
          { tabId },
          { profileId, toolLabel: 'browser_audit' },
        );
        const framed = frameUntrustedPageContent({
          origin: safeOriginFromUrl(data.url),
          url: data.url,
          content: JSON.stringify(data, null, 2),
          shieldEnabled: policy.promptInjectionShield,
        });
        return {
          content: [{ type: 'text', text: framed.text }],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 12 & 13. WebMCP Discovery & Execution
  // -------------------------------------------------------------------------

  server.registerTool(
    'browser_webmcp_list',
    {
      title: 'List WebMCP Page Tools',
      description:
        'Discover native client-side WebMCP tools exposed by the current web app via navigator.modelContext. Prefer calling WebMCP tools over manual clicking when available.',
      inputSchema: z.object({
        tabId: z.number().int().optional(),
        profileId: z.string().optional(),
      }),
    },
    async ({ tabId, profileId }) => {
      try {
        const { data } = await hub.callExtension<{
          supported: boolean;
          tools: WebMcpToolInfo[];
        }>('webmcp.list', { tabId }, { profileId, toolLabel: 'browser_webmcp_list' });

        if (!data.tools || data.tools.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: data.supported
                  ? 'Page supports WebMCP (navigator.modelContext), but no tools are currently registered.'
                  : 'No WebMCP tools exposed on this page.',
              },
            ],
          };
        }
        const policy = await hub.getLivePolicy();
        const framed = frameUntrustedPageContent({
          origin: 'webmcp-tools',
          url: `tab://${tabId ?? 'active'}`,
          content: JSON.stringify(data.tools, null, 2),
          shieldEnabled: policy.promptInjectionShield,
        });
        return {
          content: [{ type: 'text', text: framed.text }],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'browser_webmcp_call',
    {
      title: 'Call WebMCP Page Tool',
      description: 'Invoke a WebMCP tool discovered on the current page via navigator.modelContext.',
      inputSchema: z.object({
        tabId: z.number().int().optional(),
        name: z.string().min(1),
        arguments: z.record(z.string(), z.unknown()).default({}),
        profileId: z.string().optional(),
      }),
    },
    async ({ tabId, name, arguments: args, profileId }) => {
      try {
        const { defaultProfileId } = await hub.listProfiles();
        const activeProfile = profileId || defaultProfileId || 'default';
        const policy = await hub.getLivePolicy();
        const liveUrl = (await hub.getLiveTabUrl(activeProfile, tabId)) ?? '';
        const origin = liveUrl ? safeOriginFromUrl(liveUrl) : 'active-tab';

        if (liveUrl) {
          const blocked = isUrlBlocked(liveUrl, policy.blockedDomains, policy.allowedDomains);
          if (blocked.blocked) return errorResult(`Blocked by domain policy: ${blocked.reason}`);
          const roCheck = isUrlReadOnly(liveUrl, policy.readOnlyDomains);
          if (roCheck.readOnly) {
            await hub.requestApprovalIfNeeded({
              profileId: activeProfile,
              tabId,
              origin,
              action: `browser_webmcp_call:${name}`,
              reason: `WebMCP tool call requested on read-only domain (${roCheck.reason})`,
              risk: 'high',
              preview: `Call WebMCP tool "${name}" on ${origin}`,
              kind: 'read-only-override',
            });
          }
        }

        const { data } = await hub.callExtension<{ result: unknown }>(
          'webmcp.call',
          { tabId, name, arguments: args },
          { profileId, toolLabel: `webmcp:${name}` },
        );
        const serialized =
          typeof data.result === 'string' ? data.result : JSON.stringify(data.result, null, 2);
        const framed = frameUntrustedPageContent({
          origin,
          url: liveUrl || `tab://${tabId ?? 'active'}`,
          content: serialized ?? 'null',
          shieldEnabled: policy.promptInjectionShield,
        });
        return {
          content: [{ type: 'text', text: framed.text }],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 14. browser_workflows (Workflow Recorder Integration)
  // -------------------------------------------------------------------------

  server.registerTool(
    'browser_workflows',
    {
      title: 'Recorded Workflows',
      description:
        'List, inspect, replay (with {{variable}} interpolation), export to Playwright (.spec.ts), or delete workflows recorded by the user in Chrome Side Panel.',
      inputSchema: z.object({
        action: z.enum(['list', 'get', 'replay', 'export_playwright', 'delete']).default('list'),
        workflowId: z.string().optional(),
        variables: z
          .record(z.string(), z.string())
          .optional()
          .describe('Variable values for {{var}} placeholders when action="replay"'),
        tabId: z.number().int().optional(),
        profileId: z.string().optional(),
      }),
    },
    async ({ action, workflowId, variables, tabId, profileId }) => {
      try {
        const workflows = await hub.listWorkflows();
        if (action === 'list') {
          if (workflows.length === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'No recorded workflows yet. Use the Record button in Chrome Browser MCP Side Panel to capture a flow.',
                },
              ],
            };
          }
          const lines = workflows.map((w) => {
            const params = extractWorkflowParamNames(w);
            const paramStr = params.length > 0 ? ` [vars: ${params.join(', ')}]` : '';
            return `[${w.id}] "${w.name}" — ${w.steps.length} steps${paramStr} (start: ${w.startUrl})`;
          });
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        if (!workflowId) return errorResult('workflowId is required');
        if (action === 'delete') {
          const ok = await hub.deleteWorkflow(workflowId);
          return {
            content: [
              {
                type: 'text',
                text: ok ? `Deleted workflow ${workflowId}.` : `Workflow ${workflowId} not found.`,
              },
            ],
          };
        }

        const wf = workflows.find((w) => w.id === workflowId);
        if (!wf) return errorResult(`Workflow "${workflowId}" not found.`);

        if (action === 'get') {
          return { content: [{ type: 'text', text: JSON.stringify(wf, null, 2) }] };
        }

        if (action === 'export_playwright') {
          return { content: [{ type: 'text', text: exportWorkflowToPlaywright(wf) }] };
        }

        // Replay recorded steps through the FULL policy, upload, secret & approval pipeline
        const { steps } = interpolateWorkflowSteps(wf, variables ?? {});
        const { data } = await executeGatedBatchAct({
          tabId,
          steps,
          returnSnapshot: 'diff',
          forceCdp: false,
          profileId,
          toolLabel: `workflow:${wf.name}`,
          timeoutMs: 60_000,
        });

        return {
          isError: !data.ok,
          content: [
            {
              type: 'text',
              text: `Replayed workflow "${wf.name}": ${data.completedSteps}/${data.totalSteps} steps (${data.ok ? 'OK' : 'STOPPED ON ERROR'}).`,
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 15. browser_dialog (Native alert / confirm / prompt / beforeunload)
  // -------------------------------------------------------------------------

  server.registerTool(
    'browser_dialog',
    {
      title: 'Handle Browser Dialog',
      description:
        'Check for or respond to a native browser JavaScript dialog (alert, confirm, prompt, beforeunload) without hanging the tab.',
      inputSchema: z.object({
        action: z.enum(['status', 'accept', 'dismiss']).default('status'),
        promptText: z.string().optional().describe('Text to enter when accepting a prompt() dialog'),
        tabId: z.number().int().optional(),
        profileId: z.string().optional(),
      }),
    },
    async ({ action, promptText, tabId, profileId }) => {
      try {
        const policy = await hub.getLivePolicy();
        const { defaultProfileId } = await hub.listProfiles();
        const activeProfile = profileId || defaultProfileId || 'default';
        const liveUrl = (await hub.getLiveTabUrl(activeProfile, tabId)) ?? '';
        const origin = liveUrl ? safeOriginFromUrl(liveUrl) : 'active-tab';

        if ((action === 'accept' || action === 'dismiss') && policy.dialogPolicy === 'approval') {
          await hub.requestApprovalIfNeeded({
            profileId: activeProfile,
            tabId,
            origin,
            action: `browser_dialog:${action}`,
            reason: `Respond (${action}) to JavaScript dialog on ${origin}`,
            risk: 'medium',
            preview: `${action} JS dialog${promptText ? ` with "${promptText.slice(0, 80)}"` : ''} on ${origin}`,
            kind: 'dialog',
          });
        }

        const { data } = await hub.callExtension<{
          tabId?: number;
          dialog?: PendingDialog | null;
          handled?: boolean;
          previous?: PendingDialog | null;
        }>(
          'page.dialog',
          { action, promptText, tabId },
          { profileId, toolLabel: `browser_dialog:${action}` },
        );
        if (action === 'status') {
          if (!data.dialog) {
            return { content: [{ type: 'text', text: 'No active JavaScript dialog on this tab.' }] };
          }
          const framed = frameUntrustedPageContent({
            origin,
            url: liveUrl || `tab://${tabId ?? 'active'}`,
            content: `Pending ${data.dialog.type} dialog: ${JSON.stringify(data.dialog.message)}${data.dialog.defaultPrompt ? ` (default: ${JSON.stringify(data.dialog.defaultPrompt)})` : ''}`,
            shieldEnabled: policy.promptInjectionShield,
          });
          return {
            content: [{ type: 'text', text: framed.text }],
          };
        }
        if (data.previous) {
          const cleanPrev = sanitizePageText(data.previous.message).sanitized;
          const framedPrev = frameUntrustedPageContent({
            origin,
            url: liveUrl || `tab://${tabId ?? 'active'}`,
            content: `${data.previous.type}: ${JSON.stringify(cleanPrev)}`,
            shieldEnabled: policy.promptInjectionShield,
          });
          return {
            content: [
              {
                type: 'text',
                text: `${action === 'accept' ? 'Accepted' : 'Dismissed'} dialog.\n${framedPrev.text}`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: `${action === 'accept' ? 'Accepted' : 'Dismissed'} dialog.`,
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 16. browser_downloads (Optional chrome.downloads permission)
  // -------------------------------------------------------------------------

  server.registerTool(
    'browser_downloads',
    {
      title: 'Browser Downloads',
      description:
        'List recent browser downloads or wait for an in-progress download to finish (requires optional Downloads permission enabled in Side Panel -> Security -> Advanced Settings).',
      inputSchema: z.object({
        action: z.enum(['list', 'wait']).default('list'),
        limit: z.number().int().min(1).max(50).default(15),
        timeoutMs: z.number().int().min(1000).max(60000).default(15000),
        profileId: z.string().optional(),
      }),
    },
    async ({ action, limit, timeoutMs, profileId }) => {
      try {
        const { data } = await hub.callExtension<{
          permissionRequired?: boolean;
          hint?: string;
          downloads?: DownloadItem[];
          completed?: DownloadItem | null;
        }>(
          'browser.downloads',
          { action, limit, timeoutMs },
          { profileId, timeoutMs: timeoutMs + 5000, toolLabel: `browser_downloads:${action}` },
        );
        if (data.permissionRequired) {
          return {
            content: [{ type: 'text', text: data.hint || 'Optional downloads permission not granted.' }],
          };
        }
        if (action === 'wait') {
          if (!data.completed) {
            return { content: [{ type: 'text', text: `No download completed within ${timeoutMs}ms.` }] };
          }
          return { content: [{ type: 'text', text: JSON.stringify(data.completed, null, 2) }] };
        }
        if (!data.downloads || data.downloads.length === 0) {
          return { content: [{ type: 'text', text: 'No recent downloads found.' }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(data.downloads, null, 2) }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 17. browser_emulate (Device, Viewport, Color Scheme, Network, Geolocation)
  // -------------------------------------------------------------------------

  server.registerTool(
    'browser_emulate',
    {
      title: 'Emulate Device / Network / Theme',
      description:
        'Emulate mobile/desktop viewports (iphone-15, pixel-9, ipad, desktop, or custom width/height), prefers-color-scheme (light/dark), network throttling (fast-3g/slow-3g/offline), or geolocation via on-demand CDP. Use preset="reset" to clear.',
      inputSchema: EmulationConfigSchema.extend({
        tabId: z.number().int().optional(),
        profileId: z.string().optional(),
      }),
    },
    async ({ tabId, profileId, ...config }) => {
      try {
        const { data } = await hub.callExtension<{ tabId: number; applied: string[] }>(
          'page.emulate',
          { tabId, ...config },
          { profileId, toolLabel: 'browser_emulate' },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Emulation updated on tab ${data.tabId}: ${data.applied.join(', ') || 'no changes'}.`,
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 18. browser_audit_export (Session Replay HTML / JSON)
  // -------------------------------------------------------------------------

  server.registerTool(
    'browser_audit_export',
    {
      title: 'Export Session Audit Report',
      description:
        'Export the broker session activity log as structured JSON or a self-contained HTML replay report.',
      inputSchema: z.object({
        format: z.enum(['json', 'html']).default('json'),
      }),
    },
    async ({ format }) => {
      try {
        const res = await hub.exportAudit(format);
        return {
          content: [{ type: 'text', text: res.content }],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 15. browser_deck — Antigravity MCP App Entrypoint (aux_pane + global)
  // -------------------------------------------------------------------------

  server.registerTool(
    'browser_deck',
    {
      title: 'Browser Control Deck',
      description:
        'Open or refresh the interactive Browser Control Deck UI showing connected browser profiles, AI Agent tab group, live action timeline, screenshots, DevTools errors, approvals, and recorded workflows.',
      inputSchema: z.object({
        focusTab: z.enum(['overview', 'timeline', 'devtools', 'workflows', 'security']).optional(),
      }),
      _meta: {
        ui: {
          resourceUri: DECK_APP_URI,
        },
        'com.google.antigravity/ui': {
          entrypoints: [
            { type: 'aux_pane', title: 'Browser Deck' },
            { type: 'global', title: 'Browser Deck' },
          ],
        },
      },
    },
    async ({ focusTab }) => {
      try {
        const state = await hub.getDeckState();
        return {
          content: [
            {
              type: 'text',
              text: `Browser Control Deck ready: ${state.profiles.length} profile(s) connected, ${state.pendingApprovals.length} pending approval(s), paused=${state.paused}.`,
            },
          ],
          structuredContent: {
            focusTab: focusTab ?? 'overview',
            state,
          },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // App-Only Tools (visibility: ["app"]) for Browser Control Deck UI
  // -------------------------------------------------------------------------

  const APP_ONLY_META = { ui: { visibility: ['app'] } };

  server.registerTool(
    'deck_get_state',
    {
      title: 'Deck: Get State',
      inputSchema: z.object({}),
      _meta: APP_ONLY_META,
    },
    async () => {
      const state = await hub.getDeckState();
      return {
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { state },
      };
    },
  );

  server.registerTool(
    'deck_set_paused',
    {
      title: 'Deck: Set Paused',
      inputSchema: z.object({ paused: z.boolean(), deckSecret: z.string().optional() }),
      _meta: APP_ONLY_META,
    },
    async ({ paused, deckSecret: supplied }) => {
      assertDeckSecret(supplied);
      await hub.setPaused(paused);
      const state = await hub.getDeckState();
      return {
        content: [{ type: 'text', text: paused ? 'paused' : 'resumed' }],
        structuredContent: { state },
      };
    },
  );

  server.registerTool(
    'deck_select_profile',
    {
      title: 'Deck: Select Profile',
      inputSchema: z.object({ profileId: z.string(), deckSecret: z.string().optional() }),
      _meta: APP_ONLY_META,
    },
    async ({ profileId, deckSecret: supplied }) => {
      assertDeckSecret(supplied);
      await hub.selectDefaultProfile(profileId);
      const state = await hub.getDeckState();
      return {
        content: [{ type: 'text', text: `selected ${profileId}` }],
        structuredContent: { state },
      };
    },
  );

  server.registerTool(
    'deck_tab_action',
    {
      title: 'Deck: Tab Action',
      inputSchema: z.object({
        profileId: z.string(),
        tabId: z.number().int(),
        action: z.enum(['attach', 'detach', 'focus', 'close']),
        bringToFront: z.boolean().optional(),
        deckSecret: z.string().optional(),
      }),
      _meta: APP_ONLY_META,
    },
    async ({ profileId, tabId, action, bringToFront, deckSecret: supplied }) => {
      assertDeckSecret(supplied);
      const map = {
        attach: 'tabs.attach',
        detach: 'tabs.detach',
        focus: 'tabs.focus',
        close: 'tabs.close',
      } as const;
      await hub.callExtension(
        map[action],
        { tabId, userInitiated: true, bringToFront: Boolean(bringToFront) },
        { profileId, skipPauseCheck: true },
      );
      const state = await hub.getDeckState();
      return {
        content: [{ type: 'text', text: `tab ${tabId} ${action}` }],
        structuredContent: { state },
      };
    },
  );

  server.registerTool(
    'deck_resolve_approval',
    {
      title: 'Deck: Resolve Approval',
      inputSchema: z.object({
        approvalId: z.string(),
        decision: z.enum(['approved', 'rejected']),
        deckSecret: z.string().optional(),
      }),
      _meta: APP_ONLY_META,
    },
    async ({ approvalId, decision, deckSecret: supplied }) => {
      assertDeckSecret(supplied);
      await hub.resolveApproval(approvalId, decision);
      const state = await hub.getDeckState();
      return {
        content: [{ type: 'text', text: `${approvalId}: ${decision}` }],
        structuredContent: { state },
      };
    },
  );

  server.registerTool(
    'deck_update_policy',
    {
      title: 'Deck: Update Policy',
      inputSchema: SecurityPolicySchema.partial().extend({ deckSecret: z.string().optional() }),
      _meta: APP_ONLY_META,
    },
    async ({ deckSecret: supplied, ...patch }) => {
      assertDeckSecret(supplied);
      await hub.updatePolicy(patch);
      const state = await hub.getDeckState();
      return {
        content: [{ type: 'text', text: 'policy updated' }],
        structuredContent: { state },
      };
    },
  );

  server.registerTool(
    'deck_delete_workflow',
    {
      title: 'Deck: Delete Workflow',
      inputSchema: z.object({ workflowId: z.string(), deckSecret: z.string().optional() }),
      _meta: APP_ONLY_META,
    },
    async ({ workflowId, deckSecret: supplied }) => {
      assertDeckSecret(supplied);
      await hub.deleteWorkflow(workflowId);
      const state = await hub.getDeckState();
      return {
        content: [{ type: 'text', text: 'workflow deleted' }],
        structuredContent: { state },
      };
    },
  );

  server.registerTool(
    'deck_clear_diagnostics',
    {
      title: 'Deck: Clear Console or Network Diagnostics',
      inputSchema: z.object({
        target: z.enum(['console', 'network', 'all']).default('all'),
        deckSecret: z.string().optional(),
      }),
      _meta: APP_ONLY_META,
    },
    async ({ target, deckSecret: supplied }) => {
      assertDeckSecret(supplied);
      await hub.clearDiagnostics(target);
      const state = await hub.getDeckState();
      return {
        content: [{ type: 'text', text: `cleared ${target}` }],
        structuredContent: { state },
      };
    },
  );

  server.registerTool(
    'deck_create_pin',
    {
      title: 'Deck: Generate 6-Digit Pairing PIN',
      inputSchema: z.object({ deckSecret: z.string().optional() }),
      _meta: APP_ONLY_META,
    },
    async ({ deckSecret: supplied }) => {
      assertDeckSecret(supplied);
      const { pin, expiresAt } = await hub.createPairingPin();
      return {
        content: [{ type: 'text', text: 'Pairing PIN generated (valid 2 min)' }],
        structuredContent: { pin, expiresAt },
      };
    },
  );

  server.registerTool(
    'deck_handle_dialog',
    {
      title: 'Deck: Handle Browser Dialog',
      inputSchema: z.object({
        profileId: z.string(),
        tabId: z.number().int(),
        accept: z.boolean(),
        promptText: z.string().optional(),
        deckSecret: z.string().optional(),
      }),
      _meta: APP_ONLY_META,
    },
    async ({ profileId, tabId, accept, promptText, deckSecret: supplied }) => {
      assertDeckSecret(supplied);
      await hub.callExtension(
        'page.dialog',
        { action: accept ? 'accept' : 'dismiss', tabId, promptText },
        { profileId, skipPauseCheck: true },
      );
      const state = await hub.getDeckState();
      return {
        content: [{ type: 'text', text: accept ? 'dialog accepted' : 'dialog dismissed' }],
        structuredContent: { state },
      };
    },
  );

  return server;
}
