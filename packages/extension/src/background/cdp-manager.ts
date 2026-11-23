import {
  redactSensitiveHeaders,
  type ConsoleEntry,
  type NetworkEntry,
} from '@chrome-browser-mcp/protocol';

const CDP_VERSION = '1.3';
const MAX_LOGS_PER_TAB = 120;

interface TabCdpSession {
  state: 'attaching' | 'attached' | 'detaching';
  lastUsedAt: number;
  consoleEntries: ConsoleEntry[];
  networkEntries: Map<string, NetworkEntry>;
}

export interface CdpEventCallbacks {
  onConsole: (entry: ConsoleEntry) => void;
  onNetwork: (entry: NetworkEntry) => void;
  onDetachChange: (tabId: number, attached: boolean) => void;
}

/**
 * On-demand chrome.debugger CDP Manager with:
 * - explicit state locking against double-attach races
 * - automatic idle detachment (no permanent yellow debugging banner)
 * - graceful handling when the user opens Chrome DevTools on a tab
 * - console & network buffering with sensitive header redaction
 */
export class CdpManager {
  private sessions = new Map<number, TabCdpSession>();
  private initializedListeners = false;

  constructor(private readonly callbacks: CdpEventCallbacks) {}

  initListeners(): void {
    if (this.initializedListeners) return;
    this.initializedListeners = true;

    chrome.debugger.onEvent.addListener((source, method, params) => {
      if (typeof source.tabId !== 'number') return;
      this.handleEvent(source.tabId, method, (params ?? {}) as Record<string, unknown>);
    });

    chrome.debugger.onDetach.addListener((source) => {
      if (typeof source.tabId !== 'number') return;
      this.sessions.delete(source.tabId);
      this.callbacks.onDetachChange(source.tabId, false);
    });
  }

  isAttached(tabId: number): boolean {
    return this.sessions.get(tabId)?.state === 'attached';
  }

  getAttachedTabIds(): number[] {
    const ids: number[] = [];
    for (const [tabId, s] of this.sessions.entries()) {
      if (s.state === 'attached') ids.push(tabId);
    }
    return ids;
  }

  async ensureAttached(tabId: number): Promise<boolean> {
    const existing = this.sessions.get(tabId);
    if (existing?.state === 'attached') {
      existing.lastUsedAt = Date.now();
      return true;
    }
    if (existing?.state === 'attaching') {
      await new Promise((r) => setTimeout(r, 150));
      return this.isAttached(tabId);
    }

    const session: TabCdpSession = {
      state: 'attaching',
      lastUsedAt: Date.now(),
      consoleEntries: existing?.consoleEntries ?? [],
      networkEntries: existing?.networkEntries ?? new Map(),
    };
    this.sessions.set(tabId, session);

    try {
      await chrome.debugger.attach({ tabId }, CDP_VERSION);
      session.state = 'attached';
      session.lastUsedAt = Date.now();

      // Enable lightweight domains needed for diagnostics & input
      await Promise.allSettled([
        chrome.debugger.sendCommand({ tabId }, 'Runtime.enable'),
        chrome.debugger.sendCommand({ tabId }, 'Network.enable', { maxPostDataSize: 4096 }),
        chrome.debugger.sendCommand({ tabId }, 'Page.enable'),
      ]);

      this.callbacks.onDetachChange(tabId, true);
      return true;
    } catch {
      // Often happens if user already has DevTools open on this tab — fall back cleanly
      this.sessions.delete(tabId);
      return false;
    }
  }

