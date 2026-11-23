import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  ActionStepSchema,
  computeSnapshotDiff,
  formatFullSnapshot,
  frameUntrustedPageContent,
  PageSnapshotSchema,
  SecurityPolicySchema,
  type AuditResult,
  type BatchActResult,
  type ConsoleEntry,
  type NetworkEntry,
  type TabInfo,
  type WebMcpToolInfo,
} from '@chrome-browser-mcp/protocol';
import { SERVER_VERSION, type BrowserHubInterface } from './hub.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DECK_APP_URI = 'ui://chrome-browser/deck.html';

const PAYMENT_KEYWORDS = /\b(pay\s*now|place\s*order|confirm\s*purchase|checkout|complete\s*payment|transfer\s*funds|delete\s*account)\b/i;

function loadDeckHtml(): string {
  const candidates = [
    process.env.CHROME_BROWSER_MCP_APP_HTML,
    resolve(__dirname, 'app/deck.html'),
    resolve(__dirname, '../../mcp-app/dist/index.html'),
  ].filter(Boolean) as string[];

  for (const path of candidates) {
    if (existsSync(path)) {
      return readFileSync(path, 'utf8');
    }
  }

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="color-scheme" content="light dark" />
  <title>Browser Control Deck</title>
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

export function createBrowserMcpServer(hub: BrowserHubInterface): McpServer {
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
      description: 'Live Antigravity MCP App for controlling connected Chrome tabs, approvals, DevTools errors, and recorded workflows.',
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
          text: loadDeckHtml(),
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
      description: 'List connected browser profiles (Chrome, Arc, Brave, Edge) or switch the default active profile.',
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
                text: 'No browser profiles connected yet. Load the Chrome Browser MCP extension and enter the pairing token (`npx chrome-browser-mcp token`).',
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
        'List, open, focus, close, attach, or detach browser tabs. By default only tabs inside the AI Agent tab group are accessible.',
      inputSchema: z.object({
        action: z.enum(['list', 'open', 'focus', 'close', 'attach', 'detach']).default('list'),
        tabId: z.number().int().optional(),
        url: z.string().url().optional().describe('URL to open when action is "open"'),
        active: z.boolean().default(true).describe('Focus newly opened tab'),
        profileId: z.string().optional(),
      }),
    },
    async ({ action, tabId, url, active, profileId }) => {
      try {
        if (action === 'open' && url) {
          const check = hub.checkUrlPolicy(url);
          if (check.blocked) {
            return errorResult(`Blocked by domain policy: ${check.reason}`);
          }
        }

        const methodMap = {
          list: 'tabs.list',
          open: 'tabs.open',
          focus: 'tabs.focus',
          close: 'tabs.close',
          attach: 'tabs.attach',
          detach: 'tabs.detach',
        } as const;

        const { data } = await hub.callExtension<TabInfo | TabInfo[] | { closed: boolean }>(
          methodMap[action],
          { tabId, url, active },
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
        if (action === 'goto') {
          if (!url) return errorResult('url is required for action="goto"');
          const check = hub.checkUrlPolicy(url);
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
        useCdp: z.boolean().default(false).describe('Escalate to chrome.debugger Accessibility tree (cross-origin iframes / closed shadow DOM)'),
        maxNodes: z.number().int().min(20).max(500).default(220),
        profileId: z.string().optional(),
      }),
    },
    async ({ tabId, mode, includeOffscreen, useCdp, maxNodes, profileId }) => {
      try {
        const { profileId: resolvedProfile, data } = await hub.callExtension<unknown>(
          'page.snapshot',
          { tabId, includeOffscreen, useCdp, maxNodes },
          { profileId, toolLabel: 'browser_snapshot' },
        );

        const snapshot = PageSnapshotSchema.parse(data);
        const policy = hub.getPolicy();
        const urlCheck = hub.checkUrlPolicy(snapshot.url);
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
        'Extract clean readable Markdown text from the page (or CSS selector), with chunk pagination (offset + maxChars up to 200k), interactive tab hints, and Prompt-Injection Shield.',
      inputSchema: z.object({
        tabId: z.number().int().optional(),
        selector: z.string().optional(),
        offset: z.number().int().min(0).default(0).describe('Character offset for paginating long pages without reloading'),
        maxChars: z.number().int().min(500).max(200000).default(30000),
        scope: z.enum(['main', 'body']).default('main').describe('Read primary content ("main") or entire document body ("body")'),
        profileId: z.string().optional(),
      }),
    },
    async ({ tabId, selector, offset, maxChars, scope, profileId }) => {
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
        }>(
          'page.read',
          { tabId, selector, offset, maxChars, scope },
          { profileId, toolLabel: 'browser_read' },
        );

        const urlCheck = hub.checkUrlPolicy(data.url);
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
        setOfMark: z.boolean().default(false).describe('Overlay element ref badges on interactive elements before capture'),
        fullPage: z.boolean().default(false),
        format: z.enum(['jpeg', 'webp', 'png']).default('webp'),
        quality: z.number().int().min(30).max(95).default(75),
        profileId: z.string().optional(),
      }),
    },
    async ({ tabId, setOfMark, fullPage, format, quality, profileId }) => {
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
          { tabId, setOfMark, fullPage, format, quality },
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

  server.registerTool(
    'browser_act',
    {
      title: 'Act on Page (Single or Batch)',
      description:
        'Execute one action or an ordered batch of actions (click, fill, type, press, select, check, scroll, hover, drag, wait) in a single round-trip. Stops on first error and returns an automatic diff snapshot.',
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
        const resolvedProfiles = await hub.listProfiles();
        const activeProfileId = profileId || resolvedProfiles.defaultProfileId || 'default';

        // Inspect previous snapshot to detect password/payment gates before dispatching
        const prevSnap = tabId !== undefined ? hub.getPreviousSnapshot(activeProfileId, tabId) : undefined;
        const origin = prevSnap?.origin ?? 'active-tab';

        for (const step of steps) {
          if ((step.kind === 'fill' || step.kind === 'type') && step.ref && prevSnap) {
            const targetNode = prevSnap.nodes.find((n) => n.ref === step.ref);
            if (targetNode?.inputType === 'password') {
              await hub.requestApprovalIfNeeded({
                profileId: activeProfileId,
                tabId,
                origin,
                action: 'browser_act:password_input',
                reason: `Filling password field "${targetNode.name || targetNode.ref}" on ${origin}`,
                risk: 'high',
                preview: `Fill password input [${targetNode.ref}] on ${origin}`,
                kind: 'password',
              });
            }
          }
          if (step.kind === 'click' && step.ref && prevSnap) {
            const targetNode = prevSnap.nodes.find((n) => n.ref === step.ref);
            if (targetNode && PAYMENT_KEYWORDS.test(targetNode.name)) {
              await hub.requestApprovalIfNeeded({
                profileId: activeProfileId,
                tabId,
                origin,
                action: 'browser_act:sensitive_submit',
                reason: `Clicking sensitive control "${targetNode.name}" on ${origin}`,
                risk: 'critical',
                preview: `Click [${targetNode.ref}] "${targetNode.name}" on ${origin}`,
                kind: 'payment',
              });
            }
          }
        }

        const { profileId: usedProfile, data } = await hub.callExtension<BatchActResult>(
          'page.act',
          { tabId, steps, returnSnapshot, forceCdp },
          { profileId, timeoutMs: 45_000, toolLabel: `browser_act(${steps.length})` },
        );

        const summaryLines = [
          `Executed ${data.completedSteps}/${data.totalSteps} step(s) on tab ${data.tabId} (${data.ok ? 'OK' : 'STOPPED ON ERROR'}):`,
          ...data.outcomes.map(
            (o) =>
              `  ${o.index + 1}. ${o.kind} [${o.ok ? 'ok' : 'FAIL'}${o.engine ? `, ${o.engine}` : ''}, ${o.durationMs}ms]${o.detail ? ` — ${o.detail}` : ''}${o.error ? ` — ERROR: ${o.error}` : ''}`,
          ),
        ];

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
            shieldEnabled: hub.getPolicy().promptInjectionShield,
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
        attachCdp: z.boolean().default(true).describe('Ensure CDP Console/Runtime capture is active on the tab'),
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
          (c) => `[${new Date(c.timestamp).toISOString().slice(11, 23)}] [${c.level.toUpperCase()}] ${c.text}${c.source ? ` (${c.source}${c.line ? `:${c.line}` : ''})` : ''}`,
        );
        return { content: [{ type: 'text', text: lines.join('\n') }] };
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
      description: 'Inspect recent XHR/Fetch/document network requests and failures (sensitive headers redacted).',
      inputSchema: z.object({
        tabId: z.number().int().optional(),
        onlyFailed: z.boolean().default(false),
        urlFilter: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(40),
        profileId: z.string().optional(),
      }),
    },
    async ({ tabId, onlyFailed, urlFilter, limit, profileId }) => {
      try {
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
            `${n.method} ${n.status ?? (n.failed ? 'FAIL' : 'PENDING')} ${n.url}${n.durationMs ? ` (${n.durationMs}ms)` : ''}${n.errorText ? ` — ${n.errorText}` : ''}${n.responsePreview ? `\n    preview: ${n.responsePreview.slice(0, 180)}` : ''}`,
        );
        return { content: [{ type: 'text', text: lines.join('\n') }] };
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
        const prevSnap = tabId !== undefined ? hub.getPreviousSnapshot(activeProfile, tabId) : undefined;
        const origin = prevSnap?.origin ?? 'active-tab';

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
          { tabId, expression, awaitPromise },
          { profileId, toolLabel: 'browser_eval' },
        );

        if (data.exception) {
          return errorResult(`JS exception: ${data.exception}`);
        }
        const serialized =
          typeof data.value === 'string' ? data.value : JSON.stringify(data.value, null, 2);
        return {
          content: [{ type: 'text', text: serialized ?? 'undefined' }],
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
      description: 'Run quick accessibility, performance timing (LCP/CLS/DOM size), and storage key audits on the tab.',
      inputSchema: z.object({
        tabId: z.number().int().optional(),
        profileId: z.string().optional(),
      }),
    },
    async ({ tabId, profileId }) => {
      try {
        const { data } = await hub.callExtension<AuditResult>(
          'devtools.audit',
          { tabId },
          { profileId, toolLabel: 'browser_audit' },
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
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
        }>(
          'webmcp.list',
          { tabId },
          { profileId, toolLabel: 'browser_webmcp_list' },
        );

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
        return {
          content: [{ type: 'text', text: JSON.stringify(data.tools, null, 2) }],
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
        const { data } = await hub.callExtension<{ result: unknown }>(
          'webmcp.call',
          { tabId, name, arguments: args },
          { profileId, toolLabel: `webmcp:${name}` },
        );
        return {
          content: [
            {
              type: 'text',
              text:
                typeof data.result === 'string'
                  ? data.result
                  : JSON.stringify(data.result, null, 2),
            },
          ],
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
        'List or replay workflows recorded by the user in the Chrome Side Panel ("show by hand"). Replaying executes the recorded batch steps on the target tab.',
      inputSchema: z.object({
        action: z.enum(['list', 'get', 'replay', 'delete']).default('list'),
        workflowId: z.string().optional(),
        tabId: z.number().int().optional(),
        profileId: z.string().optional(),
      }),
    },
    async ({ action, workflowId, tabId, profileId }) => {
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
          const lines = workflows.map(
            (w) => `[${w.id}] "${w.name}" — ${w.steps.length} steps (start: ${w.startUrl})`,
          );
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        if (!workflowId) return errorResult('workflowId is required');
        if (action === 'delete') {
          const ok = await hub.deleteWorkflow(workflowId);
          return { content: [{ type: 'text', text: ok ? `Deleted workflow ${workflowId}.` : `Workflow ${workflowId} not found.` }] };
        }

        const wf = workflows.find((w) => w.id === workflowId);
        if (!wf) return errorResult(`Workflow "${workflowId}" not found.`);

        if (action === 'get') {
          return { content: [{ type: 'text', text: JSON.stringify(wf, null, 2) }] };
        }

        // Replay recorded steps via page.act
        const steps = wf.steps.map((s) => s.step);
        const { data } = await hub.callExtension<BatchActResult>(
          'page.act',
          { tabId, steps, returnSnapshot: 'diff', forceCdp: false },
          { profileId, timeoutMs: 60_000, toolLabel: `workflow:${wf.name}` },
        );

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
      inputSchema: z.object({ paused: z.boolean() }),
      _meta: APP_ONLY_META,
    },
    async ({ paused }) => {
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
      inputSchema: z.object({ profileId: z.string() }),
      _meta: APP_ONLY_META,
    },
    async ({ profileId }) => {
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
      }),
      _meta: APP_ONLY_META,
    },
    async ({ profileId, tabId, action }) => {
      const map = {
        attach: 'tabs.attach',
        detach: 'tabs.detach',
        focus: 'tabs.focus',
        close: 'tabs.close',
      } as const;
      await hub.callExtension(map[action], { tabId }, { profileId, skipPauseCheck: true });
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
      }),
      _meta: APP_ONLY_META,
    },
    async ({ approvalId, decision }) => {
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
      inputSchema: SecurityPolicySchema.partial(),
      _meta: APP_ONLY_META,
    },
    async (patch) => {
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
      inputSchema: z.object({ workflowId: z.string() }),
      _meta: APP_ONLY_META,
    },
    async ({ workflowId }) => {
      await hub.deleteWorkflow(workflowId);
      const state = await hub.getDeckState();
      return {
        content: [{ type: 'text', text: 'workflow deleted' }],
        structuredContent: { state },
      };
    },
  );

  return server;
}
