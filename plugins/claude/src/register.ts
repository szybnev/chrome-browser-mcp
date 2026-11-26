/**
 * Claude Desktop / Claude Code Mod for Chrome Browser MCP.
 *
 * Provides:
 *  - Side Pane (`component: 'Pane'`, `/browser-deck`) with all 5 Control Deck tabs:
 *    Overview (AI Agent Tabs, Viewport Capture card, All Browser Tabs + live filter),
 *    Timeline, DevTools (Console & Network errors + clear), Workflows, and Security Policy.
 *  - Compact AbovePrompt live status strip (`component: 'AbovePrompt'`) with quick
 *    Deck toggle, Pause/Resume, and 1-click inline Approval buttons.
 *  - Shared Broker Daemon transport over loopback `127.0.0.1:43179/internal/deck-tool`
 *    using strictly the sandboxed Claude Code Mods API (`$.env`, `$.fs`, `$.http`,
 *    `$.store`, `$.clock`, `$.command`, `$.ui`) with zero Node.js built-in imports.
 */
import type { DeckState, TabInfo } from '@chrome-browser-mcp/protocol';
import { type I18nKey, type Locale, resolveLocale, translate } from '../../../packages/protocol/dist/i18n.js';

const READ_ONLY_DOMAIN_PRESETS = ['mail.google.com', 'github.com', 'linear.app'] as const;

export const PANE_ID = 'chrome-browser-deck';
const DEFAULT_BROKER_PORT = 43179;
const POLL_MS = 3000;

export type DeckTab = 'overview' | 'timeline' | 'devtools' | 'workflows' | 'security';
const VALID_TABS: readonly DeckTab[] = ['overview', 'timeline', 'devtools', 'workflows', 'security'];

export interface DeckToolCallResponse {
  state?: DeckState;
  pin?: string;
  expiresAt?: number;
  copied?: boolean;
}

// ---------------------------------------------------------------------------
// Minimal Claude Mods Runtime Types (matches Claude Code v2.1.287+ / v2.1.331)
// ---------------------------------------------------------------------------

type UiElementFn = (props?: Record<string, unknown>) => unknown;

interface ClaudeUiElements {
  Box: UiElementFn;
  Text: UiElementFn;
  Button: UiElementFn;
  Input?: UiElementFn;
  Select?: UiElementFn;
  Link?: UiElementFn;
  Svg?: UiElementFn;
}

export interface ClaudeModHttpResponse {
  status: number;
  ok: boolean;
  headers?: Record<string, string>;
  text: string;
}

export interface ClaudeModApi {
  env: {
    get(name: string): Promise<string | undefined>;
  };
  fs: {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
  };
  http: {
    fetch(
      url: string,
      init?: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
      },
    ): Promise<ClaudeModHttpResponse>;
  };
  store: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
  clock: {
    every(ms: number, fn: () => void): void;
  };
  command: {
    register(def: { name: string; description: string; immediate?: boolean }): Promise<void>;
  };
  ui: {
    open(opts: {
      id: string;
      title?: string;
      focus?: true;
      closeOnEscape?: true;
      columns?: number;
    }): Promise<unknown>;
    close(opts: { id: string }): Promise<unknown>;
    invalidate(event: string): void;
    resolve(e: unknown): ClaudeUiElements;
  };
}

export type ModHookHandler = (
  $: ClaudeModApi,
  e: Record<string, unknown>,
  next: (ev: Record<string, unknown>) => unknown,
) => Promise<unknown>;

export type ModHookRegistrar = (
  event: string,
  matcherOrHandler: Record<string, unknown> | ModHookHandler,
  maybeHandler?: ModHookHandler,
) => unknown;

// ---------------------------------------------------------------------------
// Module-Level Mod State
// ---------------------------------------------------------------------------

let state: DeckState | null = null;
let lastError: string | null = null;
let notice: string | null = null;
let pairingPin: { pin: string; expiresAt: number } | null = null;
let paneOpen = false;
let activeTab: DeckTab = 'overview';
let tabQuery = '';
let showBand = true;
let captureCollapsed = false;
let locale: Locale = 'en';
let inFlight = false;

export function resetModStateForTest(): void {
  state = null;
  lastError = null;
  notice = null;
  pairingPin = null;
  paneOpen = false;
  activeTab = 'overview';
  tabQuery = '';
  showBand = true;
  captureCollapsed = false;
  locale = 'en';
  inFlight = false;
}

