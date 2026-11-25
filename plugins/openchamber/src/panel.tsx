import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BrowserDeckView,
  type DeckTransport,
  type ToolStructuredPayload,
} from '../../../packages/mcp-app/src/embed.js';

const CHANNEL = 'openchamber.sdk';
const API_VERSION = 1;
const REQUEST_TIMEOUT_MS = 20_000;

interface OpenChamberThemeTokens {
  background?: string;
  elevated?: string;
  mutedSurface?: string;
  border?: string;
  foreground?: string;
  muted?: string;
  primaryText?: string;
  errorText?: string;
  warningText?: string;
  font?: string;
}

interface OpenChamberReadyPayload {
  theme?: { mode?: 'light' | 'dark'; tokens?: OpenChamberThemeTokens };
  locale?: string;
  surface?: string;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class OpenChamberHostBridge {
  private seq = 0;
  private pending = new Map<string, PendingCall>();
  private readyListeners = new Set<(payload: OpenChamberReadyPayload) => void>();
  private lastReady: OpenChamberReadyPayload | null = null;
  private disposed = false;

  constructor() {
    window.addEventListener('message', this.onMessage);
    this.post({ channel: CHANNEL, v: API_VERSION, type: 'hello' });
  }

  private post(message: Record<string, unknown>): void {
    if (this.disposed) return;
    window.parent.postMessage(message, '*');
  }

  private onMessage = (event: MessageEvent): void => {
    if (event.source !== window.parent) return;
    const msg = event.data as Record<string, unknown> | null;
    if (!msg || msg.channel !== CHANNEL || msg.v !== API_VERSION) return;

    if (msg.type === 'ready' && msg.payload && typeof msg.payload === 'object') {
      const ready = msg.payload as OpenChamberReadyPayload;
      this.lastReady = ready;
      for (const listener of this.readyListeners) listener(ready);
      return;
    }

    if (msg.type === 'result' && typeof msg.id === 'string') {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.ok === true) {
        entry.resolve(msg.payload);
      } else {
        entry.reject(new Error(typeof msg.error === 'string' ? msg.error : 'OpenChamber host error'));
      }
    }
  };

  onReady(listener: (payload: OpenChamberReadyPayload) => void): () => void {
    this.readyListeners.add(listener);
    if (this.lastReady) listener(this.lastReady);
    return () => {
      this.readyListeners.delete(listener);
    };
  }

  private call<T = unknown>(type: string, payload?: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('OpenChamber bridge disposed'));
        return;
      }
      const id = `cbmcp_${++this.seq}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`OpenChamber ${type} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.post(
        payload !== undefined
          ? { channel: CHANNEL, v: API_VERSION, type, id, payload }
          : { channel: CHANNEL, v: API_VERSION, type, id },
      );
    });
  }

  serviceRequest(req: {
    method: 'GET' | 'POST';
    path: string;
    body?: string;
  }): Promise<{ status: number; body: string }> {
    return this.call<{ status: number; body: string }>('service-request', req);
  }

  toast(kind: 'info' | 'success' | 'error', message: string): void {
    void this.call('toast', { kind, message }).catch(() => {});
  }

  async writeClipboard(text: string): Promise<boolean> {
    try {
      await this.call('clipboard-write', { text });
      return true;
    } catch {
      return false;
    }
  }

  setBadge(count: number | null): void {
    void this.call('badge', { count }).catch(() => {});
  }

  async compose(text: string): Promise<void> {
    await this.call('compose', { text, mode: 'append' });
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener('message', this.onMessage);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('OpenChamber bridge disposed'));
    }
    this.pending.clear();
  }
}

function applyOpenChamberTheme(ready: OpenChamberReadyPayload): void {
  const root = document.documentElement;
  const tokens = ready.theme?.tokens;
  if (tokens) {
    if (tokens.background) root.style.setProperty('--color-background-primary', tokens.background);
    if (tokens.elevated) root.style.setProperty('--color-background-secondary', tokens.elevated);
    if (tokens.mutedSurface) root.style.setProperty('--color-background-tertiary', tokens.mutedSurface);
    if (tokens.border) root.style.setProperty('--color-border-primary', tokens.border);
    if (tokens.foreground) root.style.setProperty('--color-text-primary', tokens.foreground);
    if (tokens.muted) root.style.setProperty('--color-text-secondary', tokens.muted);
    if (tokens.primaryText) root.style.setProperty('--color-ring-primary', tokens.primaryText);
    if (tokens.errorText) root.style.setProperty('--color-text-danger', tokens.errorText);
    if (tokens.warningText) root.style.setProperty('--color-text-warning', tokens.warningText);
    if (tokens.font) root.style.setProperty('--font-sans', tokens.font);
  }
}

function OpenChamberDeckApp() {
  const [hostReady, setHostReady] = useState<OpenChamberReadyPayload | null>(null);
  const [connError, setConnError] = useState<Error | null>(null);

  const bridge = useMemo(() => new OpenChamberHostBridge(), []);

  useEffect(() => {
    const unsub = bridge.onReady((payload) => {
      applyOpenChamberTheme(payload);
      setHostReady(payload);
      setConnError(null);
    });
    return () => {
      unsub();
      bridge.dispose();
    };
  }, [bridge]);

  const transport = useMemo<DeckTransport>(
    () => ({
      isConnected: hostReady !== null,
      error: connError,
      hostTheme: hostReady?.theme?.mode ?? null,
      hostLocale: hostReady?.locale ?? null,
      callTool: async (name, args = {}) => {
        const res = await bridge.serviceRequest({
          method: 'POST',
          path: '/deck-tool',
          body: JSON.stringify({ name, arguments: args }),
        });
        let parsed: { ok?: boolean; structuredContent?: ToolStructuredPayload; error?: string };
        try {
          parsed = JSON.parse(res.body);
        } catch {
          throw new Error(`Service returned non-JSON (${res.status})`);
        }
        if (res.status >= 400 || parsed.ok === false) {
          throw new Error(parsed.error || `Deck service error (${res.status})`);
        }
        return parsed.structuredContent;
      },
      copyText: (text) => bridge.writeClipboard(text),
      notify: (msg, kind = 'info') => bridge.toast(kind, msg),
      sendMessage: (text) => bridge.compose(text),
      updateModelContext: (text) => bridge.compose(text),
      setBadgeCount: (count) => bridge.setBadge(count),
    }),
    [bridge, hostReady, connError],
  );

  return <BrowserDeckView transport={transport} />;
}

const mountEl = document.getElementById('root');
if (mountEl) {
  createRoot(mountEl).render(
    <StrictMode>
      <OpenChamberDeckApp />
    </StrictMode>,
  );
}