  async detach(tabId: number): Promise<void> {
    const session = this.sessions.get(tabId);
    if (!session || session.state === 'detaching') return;
    session.state = 'detaching';
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // Tab may already be closed or detached
    } finally {
      this.sessions.delete(tabId);
      this.callbacks.onDetachChange(tabId, false);
    }
  }

  async detachIdleTabs(idleTimeoutSec: number): Promise<void> {
    const cutoff = Date.now() - idleTimeoutSec * 1000;
    const toDetach: number[] = [];
    for (const [tabId, session] of this.sessions.entries()) {
      if (session.state === 'attached' && session.lastUsedAt < cutoff) {
        toDetach.push(tabId);
      }
    }
    for (const tabId of toDetach) {
      await this.detach(tabId);
    }
  }

  async send<T = Record<string, unknown>>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const ok = await this.ensureAttached(tabId);
    if (!ok) {
      throw new Error(
        `Could not attach chrome.debugger to tab ${tabId} (DevTools may already be open on this tab).`,
      );
    }
    const session = this.sessions.get(tabId);
    if (session) session.lastUsedAt = Date.now();
    return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
  }

  async dispatchClick(
    tabId: number,
    x: number,
    y: number,
    button: 'left' | 'right' | 'middle' = 'left',
    clickCount = 1,
  ): Promise<void> {
    await this.send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
    });
    await this.send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      clickCount,
    });
    await this.send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      clickCount,
    });
  }

  async dispatchInsertText(tabId: number, text: string): Promise<void> {
    await this.send(tabId, 'Input.insertText', { text });
  }

  async dispatchKeyPress(tabId: number, key: string, modifiers: string[] = []): Promise<void> {
    let modMask = 0;
    if (modifiers.includes('Alt')) modMask |= 1;
    if (modifiers.includes('Control')) modMask |= 2;
    if (modifiers.includes('Meta')) modMask |= 4;
    if (modifiers.includes('Shift')) modMask |= 8;

    const specialKeys: Record<string, { code: string; keyCode: number }> = {
      Enter: { code: 'Enter', keyCode: 13 },
      Tab: { code: 'Tab', keyCode: 9 },
      Escape: { code: 'Escape', keyCode: 27 },
      Backspace: { code: 'Backspace', keyCode: 8 },
      ArrowDown: { code: 'ArrowDown', keyCode: 40 },
      ArrowUp: { code: 'ArrowUp', keyCode: 38 },
      ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
      ArrowRight: { code: 'ArrowRight', keyCode: 39 },
      Space: { code: 'Space', keyCode: 32 },
    };

    const meta = specialKeys[key];
    await this.send(tabId, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key,
      code: meta?.code ?? key,
      windowsVirtualKeyCode: meta?.keyCode ?? key.charCodeAt(0),
      modifiers: modMask,
      text: key === 'Enter' ? '\r' : undefined,
    });
    await this.send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code: meta?.code ?? key,
      windowsVirtualKeyCode: meta?.keyCode ?? key.charCodeAt(0),
      modifiers: modMask,
    });
  }

  async captureScreenshot(
    tabId: number,
    options: { format: 'jpeg' | 'webp' | 'png'; quality: number; fullPage: boolean },
  ): Promise<{ base64: string; mimeType: string }> {
    const params: Record<string, unknown> = {
      format: options.format,
      fromSurface: true,
    };
    if (options.format !== 'png') {
      params.quality = options.quality;
    }
    if (options.fullPage) {
      params.captureBeyondViewport = true;
    }
    const res = await this.send<{ data: string }>(tabId, 'Page.captureScreenshot', params);
    return {
      base64: res.data,
      mimeType: `image/${options.format}`,
    };
  }

  async evaluate(
    tabId: number,
    expression: string,
    awaitPromise = true,
  ): Promise<{ value: unknown; exception?: string }> {
    const res = await this.send<{
      result?: { value?: unknown; description?: string; type?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(tabId, 'Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });

    if (res.exceptionDetails) {
      return {
        value: undefined,
        exception:
          res.exceptionDetails.exception?.description ||
          res.exceptionDetails.text ||
          'Unhandled page exception',
      };
    }

    return {
      value: res.result?.value !== undefined ? res.result.value : res.result?.description,
    };
  }

  getConsoleEntries(tabId: number, level = 'all', limit = 50): ConsoleEntry[] {
    const entries = this.sessions.get(tabId)?.consoleEntries ?? [];
    const filtered = level === 'all' ? entries : entries.filter((e) => e.level === level);
    return filtered.slice(-limit);
  }

  getNetworkEntries(
    tabId: number,
    onlyFailed = false,
    urlFilter?: string,
    limit = 40,
  ): NetworkEntry[] {
    const map = this.sessions.get(tabId)?.networkEntries;
    if (!map) return [];
    let list = [...map.values()];
    if (onlyFailed) {
      list = list.filter((n) => n.failed || (n.status !== undefined && n.status >= 400));
    }
    if (urlFilter) {
      const needle = urlFilter.toLowerCase();
      list = list.filter((n) => n.url.toLowerCase().includes(needle));
    }
    return list.slice(-limit);
  }

  private handleEvent(tabId: number, method: string, params: Record<string, unknown>): void {
    const session = this.sessions.get(tabId);
    if (!session) return;

    if (method === 'Runtime.consoleAPICalled') {
      const type = String(params.type ?? 'log');
      const level =
        type === 'error' || type === 'assert'
          ? 'error'
          : type === 'warning'
            ? 'warn'
            : type === 'info'
              ? 'info'
              : type === 'debug'
                ? 'debug'
                : 'log';
      const args = (params.args as Array<{ value?: unknown; description?: string }> | undefined) ?? [];
      const text = args
        .map((a) => (a.value !== undefined ? String(a.value) : a.description ?? ''))
        .join(' ')
        .slice(0, 1000);
      const stack = params.stackTrace as { callFrames?: Array<{ url?: string; lineNumber?: number }> } | undefined;
      const frame = stack?.callFrames?.[0];

      const entry: ConsoleEntry = {
        id: `${tabId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        tabId,
        level,
        text,
        source: frame?.url,
        line: frame?.lineNumber,
        timestamp: Date.now(),
      };
      session.consoleEntries.push(entry);
      if (session.consoleEntries.length > MAX_LOGS_PER_TAB) {
        session.consoleEntries.splice(0, session.consoleEntries.length - MAX_LOGS_PER_TAB);
      }
      this.callbacks.onConsole(entry);
      return;
    }

    if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails as
        | { text?: string; url?: string; lineNumber?: number; exception?: { description?: string } }
        | undefined;
      const entry: ConsoleEntry = {
        id: `${tabId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        tabId,
        level: 'error',
        text: (details?.exception?.description || details?.text || 'Uncaught exception').slice(0, 1000),
        source: details?.url,
        line: details?.lineNumber,
        timestamp: Date.now(),
      };
      session.consoleEntries.push(entry);
      if (session.consoleEntries.length > MAX_LOGS_PER_TAB) {
        session.consoleEntries.splice(0, session.consoleEntries.length - MAX_LOGS_PER_TAB);
      }
      this.callbacks.onConsole(entry);
      return;
    }

    if (method === 'Network.requestWillBeSent') {
      const requestId = String(params.requestId ?? '');
      const req = params.request as { url?: string; method?: string; headers?: Record<string, string> } | undefined;
      if (!requestId || !req?.url) return;
      if (req.headers) {
        redactSensitiveHeaders(req.headers);
      }
      const entry: NetworkEntry = {
        requestId,
        tabId,
        url: req.url,
        method: req.method ?? 'GET',
        resourceType: typeof params.type === 'string' ? params.type : undefined,
        failed: false,
        timestamp: Date.now(),
      };
      session.networkEntries.set(requestId, entry);
      if (session.networkEntries.size > MAX_LOGS_PER_TAB) {
        const firstKey = session.networkEntries.keys().next().value;
        if (firstKey) session.networkEntries.delete(firstKey);
      }
      return;
    }

    if (method === 'Network.responseReceived') {
      const requestId = String(params.requestId ?? '');
      const response = params.response as
        | { status?: number; statusText?: string; mimeType?: string }
        | undefined;
      const entry = session.networkEntries.get(requestId);
      if (!entry || !response) return;
      entry.status = response.status;
      entry.statusText = response.statusText;
      entry.mimeType = response.mimeType;
      entry.durationMs = Date.now() - entry.timestamp;
      entry.failed = (response.status ?? 0) >= 400;
      if (entry.failed) {
        this.callbacks.onNetwork(entry);
      }
      return;
    }

    if (method === 'Network.loadingFailed') {
      const requestId = String(params.requestId ?? '');
      const entry = session.networkEntries.get(requestId);
      if (!entry) return;
      entry.failed = true;
      entry.errorText = typeof params.errorText === 'string' ? params.errorText : 'Request failed';
      entry.durationMs = Date.now() - entry.timestamp;
      this.callbacks.onNetwork(entry);
    }
  }
}