// ---------------------------------------------------------------------------
// Pure Helpers (no `$` access)
// ---------------------------------------------------------------------------

function tr(key: I18nKey, vars?: Record<string, string | number>): string {
  return translate(locale, key, vars);
}

function joinPath(base: string, child: string): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${sep}${child}`;
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(1, maxLen - 1))}…`;
}

function buildDesktopStatusSvg(
  connected: boolean,
  paused: boolean,
  agentTabs: number,
  totalTabs: number,
): string {
  const accent = paused ? '#f59e0b' : connected ? '#2563eb' : '#64748b';
  const statusLabel = paused ? 'PAUSED' : connected ? 'LIVE' : 'OFFLINE';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 44" width="320" height="44"><rect x="1" y="1" width="318" height="42" rx="10" fill="#141518" stroke="#2c2f36"/><circle cx="20" cy="22" r="5" fill="${accent}"/><text x="34" y="20" fill="#f1f3f5" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Browser Control Deck · ${statusLabel}</text><text x="34" y="34" fill="#9ca3af" font-family="system-ui,sans-serif" font-size="10">${agentTabs} AI Agent tabs · ${totalTabs} total tabs</text></svg>`;
}

// ---------------------------------------------------------------------------
// Top-Level `$` Helper (1-hop, top-level function for `claude plugin validate`)
// ---------------------------------------------------------------------------

async function executeDeckTool(
  $: ClaudeModApi,
  name: string,
  args: Record<string, unknown>,
  mode: 'action' | 'refresh',
): Promise<void> {
  if (mode === 'refresh') {
    if (inFlight) return;
    inFlight = true;
  }

  try {
    const rawPort = (await $.env.get('CHROME_BROWSER_MCP_PORT').catch(() => undefined))?.trim();
    const parsedPort = rawPort ? Number(rawPort) : DEFAULT_BROKER_PORT;
    const port =
      Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535
        ? parsedPort
        : DEFAULT_BROKER_PORT;

    const customDataDir = (await $.env.get('CHROME_BROWSER_MCP_DATA_DIR').catch(() => undefined))?.trim();
    let dataDir = customDataDir || '';
    if (!dataDir) {
      const home =
        (await $.env.get('HOME').catch(() => undefined))?.trim() ||
        (await $.env.get('USERPROFILE').catch(() => undefined))?.trim() ||
        '';
      dataDir = home ? joinPath(home, '.chrome-browser-mcp') : '.chrome-browser-mcp';
    }
    const brokerUrl = `http://127.0.0.1:${port}`;

    let token = (await $.env.get('CHROME_BROWSER_MCP_TOKEN').catch(() => undefined))?.trim() || '';
    if (!token) {
      const tokenFile = joinPath(dataDir, 'token.txt');
      if (await $.fs.exists(tokenFile).catch(() => false)) {
        token = (await $.fs.read(tokenFile).catch(() => '')).trim();
      }
    }
    if (!token) {
      throw new Error(
        `Broker token missing in ${joinPath(dataDir, 'token.txt')}. Ensure the chrome-browser MCP server is connected.`,
      );
    }

    let res: ClaudeModHttpResponse;
    try {
      res = await $.http.fetch(`${brokerUrl}/internal/deck-tool`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-broker-token': token,
        },
        body: JSON.stringify({ name, arguments: args }),
      });
    } catch {
      throw new Error(
        `Local Chrome Browser MCP broker unreachable at ${brokerUrl}. Ensure the chrome-browser MCP server is running.`,
      );
    }

    if (res.status === 404) {
      let versionNote = '';
      try {
        const healthRes = await $.http.fetch(`${brokerUrl}/health`);
        if (healthRes.ok) {
          const health = JSON.parse(healthRes.text) as { version?: string };
          if (health.version) versionNote = ` (running v${health.version})`;
        }
      } catch {
        // ignore secondary probe error
      }
      throw new Error(
        `Local broker at ${brokerUrl}${versionNote} does not expose /internal/deck-tool. Restart the local broker daemon.`,
      );
    }

    let parsed: { ok?: boolean; data?: DeckToolCallResponse; error?: string };
    try {
      parsed = JSON.parse(res.text) as {
        ok?: boolean;
        data?: DeckToolCallResponse;
        error?: string;
      };
    } catch {
      throw new Error(`Broker returned invalid JSON (HTTP ${res.status})`);
    }

    if (!res.ok || parsed.ok === false) {
      throw new Error(parsed.error || `Broker HTTP error ${res.status}`);
    }

    const data = parsed.data ?? {};
    if (data.state) {
      state = data.state;
      lastError = null;
    }
    if (mode === 'action' && data.pin && data.expiresAt) {
      pairingPin = { pin: data.pin, expiresAt: data.expiresAt };
      notice = data.copied ? `${tr('status.copied')} (${data.pin})` : `PIN: ${data.pin} (valid 2m)`;
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    if (mode === 'action') {
      notice = lastError;
    }
  } finally {
    if (mode === 'refresh') {
      inFlight = false;
    }
    $.ui.invalidate('ui.render');
  }
}

