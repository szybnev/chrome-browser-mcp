import type { DeckState, UpdateCheckStatus } from '@chrome-browser-mcp/protocol';

export type DeckTab = 'overview' | 'timeline' | 'devtools' | 'workflows' | 'security';

export interface ToolStructuredPayload {
  focusTab?: DeckTab;
  state?: DeckState;
  pin?: string;
  expiresAt?: number;
  copied?: boolean;
  updateStatus?: UpdateCheckStatus;
}

/**
 * Host-agnostic transport for Browser Control Deck.
 * Implemented by:
 *  - McpAppTransport (Antigravity, Codex Desktop, Claude Desktop MCP Apps)
 *  - OpenChamberTransport (OpenChamber right-hand rail / page via serviceRequest)
 *  - OpenCodeIpcTransport (OpenCode Desktop side Panel via Electron main Ipc)
 */
export interface DeckTransport {
  isConnected: boolean;
  error: Error | null;
  callTool: (name: string, args?: Record<string, unknown>) => Promise<ToolStructuredPayload | undefined>;
  /** Subscribe to host-pushed tool results / state updates (optional). */
  subscribePush?: (cb: (payload: ToolStructuredPayload) => void) => () => void;
  /** Optional host-native clipboard copy (e.g. OpenChamber host.writeClipboard, OpenCode ctx.system.copy). */
  copyText?: (text: string) => Promise<boolean>;
  /** Optional host-native toast notification. */
  notify?: (message: string, kind?: 'info' | 'success' | 'error') => void;
  /** Optional send diagnostics message to current chat/session. */
  sendMessage?: (text: string) => Promise<void>;
  /** Optional attach workflow/context to current chat/session. */
  updateModelContext?: (text: string) => Promise<void>;
  /** Optional host rail badge counter (e.g. pending approvals + errors). */
  setBadgeCount?: (count: number | null) => void;
  /** Optional host-driven color scheme ('light' | 'dark'). */
  hostTheme?: 'light' | 'dark' | null;
  /** Optional host-driven locale tag (e.g. 'en', 'ru', 'zh-CN'). */
  hostLocale?: string | null;
  /** Optional theme root element (defaults to document.documentElement; pass Shadow DOM wrapper when embedded). */
  themeRoot?: HTMLElement | null;
  /** True when embedded inside a container smaller than 100vh (e.g. OpenCode side panel). */
  embedded?: boolean;
}
