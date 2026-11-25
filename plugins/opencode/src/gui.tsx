/**
 * OpenCode Desktop GUI Plugin (`./gui-experimental`) for Chrome Browser MCP.
 *
 * Dual-process module evaluated by OpenCode Desktop:
 *  - `main(ctx)`: runs once in Electron main process; connects to / auto-spawns the
 *    shared Chrome Browser MCP Broker Daemon (127.0.0.1:43179) and exposes a typed IPC bridge.
 *  - `setup(ctx)`: runs in each Desktop window; contributes the interactive Browser Control
 *    Deck side Panel (mounting the shared React BrowserDeckView inside an isolated Shadow DOM),
 *    Command Palette entry, and a quick-toggle button in `session.panel.end`.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
// Externalized modules provided by OpenCode Desktop at runtime
// @ts-expect-error Provided by OpenCode Desktop host runtime
import { Command, Ipc, MenuItem, Panel, Plugin, Slot } from '@opencode/plugin/gui';
// @ts-expect-error Provided by OpenCode Desktop host runtime
import { Schema } from 'effect';
import { StrictMode, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
// @ts-expect-error Provided by OpenCode Desktop window runtime (inert placeholder in main)
import { onCleanup } from 'solid-js';
import {
  BrowserDeckView,
  type DeckTransport,
  type ToolStructuredPayload,
} from '../../../packages/mcp-app/src/embed.js';
// Bundled CSS text injected into ShadowRoot by scripts/build-plugins.mjs
// @ts-expect-error Loaded as raw CSS text via esbuild text loader
import DECK_STYLES_CSS from '../../../packages/mcp-app/src/styles.css';

const DEFAULT_BROKER_PORT = 43179;

const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none"><rect x="8" y="8" width="112" height="112" rx="26" stroke="currentColor" stroke-width="10"/><path d="M34 52 C34 35, 52 28, 68 34 L82 40" stroke="currentColor" stroke-width="10" stroke-linecap="round"/><path d="M94 76 C94 93, 76 100, 60 94 L46 88" stroke="currentColor" stroke-width="10" stroke-linecap="round"/><path d="M36 74 L92 54" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><circle cx="64" cy="64" r="10" fill="currentColor"/></svg>';

const DeckToolCallInput = Schema.Struct({
  name: Schema.String,
  argsJson: Schema.String,
});

const DeckToolCallOutput = Schema.Struct({
  ok: Schema.Boolean,
  payloadJson: Schema.String,
  error: Schema.optional(Schema.String),
});

export const DeckIpc = Ipc.define({
  id: 'chrome-browser-mcp.deck',
  methods: {
    callDeckTool: {
      input: DeckToolCallInput,
      output: DeckToolCallOutput,
    },
  },
});

// ---------------------------------------------------------------------------
// Main Process Helpers (run only inside main(ctx))
// ---------------------------------------------------------------------------

function resolveBrokerConfig() {
  const port = process.env.CHROME_BROWSER_MCP_PORT
    ? Number(process.env.CHROME_BROWSER_MCP_PORT)
    : DEFAULT_BROKER_PORT;
  const dataDir = process.env.CHROME_BROWSER_MCP_DATA_DIR || join(homedir(), '.chrome-browser-mcp');
  const brokerUrl = `http://127.0.0.1:${port}`;
  return { port, dataDir, brokerUrl };
}

function readBrokerToken(dataDir: string): string {
  const envToken = process.env.CHROME_BROWSER_MCP_TOKEN?.trim();
  if (envToken) return envToken;
  const tokenFile = join(dataDir, 'token.txt');
  if (existsSync(tokenFile)) {
    return readFileSync(tokenFile, 'utf8').trim();
  }
  return '';
}

function resolveServerCliPath(): string | null {
  if (process.env.CHROME_BROWSER_MCP_CLI && existsSync(process.env.CHROME_BROWSER_MCP_CLI)) {
    return process.env.CHROME_BROWSER_MCP_CLI;
  }
  try {
    if (typeof __dirname === 'string') {
      const candidates = [
        resolve(__dirname, '../../../packages/server/dist/cli.js'),
        resolve(__dirname, '../../packages/server/dist/cli.js'),
        resolve(__dirname, '../server/cli.js'),
        resolve(__dirname, '../../server/cli.js'),
      ];
      for (const c of candidates) {
        if (existsSync(c)) return c;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

async function isBrokerHealthy(brokerUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${brokerUrl}/health`, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch {
    return false;
  }
}

let brokerStartup: Promise<void> | null = null;

async function ensureBrokerRunning(): Promise<{ brokerUrl: string; token: string }> {
  const cfg = resolveBrokerConfig();
  if (await isBrokerHealthy(cfg.brokerUrl)) {
    const token = readBrokerToken(cfg.dataDir);
    if (!token) throw new Error('Broker token missing in ~/.chrome-browser-mcp/token.txt');
    return { brokerUrl: cfg.brokerUrl, token };
  }

  if (!brokerStartup) {
    brokerStartup = (async () => {
      const cliPath = resolveServerCliPath();
      if (!cliPath) {
        throw new Error(
          'Chrome Browser MCP server CLI not found (missing bundled server/cli.js or repo build). Rebuild with `pnpm build` or set CHROME_BROWSER_MCP_CLI.',
        );
      }
      const child = spawn(
        process.execPath,
        [cliPath, 'daemon', '--idle-exit', `--port=${cfg.port}`, `--data-dir=${cfg.dataDir}`],
        {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        },
      );
      child.unref();

      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (await isBrokerHealthy(cfg.brokerUrl)) return;
        await new Promise((r) => setTimeout(r, 180));
      }
      throw new Error(`Could not start local Chrome Browser MCP broker at ${cfg.brokerUrl}`);
    })().finally(() => {
      brokerStartup = null;
    });
  }

  await brokerStartup;
  const token = readBrokerToken(cfg.dataDir);
  if (!token) throw new Error('Broker token missing after startup');
  return { brokerUrl: cfg.brokerUrl, token };
}

// ---------------------------------------------------------------------------
// Window React Bridge (runs only inside setup(ctx))
// ---------------------------------------------------------------------------

interface OpenCodeWindowCtx {
  id: string;
  t(key: string): string;
  icons: Record<string, string>;
  add(registry: unknown, item: unknown): () => void;
  main(ipc: unknown): {
    callDeckTool(input: { name: string; argsJson: string }): Promise<{
      ok: boolean;
      payloadJson: string;
      error?: string;
    }>;
  };
  sessions?: { current(): unknown };
  layout?: {
    open(key: string, session: unknown, opts?: Record<string, unknown>): void;
    toggle(key: string, session: unknown): void;
  };
  system?: { copy(text: string): Promise<void> };
  toast?: { show?(opts: { title?: string; description?: string; variant?: string }): void };
  appearance?: { mode?: () => 'light' | 'dark' | string };
  locale?: { locale?: () => string; current?: () => string };
}

function OpenCodeDeckWrapper({ ctx, themeRoot }: { ctx: OpenCodeWindowCtx; themeRoot: HTMLElement }) {
  const ipc = useMemo(() => ctx.main(DeckIpc), [ctx]);

  const rawTheme = ctx.appearance?.mode?.();
  const hostTheme: 'light' | 'dark' | null = rawTheme === 'light' || rawTheme === 'dark' ? rawTheme : null;
  const hostLocale = ctx.locale?.locale?.() ?? ctx.locale?.current?.() ?? null;

  const transport = useMemo<DeckTransport>(
    () => ({
      isConnected: true,
      error: null,
      embedded: true,
      themeRoot,
      hostTheme,
      hostLocale,
      callTool: async (name, args = {}) => {
        const res = await ipc.callDeckTool({
          name,
          argsJson: JSON.stringify(args),
        });
        if (!res.ok) {
          throw new Error(res.error || 'Deck IPC tool call failed');
        }
        return JSON.parse(res.payloadJson || '{}') as ToolStructuredPayload;
      },
      copyText: ctx.system?.copy
        ? async (text: string) => {
            try {
              await ctx.system?.copy(text);
              return true;
            } catch {
              return false;
            }
          }
        : undefined,
      notify: (msg, kind = 'info') => {
        ctx.toast?.show?.({
          title: 'Browser Deck',
          description: msg,
          variant: kind === 'error' ? 'error' : kind === 'success' ? 'success' : 'default',
        });
      },
    }),
    [ipc, ctx, themeRoot, hostTheme, hostLocale],
  );

  return <BrowserDeckView transport={transport} />;
}

function createShadowDeckElement(ctx: OpenCodeWindowCtx): HTMLElement {
  const host = document.createElement('div');
  host.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden;';

  const shadow = host.attachShadow({ mode: 'open' });
  const styleEl = document.createElement('style');
  styleEl.textContent = String(DECK_STYLES_CSS ?? '');
  shadow.appendChild(styleEl);

  const themeHost = document.createElement('div');
  themeHost.className = 'deck-theme-host';
  shadow.appendChild(themeHost);

  const root = createRoot(themeHost);
  root.render(
    <StrictMode>
      <OpenCodeDeckWrapper ctx={ctx} themeRoot={themeHost} />
    </StrictMode>,
  );

  if (typeof onCleanup === 'function') {
    onCleanup(() => {
      root.unmount();
    });
  }

  return host;
}

// ---------------------------------------------------------------------------
// Plugin Definition
// ---------------------------------------------------------------------------

export default Plugin.define({
  icons: {
    deck: LOGO_SVG,
  },
  i18n: {
    en: {
      'panel.title': 'Browser Deck',
      'command.open': 'Open Browser Control Deck',
      'slot.toggle': 'Browser Deck',
    },
    ru: {
      'panel.title': 'Browser Deck',
      'command.open': 'Открыть Browser Control Deck',
      'slot.toggle': 'Browser Deck',
    },
    zh: {
      'panel.title': 'Browser Deck',
      'command.open': '打开 Browser Control Deck',
      'slot.toggle': 'Browser Deck',
    },
  },

  setup(ctx: OpenCodeWindowCtx) {
    const panelKey = `${ctx.id}:deck`;

    const deckTab = {
      id: 'deck',
      get title() {
        return ctx.t('panel.title');
      },
      closable: 'hover' as const,
      fallback: false,
    };

    const togglePanel = (sessionOverride?: unknown) => {
      const session = sessionOverride ?? ctx.sessions?.current?.();
      if (!session || !ctx.layout) return;
      ctx.layout.toggle(panelKey, session);
    };

    ctx.add(Panel, {
      id: 'deck',
      region: 'side',
      width: 440,
      mobile: {
        get title() {
          return ctx.t('panel.title');
        },
        order: 60,
        kind: 'menu',
        icon: ctx.icons.deck,
      },
      list: (input: { open: string[] }) => (input.open.includes('deck') ? [deckTab] : []),
      render: () => createShadowDeckElement(ctx),
    });

    ctx.add(Command, () => ({
      id: 'open',
      title: ctx.t('command.open'),
      featured: true as const,
      run: () => {
        const session = ctx.sessions?.current?.();
        if (session && ctx.layout) {
          ctx.layout.open(panelKey, session, { tab: 'select' });
        }
      },
    }));

    if (MenuItem) {
      ctx.add(MenuItem, () => ({
        id: 'browser-deck',
        menu: 'session.panel' as const,
        title: ctx.t('panel.title'),
        description: 'Chrome Browser MCP',
        icon: ctx.icons.deck,
        run: () => {
          const session = ctx.sessions?.current?.();
          if (session && ctx.layout) {
            ctx.layout.open(panelKey, session, { tab: 'select' });
          }
        },
      }));
    }

    ctx.add(Slot, {
      at: 'session.panel.end',
      order: 20,
      render: (input: { session: unknown }) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.title = ctx.t('command.open');
        btn.textContent = ctx.t('slot.toggle');
        btn.style.cssText =
          'display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:6px;border:1px solid var(--border-weak-base, rgba(128,128,128,0.28));background:transparent;color:inherit;font-size:12px;cursor:pointer;white-space:nowrap;';
        btn.addEventListener('click', () => togglePanel(input.session));
        return btn;
      },
    });
  },

  main(ctx: { provide: (ipc: unknown, impl: unknown) => void }) {
    ctx.provide(DeckIpc, {
      async callDeckTool(input: { name: string; argsJson: string }) {
        try {
          const { brokerUrl, token } = await ensureBrokerRunning();
          const parsedArgs = input.argsJson ? JSON.parse(input.argsJson) : {};
          const res = await fetch(`${brokerUrl}/internal/deck-tool`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-broker-token': token,
            },
            body: JSON.stringify({ name: input.name, arguments: parsedArgs }),
            signal: AbortSignal.timeout(15_000),
          });
          const raw = await res.text();
          const json = JSON.parse(raw) as {
            ok?: boolean;
            data?: Record<string, unknown>;
            error?: string;
          };
          if (!res.ok || json.ok === false) {
            if (res.status === 404) {
              let ver = 'unknown';
              try {
                const h = (await (
                  await fetch(`${brokerUrl}/health`, { signal: AbortSignal.timeout(1200) })
                ).json()) as { version?: string };
                if (h?.version) ver = h.version;
              } catch {
                // ignore
              }
              return {
                ok: false,
                payloadJson: '{}',
                error: `Incompatible local Chrome Browser MCP broker v${ver} at ${brokerUrl} (missing /internal/deck-tool; requires >=2.1.1). Restart the local broker daemon to upgrade.`,
              };
            }
            return {
              ok: false,
              payloadJson: '{}',
              error: json.error || `Broker HTTP error ${res.status}`,
            };
          }
          return {
            ok: true,
            payloadJson: JSON.stringify(json.data ?? {}),
          };
        } catch (err) {
          return {
            ok: false,
            payloadJson: '{}',
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    });
  },
});