// ---------------------------------------------------------------------------
// Mod Registration Entrypoint
// ---------------------------------------------------------------------------

export function register(on: ModHookRegistrar): void {
  on('session.start', async ($, e, next) => {
    const savedLocale = await $.store.get('locale');
    if (savedLocale === 'en' || savedLocale === 'ru' || savedLocale === 'zh-CN') {
      locale = savedLocale;
    }
    const savedBand = await $.store.get('showBand');
    if (typeof savedBand === 'boolean') {
      showBand = savedBand;
    }

    await $.command.register({
      name: 'browser-deck',
      description:
        'Open the Browser Control Deck pane (/browser-deck [tab|pause|resume|pin|band on|off|close])',
      immediate: true,
    });

    void executeDeckTool($, 'deck_get_state', {}, 'refresh');

    $.clock.every(POLL_MS, () => {
      if (paneOpen || showBand || (state?.pendingApprovals.length ?? 0) > 0) {
        void executeDeckTool($, 'deck_get_state', {}, 'refresh');
      }
    });

    return next(e);
  });

  on('ui.close', async (_$, e, next) => {
    if (e.id === PANE_ID) {
      paneOpen = false;
    }
    return next(e);
  });

  on('command.run', { command: 'browser-deck' }, async ($, e) => {
    const arg = (typeof e.args === 'string' ? e.args : '').trim().toLowerCase();

    if (arg === 'close') {
      paneOpen = false;
      await $.ui.close({ id: PANE_ID });
      return {};
    }
    if (arg === 'pause' || arg === 'resume') {
      await executeDeckTool($, 'deck_set_paused', { paused: arg === 'pause' }, 'action');
      return { text: arg === 'pause' ? 'Browser automation paused.' : 'Browser automation resumed.' };
    }
    if (arg === 'pin') {
      await executeDeckTool($, 'deck_create_pin', {}, 'action');
      return {
        text: pairingPin
          ? `Pairing PIN: ${pairingPin.pin} (valid 2 min — paste into Chrome Side Panel → Pair)`
          : lastError || 'Could not generate pairing PIN.',
      };
    }
    if (arg === 'band on' || arg === 'band off') {
      showBand = arg === 'band on';
      await $.store.set('showBand', showBand);
      $.ui.invalidate('ui.render');
      return { text: showBand ? 'Browser Deck status bar shown.' : 'Browser Deck status bar hidden.' };
    }
    if ((VALID_TABS as readonly string[]).includes(arg)) {
      activeTab = arg as DeckTab;
    }

    paneOpen = true;
    await $.ui.open({
      id: PANE_ID,
      title: 'Browser Deck',
      focus: true,
      closeOnEscape: true,
    });
    void executeDeckTool($, 'deck_get_state', {}, 'refresh');
    return {};
  });

  // -------------------------------------------------------------------------
  // Compact AbovePrompt Status Bar
  // -------------------------------------------------------------------------
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const props = e.props as { hasSurvey?: boolean } | undefined;
    const hasPending = (state?.pendingApprovals.length ?? 0) > 0;
    if (props?.hasSurvey || (!showBand && !hasPending)) {
      return next(e);
    }

    const { Box, Text, Button } = $.ui.resolve(e);
    const activeProfileId = state?.defaultProfileId ?? state?.profiles[0]?.profileId ?? '';
    const tabs = activeProfileId && state ? (state.tabs[activeProfileId] ?? []) : [];
    const agentCount = tabs.filter((t) => t.inAgentGroup).length;
    const firstApproval = state?.pendingApprovals[0];

    const children: unknown[] = [
      Text({
        bold: true,
        color: state?.paused ? 'yellow' : state?.profiles.length ? 'green' : 'gray',
        children: [state?.paused ? '⏸ Chrome' : state?.profiles.length ? '● Chrome' : '○ Chrome'],
      }),
      Text({
        dimColor: true,
        children: [
          state
            ? ` ${agentCount} AI tabs · ${tabs.length} total`
            : lastError
              ? ' broker offline'
              : ' connecting…',
        ],
      }),
    ];

    if (firstApproval) {
      children.push(
        Text({
          bold: true,
          color: 'yellow',
          children: [` · ⚠ ${firstApproval.action} (${firstApproval.origin})`],
        }),
        Button({
          key: 'band-approve',
          label: tr('btn.approve'),
          onPress: () =>
            void executeDeckTool(
              $,
              'deck_resolve_approval',
              {
                approvalId: firstApproval.id,
                decision: 'approved',
              },
              'action',
            ),
        }),
        Button({
          key: 'band-deny',
          label: tr('btn.deny'),
          onPress: () =>
            void executeDeckTool(
              $,
              'deck_resolve_approval',
              {
                approvalId: firstApproval.id,
                decision: 'rejected',
              },
              'action',
            ),
        }),
      );
    }

    children.push(
      Button({
        key: 'band-deck',
        label: paneOpen ? 'Hide Deck' : 'Browser Deck',
        plain: true,
        onPress: async () => {
          if (paneOpen) {
            paneOpen = false;
            await $.ui.close({ id: PANE_ID });
          } else {
            paneOpen = true;
            await $.ui.open({ id: PANE_ID, title: 'Browser Deck', focus: true, closeOnEscape: true });
            void executeDeckTool($, 'deck_get_state', {}, 'refresh');
          }
        },
      }),
    );

    if (state) {
      children.push(
        Button({
          key: 'band-pause',
          label: state.paused ? tr('btn.resume') : tr('btn.pauseAll'),
          plain: true,
          onPress: () => void executeDeckTool($, 'deck_set_paused', { paused: !state?.paused }, 'action'),
        }),
      );
    }

    return Box({
      flexDirection: 'row',
      columnGap: 1,
      children,
    });
  });

  // -------------------------------------------------------------------------
  // Full 5-Tab Browser Control Deck Side Pane
  // -------------------------------------------------------------------------
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e);

    const { Box, Text, Button, Input, Select, Svg } = $.ui.resolve(e);
    const redraw = () => $.ui.invalidate('ui.render');

    if (!state) {
      return Box({
        flexDirection: 'column',
        gap: 1,
        padding: 1,
        children: [
          Text({ bold: true, children: [tr('app.deckTitle')] }),
          Text({
            color: lastError ? 'red' : 'gray',
            children: [lastError ?? 'Connecting to Chrome Browser MCP Broker Daemon…'],
          }),
          Box({
            flexDirection: 'row',
            columnGap: 2,
            children: [
              Button({
                key: 'retry',
                label: tr('btn.refresh'),
                onPress: () => void executeDeckTool($, 'deck_get_state', {}, 'refresh'),
              }),
              Button({
                key: 'close-err',
                label: 'Close',
                plain: true,
                onPress: async () => {
                  paneOpen = false;
                  await $.ui.close({ id: PANE_ID });
                },
              }),
            ],
          }),
        ],
      });
    }

    const activeProfileId = state.defaultProfileId ?? state.profiles[0]?.profileId ?? '';
    const profileTabs = activeProfileId ? (state.tabs[activeProfileId] ?? []) : [];
    const agentTabs = profileTabs.filter((t) => t.inAgentGroup);
    const controlledCount = state.policy.scopeMode === 'all-tabs' ? profileTabs.length : agentTabs.length;
    const q = tabQuery.trim().toLowerCase();
    const otherTabs = profileTabs.filter(
      (t) =>
        !t.inAgentGroup &&
        (!q ||
          t.title.toLowerCase().includes(q) ||
          t.url.toLowerCase().includes(q) ||
          String(t.tabId).includes(q)),
    );

    // Header + Profile / Action Bar
    const headerChildren: unknown[] = [
      Box({
        flexDirection: 'row',
        columnGap: 2,
        children: [
          Text({
            bold: true,
            color: state.profiles.length > 0 ? 'blue' : 'gray',
            children: [`● ${tr('app.deckTitle')}`],
          }),
          Text({
            dimColor: true,
            children: [
              `v${state.brokerVersion} · ${state.profiles.length} ${tr('label.profilesCount')} · ${profileTabs.length} ${tr('label.tabsCount')}`,
            ],
          }),
          ...(Select
            ? [
                Select({
                  key: 'lang-select',
                  label: 'Lang',
                  value: locale,
                  options: [
                    { value: 'en', label: 'EN' },
                    { value: 'ru', label: 'RU' },
                    { value: 'zh-CN', label: '中文' },
                  ],
                  onSelect: async (val: string) => {
                    locale = resolveLocale(val);
                    await $.store.set('locale', locale);
                    await executeDeckTool($, 'deck_update_policy', { uiLocale: locale }, 'action');
                  },
                }),
              ]
            : []),
        ],
      }),
    ];

    if (e.surface === 'desktop' && Svg) {
      headerChildren.push(
        Svg({
          alt: `Browser Control Deck (${agentTabs.length} AI tabs, ${profileTabs.length} total)`,
          width: 320,
          height: 44,
          source: buildDesktopStatusSvg(
            state.profiles.length > 0,
            state.paused,
            agentTabs.length,
            profileTabs.length,
          ),
        }),
      );
    }

    const controlBarChildren: unknown[] = [];
    if (state.profiles.length > 0 && Select) {
      controlBarChildren.push(
        Select({
          key: 'profile-select',
          label: 'Profile',
          value: activeProfileId,
          options: state.profiles.map((p) => ({
            value: p.profileId,
            label: `${p.browserName}: ${p.profileLabel || p.profileId} (${p.profileId})`,
          })),
          onSelect: (val: string) =>
            void executeDeckTool($, 'deck_select_profile', { profileId: val }, 'action'),
        }),
      );
    }
    controlBarChildren.push(
      Button({
        key: 'gen-pin',
        label: tr('btn.generatePin'),
        onPress: () => void executeDeckTool($, 'deck_create_pin', {}, 'action'),
      }),
      Button({
        key: 'refresh',
        label: tr('btn.refresh'),
        onPress: () => void executeDeckTool($, 'deck_get_state', {}, 'refresh'),
      }),
      Button({
        key: 'pause-toggle',
        label: state.paused ? tr('btn.resume') : tr('btn.pauseAll'),
        onPress: () => void executeDeckTool($, 'deck_set_paused', { paused: !state?.paused }, 'action'),
      }),
    );

    headerChildren.push(Box({ flexDirection: 'row', columnGap: 1, children: controlBarChildren }));

    if (pairingPin && Date.now() < pairingPin.expiresAt) {
      headerChildren.push(
        Box({
          borderStyle: 'round',
          paddingX: 1,
          flexDirection: 'row',
          columnGap: 2,
          children: [
            Text({ bold: true, color: 'green', children: [`PIN: ${pairingPin.pin}`] }),
            Text({ dimColor: true, children: ['Paste in Chrome Side Panel → Pair (valid 2m)'] }),
            Button({
              key: 'pin-dismiss',
              label: '✕',
              plain: true,
              onPress: () => {
                pairingPin = null;
                redraw();
              },
            }),
          ],
        }),
      );
    }

    if (notice) {
      headerChildren.push(Text({ color: 'yellow', children: [notice] }));
    }

    // Pending Approvals Alert
    for (const ap of state.pendingApprovals) {
      headerChildren.push(
        Box({
          borderStyle: 'round',
          borderColor: 'yellow',
          paddingX: 1,
          flexDirection: 'column',
          children: [
            Text({
              bold: true,
              color: 'yellow',
              children: [`⚠ Approval required: ${ap.action} (${ap.origin})`],
            }),
            Text({ dimColor: true, children: [truncateText(ap.reason || ap.preview, 90)] }),
            Box({
              flexDirection: 'row',
              columnGap: 2,
              children: [
                Button({
                  key: `ap-ok-${ap.id}`,
                  label: tr('btn.approve'),
                  onPress: () =>
                    void executeDeckTool(
                      $,
                      'deck_resolve_approval',
                      { approvalId: ap.id, decision: 'approved' },
                      'action',
                    ),
                }),
                Button({
                  key: `ap-no-${ap.id}`,
                  label: tr('btn.deny'),
                  onPress: () =>
                    void executeDeckTool(
                      $,
                      'deck_resolve_approval',
                      { approvalId: ap.id, decision: 'rejected' },
                      'action',
                    ),
                }),
              ],
            }),
          ],
        }),
      );
    }

    // Tab Strip (hotkeys 1-5)
    const tabDefs: Array<{ id: DeckTab; label: string; hotkey: string }> = [
      { id: 'overview', label: `${tr('tab.overview')} (${controlledCount})`, hotkey: '1' },
      { id: 'timeline', label: `${tr('tab.timeline')} (${state.recentActivity.length})`, hotkey: '2' },
      {
        id: 'devtools',
        label: `${tr('tab.devtools')} (${state.recentErrors.length + state.recentFailedNetwork.length})`,
        hotkey: '3',
      },
      { id: 'workflows', label: `${tr('tab.workflows')} (${state.workflows.length})`, hotkey: '4' },
      { id: 'security', label: tr('tab.security'), hotkey: '5' },
    ];

    const tabBar = Box({
      flexDirection: 'row',
      columnGap: 2,
      children: tabDefs.map((t) =>
        Button({
          key: `tab-${t.id}`,
          label: activeTab === t.id ? `[${t.label}]` : t.label,
          hotkey: t.hotkey,
          plain: true,
          dimColor: activeTab !== t.id,
          onPress: () => {
            activeTab = t.id;
            redraw();
          },
        }),
      ),
    });

    // Tab Body
    const renderTabRow = (t: TabInfo) =>
      Box({
        key: `tab-row-${t.tabId}`,
        flexDirection: 'row',
        columnGap: 1,
        children: [
          Box({
            flexDirection: 'column',
            children: [
              Text({
                bold: t.active,
                children: [
                  `[${t.tabId}] ${truncateText(t.title || '(untitled)', 48)}${t.cdpAttached ? ' [CDP]' : ''}`,
                ],
              }),
              Text({ dimColor: true, children: [truncateText(t.url, 56)] }),
            ],
          }),
          Button({
            key: `tab-grp-${t.tabId}`,
            label: t.inAgentGroup ? tr('btn.detach') : tr('btn.attach'),
            onPress: () =>
              void executeDeckTool(
                $,
                'deck_tab_action',
                {
                  profileId: activeProfileId,
                  tabId: t.tabId,
                  action: t.inAgentGroup ? 'detach' : 'attach',
                },
                'action',
              ),
          }),
          Button({
            key: `tab-foc-${t.tabId}`,
            label: tr('btn.focus'),
            plain: true,
            onPress: () =>
              void executeDeckTool(
                $,
                'deck_tab_action',
                {
                  profileId: activeProfileId,
                  tabId: t.tabId,
                  action: 'focus',
                  bringToFront: true,
                },
                'action',
              ),
          }),
        ],
      });

    const bodyChildren: unknown[] = [];

    if (activeTab === 'overview') {
      bodyChildren.push(
        Box({
          borderStyle: 'round',
          paddingX: 1,
          flexDirection: 'column',
          gap: 1,
          children: [
            Text({ bold: true, children: [`${tr('section.agentTabs')} (${agentTabs.length})`] }),
            ...(agentTabs.length === 0
              ? [Text({ dimColor: true, children: ['No tabs attached yet. Attach any tab below.'] })]
              : agentTabs.slice(0, 12).map(renderTabRow)),
          ],
        }),
      );

      const latestShot = state.latestScreenshot;
      if (latestShot) {
        bodyChildren.push(
          Box({
            borderStyle: 'round',
            paddingX: 1,
            flexDirection: 'column',
            children: [
              Box({
                flexDirection: 'row',
                columnGap: 1,
                children: [
                  Text({
                    bold: true,
                    children: [
                      `${captureCollapsed ? '▸' : '▾'} ${tr('section.latestCapture')} · Tab ${latestShot.tabId}`,
                    ],
                  }),
                  Button({
                    key: 'capture-toggle',
                    label: captureCollapsed ? tr('btn.expand') : tr('btn.collapse'),
                    plain: true,
                    onPress: () => {
                      captureCollapsed = !captureCollapsed;
                      redraw();
                    },
                  }),
                  Button({
                    key: 'capture-clear',
                    label: tr('btn.clear'),
                    plain: true,
                    onPress: () =>
                      void executeDeckTool($, 'deck_clear_diagnostics', { target: 'screenshot' }, 'action'),
                  }),
                ],
              }),
              ...(captureCollapsed
                ? []
                : [
                    Text({ dimColor: true, children: [truncateText(latestShot.url, 64)] }),
                    Text({
                      dimColor: true,
                      children: ['Tip: Ask Claude to call browser_deck for inline HTML viewport preview.'],
                    }),
                  ]),
            ],
          }),
        );
      }

      bodyChildren.push(
        Box({
          borderStyle: 'round',
          paddingX: 1,
          flexDirection: 'column',
          gap: 1,
          children: [
            Text({ bold: true, children: [`${tr('section.allTabs')} (${otherTabs.length})`] }),
            ...(Input
              ? [
                  Input({
                    key: 'tab-filter',
                    label: 'Filter',
                    placeholder: 'Filter tabs by title, URL, or ID…',
                    value: tabQuery,
                    onInput: (val: string) => {
                      tabQuery = val;
                      redraw();
                    },
                    onSubmit: (val: string) => {
                      tabQuery = val;
                      redraw();
                    },
                  }),
                ]
              : []),
            ...otherTabs.slice(0, 20).map(renderTabRow),
            ...(otherTabs.length > 20
              ? [Text({ dimColor: true, children: [`+${otherTabs.length - 20} more tabs (use Filter)`] })]
              : []),
          ],
        }),
      );
    } else if (activeTab === 'timeline') {
      bodyChildren.push(
        Box({
          borderStyle: 'round',
          paddingX: 1,
          flexDirection: 'column',
          gap: 1,
          children: [
            Text({ bold: true, children: [`${tr('tab.timeline')} (${state.recentActivity.length})`] }),
            ...(state.recentActivity.length === 0
              ? [Text({ dimColor: true, children: ['No recent browser actions recorded.'] })]
              : state.recentActivity.slice(0, 25).map((ev) =>
                  Box({
                    key: `act-${ev.id}`,
                    flexDirection: 'row',
                    columnGap: 1,
                    children: [
                      Text({
                        color: ev.status === 'error' ? 'red' : 'green',
                        children: [ev.status === 'error' ? '✗' : '✓'],
                      }),
                      Text({ bold: true, children: [ev.tool] }),
                      Text({ dimColor: true, children: [truncateText(ev.summary, 48)] }),
                      Text({ dimColor: true, children: [`${ev.durationMs}ms`] }),
                    ],
                  }),
                )),
          ],
        }),
      );
    } else if (activeTab === 'devtools') {
      bodyChildren.push(
        Box({
          borderStyle: 'round',
          paddingX: 1,
          flexDirection: 'column',
          gap: 1,
          children: [
            Box({
              flexDirection: 'row',
              columnGap: 2,
              children: [
                Text({ bold: true, children: [`Console Errors (${state.recentErrors.length})`] }),
                Button({
                  key: 'clear-console',
                  label: tr('btn.clear'),
                  plain: true,
                  onPress: () =>
                    void executeDeckTool($, 'deck_clear_diagnostics', { target: 'console' }, 'action'),
                }),
              ],
            }),
            ...(state.recentErrors.length === 0
              ? [Text({ dimColor: true, children: ['No console errors captured.'] })]
              : state.recentErrors.slice(0, 15).map((err) =>
                  Text({
                    key: `cerr-${err.id}`,
                    color: 'red',
                    children: [`[${err.level}] ${truncateText(err.text, 72)}`],
                  }),
                )),
          ],
        }),
        Box({
          borderStyle: 'round',
          paddingX: 1,
          flexDirection: 'column',
          gap: 1,
          children: [
            Box({
              flexDirection: 'row',
              columnGap: 2,
              children: [
                Text({ bold: true, children: [`Failed Network (${state.recentFailedNetwork.length})`] }),
                Button({
                  key: 'clear-net',
                  label: tr('btn.clear'),
                  plain: true,
                  onPress: () =>
                    void executeDeckTool($, 'deck_clear_diagnostics', { target: 'network' }, 'action'),
                }),
              ],
            }),
            ...(state.recentFailedNetwork.length === 0
              ? [Text({ dimColor: true, children: ['No failed network requests.'] })]
              : state.recentFailedNetwork.slice(0, 15).map((n) =>
                  Text({
                    key: `net-${n.requestId}`,
                    color: 'yellow',
                    children: [`${n.method} ${n.status ?? 'ERR'} ${truncateText(n.url, 56)}`],
                  }),
                )),
          ],
        }),
      );
    } else if (activeTab === 'workflows') {
      bodyChildren.push(
        Box({
          borderStyle: 'round',
          paddingX: 1,
          flexDirection: 'column',
          gap: 1,
          children: [
            Text({ bold: true, children: [`${tr('tab.workflows')} (${state.workflows.length})`] }),
            ...(state.workflows.length === 0
              ? [
                  Text({
                    dimColor: true,
                    children: ['Record workflows from the Chrome Extension Side Panel.'],
                  }),
                ]
              : state.workflows.map((wf) =>
                  Box({
                    key: `wf-${wf.id}`,
                    flexDirection: 'row',
                    columnGap: 2,
                    children: [
                      Text({ bold: true, children: [`${wf.name} (${wf.steps.length} steps)`] }),
                      Text({ dimColor: true, children: [truncateText(wf.startUrl, 40)] }),
                      Button({
                        key: `wf-del-${wf.id}`,
                        label: 'Delete',
                        plain: true,
                        onPress: () =>
                          void executeDeckTool($, 'deck_delete_workflow', { workflowId: wf.id }, 'action'),
                      }),
                    ],
                  }),
                )),
          ],
        }),
      );
    } else if (activeTab === 'security') {
      const p = state.policy;
      const togglePolicy = (key: string, label: string, enabled: boolean, patch: Record<string, unknown>) =>
        Box({
          key: `pol-${key}`,
          flexDirection: 'row',
          columnGap: 2,
          children: [
            Text({ children: [label] }),
            Button({
              key: `pol-btn-${key}`,
              label: enabled ? 'ON' : 'OFF',
              onPress: () => void executeDeckTool($, 'deck_update_policy', patch, 'action'),
            }),
          ],
        });

      bodyChildren.push(
        Box({
          borderStyle: 'round',
          paddingX: 1,
          flexDirection: 'column',
          gap: 1,
          children: [
            Text({ bold: true, children: [tr('tab.security')] }),
            togglePolicy(
              'scope',
              `${tr('setting.scopeMode')}: ${p.scopeMode}`,
              p.scopeMode === 'agent-group',
              { scopeMode: p.scopeMode === 'agent-group' ? 'all-tabs' : 'agent-group' },
            ),
            togglePolicy('shield', tr('setting.shield'), p.promptInjectionShield, {
              promptInjectionShield: !p.promptInjectionShield,
            }),
            togglePolicy('cursor', tr('setting.visualCursor'), p.visualCursor, {
              visualCursor: !p.visualCursor,
            }),
            togglePolicy('eval', tr('setting.evalApproval'), p.requireApprovalForEval, {
              requireApprovalForEval: !p.requireApprovalForEval,
            }),
            togglePolicy('cdp', tr('setting.cdpProxy'), p.cdpProxyEnabled, {
              cdpProxyEnabled: !p.cdpProxyEnabled,
            }),
            Text({ bold: true, children: [tr('setting.readOnlyDomains')] }),
            Box({
              flexDirection: 'row',
              columnGap: 1,
              children: READ_ONLY_DOMAIN_PRESETS.map((domain) => {
                const active = p.readOnlyDomains.includes(domain);
                return Button({
                  key: `ro-${domain}`,
                  label: `${active ? '✓ ' : '+ '}${domain}`,
                  plain: !active,
                  onPress: () => {
                    const nextDomains = active
                      ? p.readOnlyDomains.filter((d) => d !== domain)
                      : [...p.readOnlyDomains, domain];
                    void executeDeckTool($, 'deck_update_policy', { readOnlyDomains: nextDomains }, 'action');
                  },
                });
              }),
            }),
          ],
        }),
      );
    }

    return Box({
      flexDirection: 'column',
      gap: 1,
      children: [...headerChildren, tabBar, ...bodyChildren],
    });
  });
}
