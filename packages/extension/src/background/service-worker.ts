import {
  APP_VERSION,
  BrokerToExtensionMessageSchema,
  ExtensionActParamsSchema,
  isUrlBlocked,
  SecurityPolicySchema,
  type ActivityEvent,
  type ApprovalRequest,
  type BatchActResult,
  type ExtensionRpcMethod,
  type ExtensionToBrokerMessage,
  type PageSnapshot,
  type RecordedStep,
  type RecordedWorkflow,
  type StepOutcome,
  type TabInfo,
  type WebMcpToolInfo,
} from '@chrome-browser-mcp/protocol';
import {
  loadRuntimeState,
  loadSettings,
  loadWorkflows,
  saveRuntimeState,
  saveSettings,
  saveWorkflows,
} from '../shared/storage.js';
import { CdpManager } from './cdp-manager.js';

const EXTENSION_VERSION = APP_VERSION;
const ALARM_WATCHDOG = 'chrome-browser-mcp-watchdog';
const CONTEXT_MENU_TOGGLE_TAB = 'chrome-browser-mcp-toggle-tab';
const AGENT_GROUP_TITLE = 'AI Agent';

let socket: WebSocket | null = null;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
let tabSyncTimer: ReturnType<typeof setTimeout> | null = null;
let activeRecordingSteps: RecordedStep[] = [];
let activeRecordingStartUrl = '';

const cdp = new CdpManager({
  onConsole: (entry) => {
    sendToBroker({ type: 'event.console', entry });
  },
  onNetwork: (entry) => {
    sendToBroker({ type: 'event.network', entry });
  },
  onDetachChange: () => {
    void pushTabsSnapshotToBroker();
    void notifySidePanel();
  },
});

cdp.initListeners();

// ---------------------------------------------------------------------------
// Initialization, Side Panel Trigger, Context Menus, Commands, Alarms
// ---------------------------------------------------------------------------

async function initializeExtension(): Promise<void> {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {
    // Fallback handled by chrome.action.onClicked
  }

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_TOGGLE_TAB,
      title: 'Toggle tab in AI Agent group',
      contexts: ['page'],
    });
  });

  await chrome.alarms.create(ALARM_WATCHDOG, { periodInMinutes: 0.5 });
  await connectBroker();
}

chrome.runtime.onInstalled.addListener(() => {
  void initializeExtension();
});

chrome.runtime.onStartup.addListener(() => {
  void initializeExtension();
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.windowId !== undefined) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_TOGGLE_TAB || !tab?.id) return;
  const groupIds = await getAgentGroupIds();
  const inGroup =
    tab.groupId !== undefined &&
    tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE &&
    groupIds.has(tab.groupId);
  if (inGroup) {
    await detachTabFromAgentGroup(tab.id);
    await sendToastToTab(tab.id, 'Detached from AI Agent group');
  } else {
    await attachTabToAgentGroup(tab.id);
    await sendToastToTab(tab.id, 'Attached to AI Agent group');
  }
  await updateBadge();
  await pushTabsSnapshotToBroker();
  await notifySidePanel();
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-pause') return;
  const runtime = await loadRuntimeState();
  const nextPaused = !runtime.paused;
  await saveRuntimeState({ paused: nextPaused });
  sendToBroker({ type: 'event.paused', paused: nextPaused });
  await updateBadge();
  await notifySidePanel();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_WATCHDOG) return;
  const settings = await loadSettings();
  await cdp.detachIdleTabs(settings.policy.cdpIdleDetachSec);
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    await connectBroker();
  }
});

function scheduleTabSync(): void {
  if (tabSyncTimer) clearTimeout(tabSyncTimer);
  tabSyncTimer = setTimeout(() => {
    tabSyncTimer = null;
    void pushTabsSnapshotToBroker();
    void notifySidePanel();
  }, 150);
}

chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (
    changeInfo.status === 'complete' ||
    changeInfo.title !== undefined ||
    changeInfo.url !== undefined ||
    changeInfo.groupId !== undefined
  ) {
    scheduleTabSync();
  }
});
chrome.tabs.onCreated.addListener(() => scheduleTabSync());
chrome.tabs.onRemoved.addListener(() => scheduleTabSync());
chrome.tabs.onActivated.addListener(() => scheduleTabSync());
chrome.tabs.onAttached.addListener(() => scheduleTabSync());
chrome.tabs.onDetached.addListener(() => scheduleTabSync());
chrome.tabs.onMoved.addListener(() => scheduleTabSync());
chrome.tabGroups.onCreated.addListener(() => scheduleTabSync());
chrome.tabGroups.onUpdated.addListener(() => scheduleTabSync());
chrome.tabGroups.onRemoved.addListener(() => scheduleTabSync());

// ---------------------------------------------------------------------------
// Badge & Visual Feedback
// ---------------------------------------------------------------------------

async function updateBadge(): Promise<void> {
  const runtime = await loadRuntimeState();
  if (runtime.paused) {
    await chrome.action.setBadgeText({ text: 'HOLD' });
    await chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  } else if (runtime.pendingApprovals.length > 0) {
    await chrome.action.setBadgeText({ text: String(runtime.pendingApprovals.length) });
    await chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
  } else if (runtime.connected) {
    await chrome.action.setBadgeText({ text: 'ON' });
    await chrome.action.setBadgeBackgroundColor({ color: '#0d9488' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

async function notifySidePanel(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: 'sp.stateChanged' });
  } catch {
    // Side panel may not be open
  }
}

// ---------------------------------------------------------------------------
// WebSocket Broker Bridge (with <25s Keepalive)
// ---------------------------------------------------------------------------

function sendToBroker(msg: ExtensionToBrokerMessage): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

async function connectBroker(): Promise<void> {
  const settings = await loadSettings();
  if (!settings.token.trim()) {
    await saveRuntimeState({
      connected: false,
      lastError: 'Enter pairing token from `npx chrome-browser-mcp token`',
    });
    await updateBadge();
    await notifySidePanel();
    return;
  }

  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    const ws = new WebSocket(settings.wsUrl);
    socket = ws;

    ws.addEventListener('open', async () => {
      const latestSettings = await loadSettings();
      const runtime = await loadRuntimeState();
      const tabs = await listScopedTabs(true);

      sendToBroker({
        type: 'hello',
        token: latestSettings.token.trim(),
        profile: {
          profileId: latestSettings.profileId,
          browserName: latestSettings.browserName,
          label: latestSettings.profileLabel,
          extensionVersion: EXTENSION_VERSION,
          connectedAt: Date.now(),
          lastSeenAt: Date.now(),
          tabGroupId: runtime.agentGroupId,
          allowAllTabs: latestSettings.policy.scopeMode === 'all-tabs',
          paused: runtime.paused,
          tabCount: tabs.length,
        },
      });

      if (keepaliveTimer) clearInterval(keepaliveTimer);
      keepaliveTimer = setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN) {
          sendToBroker({ type: 'ping', ts: Date.now() });
        }
      }, 20_000);

      await saveRuntimeState({ connected: true, lastError: null });
      await updateBadge();
      await pushTabsSnapshotToBroker();
      await notifySidePanel();
    });

    ws.addEventListener('message', async (ev) => {
      try {
        const raw = typeof ev.data === 'string' ? ev.data : '';
        const parsed = BrokerToExtensionMessageSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) return;
        await handleBrokerMessage(parsed.data);
      } catch {
        // ignore malformed message
      }
    });

    ws.addEventListener('close', async (ev) => {
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      if (socket === ws) socket = null;
      const reason =
        ev.code === 4001
          ? 'Invalid pairing token — check `npx chrome-browser-mcp token`'
          : ev.reason || 'Disconnected from local broker';
      await saveRuntimeState({ connected: false, lastError: reason });
      await updateBadge();
      await notifySidePanel();
    });

    ws.addEventListener('error', async () => {
      await saveRuntimeState({
        connected: false,
        lastError: `Cannot reach broker at ${settings.wsUrl}`,
      });
      await updateBadge();
      await notifySidePanel();
    });
  } catch (err) {
    await saveRuntimeState({
      connected: false,
      lastError: err instanceof Error ? err.message : String(err),
    });
    await updateBadge();
    await notifySidePanel();
  }
}

async function handleBrokerMessage(
  msg: ReturnType<typeof BrokerToExtensionMessageSchema.parse>,
): Promise<void> {
  if (msg.type === 'pong') return;

  if (msg.type === 'broker.welcome') {
    await saveSettings({ policy: msg.policy });
    await saveRuntimeState({ paused: msg.paused, connected: true, lastError: null });
    await updateBadge();
    await notifySidePanel();
    return;
  }

  if (msg.type === 'broker.event') {
    if (msg.event === 'approvals.updated') {
      const payload = msg.payload as { approvals?: ApprovalRequest[] };
      await saveRuntimeState({ pendingApprovals: payload.approvals ?? [] });
      await updateBadge();
      await notifySidePanel();
    } else if (msg.event === 'paused.updated') {
      const payload = msg.payload as { paused?: boolean };
      await saveRuntimeState({ paused: Boolean(payload.paused) });
      await updateBadge();
      await notifySidePanel();
    } else if (msg.event === 'policy.updated') {
      const policy = SecurityPolicySchema.parse(msg.payload);
      await saveSettings({ policy });
      await pushTabsSnapshotToBroker();
      await notifySidePanel();
    } else if (msg.event === 'activity.updated') {
      const ev = msg.payload as ActivityEvent;
      const runtime = await loadRuntimeState();
      const recentActivity = [ev, ...runtime.recentActivity].slice(0, 40);
      await saveRuntimeState({ recentActivity });
      await notifySidePanel();
    }
    return;
  }

  if (msg.type === 'rpc.request') {
    try {
      const result = await dispatchRpc(msg.method, msg.params);
      sendToBroker({ type: 'rpc.response', id: msg.id, ok: true, result });
    } catch (err) {
      sendToBroker({
        type: 'rpc.response',
        id: msg.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Agent Tab Group & Content Script Injection Helpers
// ---------------------------------------------------------------------------

async function getAgentGroupIds(): Promise<Set<number>> {
  const ids = new Set<number>();
  try {
    const namedGroups = await chrome.tabGroups.query({ title: AGENT_GROUP_TITLE });
    for (const g of namedGroups) {
      ids.add(g.id);
    }
  } catch {
    // ignore if tabGroups query fails
  }

  const runtime = await loadRuntimeState();
  if (runtime.agentGroupId !== null) {
    try {
      const g = await chrome.tabGroups.get(runtime.agentGroupId);
      // Keep tracking stored group unless renamed away from AI Agent while another AI Agent group exists
      if (!g.title || g.title === AGENT_GROUP_TITLE || ids.size === 0) {
        ids.add(g.id);
      }
    } catch {
      // Group no longer exists
    }
  }

  const primaryId = ids.values().next().value ?? null;
  if (primaryId !== runtime.agentGroupId) {
    await saveRuntimeState({ agentGroupId: primaryId });
  }
  return ids;
}

async function getValidAgentGroupId(windowId?: number): Promise<number | null> {
  try {
    const query: chrome.tabGroups.QueryInfo = { title: AGENT_GROUP_TITLE };
    if (windowId !== undefined) query.windowId = windowId;
    const groups = await chrome.tabGroups.query(query);
    if (groups[0]) {
      await saveRuntimeState({ agentGroupId: groups[0].id });
      return groups[0].id;
    }
  } catch {
    // ignore
  }
  const allIds = await getAgentGroupIds();
  return allIds.values().next().value ?? null;
}

async function attachTabToAgentGroup(tabId: number): Promise<number> {
  const tab = await chrome.tabs.get(tabId);
  const existingGroupId = await getValidAgentGroupId(tab.windowId);
  let groupId: number;
  if (existingGroupId !== null) {
    try {
      groupId = await chrome.tabs.group({ groupId: existingGroupId, tabIds: [tabId] });
    } catch {
      groupId = await chrome.tabs.group({ tabIds: [tabId] });
    }
  } else {
    groupId = await chrome.tabs.group({ tabIds: [tabId] });
  }
  await chrome.tabGroups.update(groupId, { title: AGENT_GROUP_TITLE, color: 'cyan' });
  await saveRuntimeState({ agentGroupId: groupId });
  return groupId;
}

async function detachTabFromAgentGroup(tabId: number): Promise<void> {
  try {
    await chrome.tabs.ungroup([tabId]);
  } catch {
    // ignore
  }
  await cdp.detach(tabId);
}

async function listScopedTabs(includeUnattached = false): Promise<TabInfo[]> {
  const settings = await loadSettings();
  const groupIds = await getAgentGroupIds();
  const allTabs = await chrome.tabs.query({});
  const allowAll = settings.policy.scopeMode === 'all-tabs';

  const mapped: TabInfo[] = allTabs
    .filter((t): t is chrome.tabs.Tab & { id: number; windowId: number } => typeof t.id === 'number')
    .map((t) => ({
      tabId: t.id,
      windowId: t.windowId,
      url: (t.url ?? '').slice(0, 512),
      title: (t.title ?? '').slice(0, 180),
      active: Boolean(t.active),
      inAgentGroup: t.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE && groupIds.has(t.groupId),
      cdpAttached: cdp.isAttached(t.id),
      status: t.status === 'loading' ? 'loading' : 'complete',
    }));

  if (includeUnattached || allowAll) return mapped;
  return mapped.filter((t) => t.inAgentGroup);
}

async function pushTabsSnapshotToBroker(): Promise<void> {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const settings = await loadSettings();
  const groupId = await getValidAgentGroupId();
  const tabs = await listScopedTabs(true);
  sendToBroker({
    type: 'event.tabs',
    tabs,
    tabGroupId: groupId,
    allowAllTabs: settings.policy.scopeMode === 'all-tabs',
  });
}

async function resolveAccessibleTab(explicitTabId?: number): Promise<chrome.tabs.Tab & { id: number }> {
  const settings = await loadSettings();
  const groupIds = await getAgentGroupIds();
  const allowAll = settings.policy.scopeMode === 'all-tabs';

  let tab: chrome.tabs.Tab | undefined;
  if (explicitTabId !== undefined) {
    tab = await chrome.tabs.get(explicitTabId);
  } else {
    const scoped = await listScopedTabs(false);
    const activeScoped = scoped.find((t) => t.active) ?? scoped[0];
    if (activeScoped) {
      tab = await chrome.tabs.get(activeScoped.tabId);
    }
  }

  if (!tab?.id) {
    throw new Error(
      'No accessible tab found. Open a tab via browser_tabs(action="open", url="...") or attach a tab to the AI Agent group in Chrome Side Panel.',
    );
  }

  const isInGroup =
    tab.groupId !== undefined &&
    tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE &&
    groupIds.has(tab.groupId);
  if (!allowAll && !isInGroup) {
    throw new Error(
      `Tab ${tab.id} is outside the AI Agent tab group. Attach it in Chrome Side Panel or enable "All tabs" scope.`,
    );
  }

  const urlCheck = isUrlBlocked(
    tab.url ?? '',
    settings.policy.blockedDomains,
    settings.policy.allowedDomains,
  );
  if (urlCheck.blocked) {
    throw new Error(`Access blocked on tab ${tab.id}: ${urlCheck.reason}`);
  }

  return tab as chrome.tabs.Tab & { id: number };
}

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: 'cs.ping' });
    if (ping?.ok) return;
  } catch {
    // Not injected yet
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content-script.js'],
  });
}

async function callContentScript<T = unknown>(
  tabId: number,
  type: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  await ensureContentScript(tabId);
  const res = (await chrome.tabs.sendMessage(tabId, { type, params })) as
    | { ok: boolean; data?: T; error?: string }
    | undefined;
  if (!res?.ok) {
    throw new Error(res?.error || `Content script error on ${type}`);
  }
  return res.data as T;
}

async function sendToastToTab(tabId: number, message: string): Promise<void> {
  try {
    await callContentScript(tabId, 'cs.toast', { message });
  } catch {
    // Restricted pages like chrome:// cannot be injected
  }
}

async function waitForTabLoad(tabId: number, timeoutMs = 15_000): Promise<chrome.tabs.Tab> {
  const existing = await chrome.tabs.get(tabId);
  if (existing.status === 'complete') return existing;

  return new Promise((resolve) => {
    const timer = setTimeout(async () => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(await chrome.tabs.get(tabId));
    }, timeoutMs);

    const listener = (updatedTabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ---------------------------------------------------------------------------
// WebMCP Discovery & Invocation in Page MAIN World
// ---------------------------------------------------------------------------

async function discoverWebMcp(tabId: number): Promise<{ supported: boolean; tools: WebMcpToolInfo[] }> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async () => {
      const nav = navigator as unknown as {
        modelContext?: {
          getTools?: () => Promise<Array<{ name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean } }>>;
          tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean } }>;
        };
      };
      const mc = nav.modelContext;
      if (!mc) return { supported: false, tools: [] };
      const rawTools = typeof mc.getTools === 'function' ? await mc.getTools() : mc.tools ?? [];
      return {
        supported: true,
        tools: rawTools.map((t) => ({
          name: String(t.name),
          description: String(t.description ?? ''),
          inputSchema: t.inputSchema,
          readOnlyHint: t.annotations?.readOnlyHint,
        })),
      };
    },
  });
  return (result?.result as { supported: boolean; tools: WebMcpToolInfo[] }) ?? { supported: false, tools: [] };
}

async function invokeWebMcp(
  tabId: number,
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: unknown }> {
  const [exec] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [name, args],
    func: async (toolName: string, toolArgs: Record<string, unknown>) => {
      const nav = navigator as unknown as {
        modelContext?: {
          callTool?: (n: string, a: Record<string, unknown>) => Promise<unknown>;
          executeTool?: (n: string, a: Record<string, unknown>) => Promise<unknown>;
        };
      };
      const mc = nav.modelContext;
      if (!mc) throw new Error('WebMCP (navigator.modelContext) is not available on this page');
      if (typeof mc.callTool === 'function') {
        return { result: await mc.callTool(toolName, toolArgs) };
      }
      if (typeof mc.executeTool === 'function') {
        return { result: await mc.executeTool(toolName, toolArgs) };
      }
      throw new Error('WebMCP callTool/executeTool method not found');
    },
  });
  return (exec?.result as { result: unknown }) ?? { result: null };
}

// ---------------------------------------------------------------------------
// Main RPC Dispatcher
// ---------------------------------------------------------------------------

async function dispatchRpc(
  method: ExtensionRpcMethod,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case 'ping':
      return { pong: true, version: EXTENSION_VERSION };

    case 'tabs.list':
      return await listScopedTabs(false);

    case 'tabs.open': {
      const url = typeof params.url === 'string' ? params.url : 'about:blank';
      const active = params.active !== false;
      const tab = await chrome.tabs.create({ url, active });
      if (tab.id !== undefined) {
        await attachTabToAgentGroup(tab.id);
        await waitForTabLoad(tab.id, 12_000);
        await pushTabsSnapshotToBroker();
        const refreshed = await chrome.tabs.get(tab.id);
        return {
          tabId: tab.id,
          windowId: refreshed.windowId,
          url: refreshed.url ?? url,
          title: refreshed.title ?? '',
          active: Boolean(refreshed.active),
          inAgentGroup: true,
          cdpAttached: cdp.isAttached(tab.id),
          status: refreshed.status === 'loading' ? 'loading' : 'complete',
        } satisfies TabInfo;
      }
      throw new Error('Failed to create tab');
    }

    case 'tabs.focus': {
      const explicitId = params.tabId as number | undefined;
      const tab =
        params.userInitiated === true && explicitId !== undefined
          ? await chrome.tabs.get(explicitId)
          : await resolveAccessibleTab(explicitId);
      if (tab.id === undefined) throw new Error('Tab not found');
      await chrome.tabs.update(tab.id, { active: true });
      if (params.bringToFront === true) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      await pushTabsSnapshotToBroker();
      return { focused: true, tabId: tab.id, broughtToFront: params.bringToFront === true };
    }

    case 'tabs.close': {
      const tab = await resolveAccessibleTab(params.tabId as number | undefined);
      await cdp.detach(tab.id);
      await chrome.tabs.remove(tab.id);
      await pushTabsSnapshotToBroker();
      return { closed: true, tabId: tab.id };
    }

    case 'tabs.attach': {
      let tabId = params.tabId as number | undefined;
      if (tabId === undefined) {
        const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        tabId = active?.id;
      }
      if (tabId === undefined) throw new Error('No tabId to attach');
      const groupId = await attachTabToAgentGroup(tabId);
      await sendToastToTab(tabId, 'Attached to AI Agent group');
      await pushTabsSnapshotToBroker();
      return { attached: true, tabId, groupId };
    }

    case 'tabs.detach': {
      const tabId = params.tabId as number | undefined;
      if (tabId === undefined) throw new Error('tabId required');
      await detachTabFromAgentGroup(tabId);
      await sendToastToTab(tabId, 'Detached from AI Agent group');
      await pushTabsSnapshotToBroker();
      return { detached: true, tabId };
    }

    case 'page.navigate': {
      const tab = await resolveAccessibleTab(params.tabId as number | undefined);
      const action = String(params.action ?? 'goto');
      const timeoutMs = Number(params.timeoutMs ?? 15_000);
      const requestedUrl = action === 'goto' ? String(params.url) : undefined;
      if (action === 'goto') {
        await chrome.tabs.update(tab.id, { url: requestedUrl });
        await waitForTabLoad(tab.id, timeoutMs);
      } else if (action === 'back') {
        await chrome.tabs.goBack(tab.id);
        await waitForTabLoad(tab.id, timeoutMs);
      } else if (action === 'forward') {
        await chrome.tabs.goForward(tab.id);
        await waitForTabLoad(tab.id, timeoutMs);
      } else if (action === 'reload') {
        await chrome.tabs.reload(tab.id);
        await waitForTabLoad(tab.id, timeoutMs);
      }

      if (params.waitSelector || params.waitText) {
        await callContentScript(tab.id, 'cs.actStep', {
          step: {
            kind: 'wait',
            selector: params.waitSelector,
            text: params.waitText,
            timeoutMs,
          },
        });
      }

      const updated = await chrome.tabs.get(tab.id);
      await pushTabsSnapshotToBroker();
      const finalUrl = updated.url ?? '';
      const redirectedFrom =
        requestedUrl && finalUrl && requestedUrl.replace(/\/$/, '') !== finalUrl.replace(/\/$/, '')
          ? requestedUrl
          : undefined;
      return { tabId: tab.id, url: finalUrl, title: updated.title ?? '', redirectedFrom };
    }

    case 'page.snapshot': {
      const tab = await resolveAccessibleTab(params.tabId as number | undefined);
      const snapshot = await callContentScript<PageSnapshot>(tab.id, 'cs.snapshot', {
        tabId: tab.id,
        includeOffscreen: Boolean(params.includeOffscreen),
        maxNodes: Number(params.maxNodes ?? 220),
      });

      // Check WebMCP tool count silently so agent knows native tools exist
      try {
        const webMcp = await discoverWebMcp(tab.id);
        snapshot.webMcpToolCount = webMcp.tools.length;
      } catch {
        // ignore
      }

      // Optional CDP Accessibility escalation for deep iframes/shadow DOM
      if (params.useCdp) {
        const attached = await cdp.ensureAttached(tab.id);
        if (attached) {
          snapshot.engine = 'hybrid';
        }
      }

      return snapshot;
    }

    case 'page.read': {
      const tab = await resolveAccessibleTab(params.tabId as number | undefined);
      const data = await callContentScript<{
        markdown: string;
        totalChars: number;
        offset: number;
        returnedChars: number;
        hasMore: boolean;
        nextOffset: number | null;
        filteredHiddenCount: number;
        tabsSummary: string[];
        alternateLinks: string[];
        url: string;
        origin: string;
        title: string;
      }>(tab.id, 'cs.read', {
        selector: params.selector,
        maxChars: Number(params.maxChars ?? 30_000),
        offset: Number(params.offset ?? 0),
        scope: params.scope === 'body' ? 'body' : 'main',
      });
      return { tabId: tab.id, ...data };
    }

    case 'page.screenshot': {
      const tab = await resolveAccessibleTab(params.tabId as number | undefined);
      const setOfMark = Boolean(params.setOfMark);
      const fullPage = Boolean(params.fullPage);
      const format = (params.format as 'jpeg' | 'webp' | 'png') ?? 'webp';
      const quality = Number(params.quality ?? 75);

      if (setOfMark) {
        await callContentScript(tab.id, 'cs.setOfMark', { show: true });
      }
      try {
        const attached = await cdp.ensureAttached(tab.id);
        if (attached) {
          const shot = await cdp.captureScreenshot(tab.id, { format, quality, fullPage });
          return { tabId: tab.id, url: tab.url ?? '', ...shot };
        }
        // Fallback to captureVisibleTab if user has DevTools open
        await chrome.tabs.update(tab.id, { active: true });
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: format === 'png' ? 'png' : 'jpeg',
          quality,
        });
        const [prefix, base64] = dataUrl.split(',');
        const mimeMatch = prefix?.match(/data:(.*?);base64/);
        return {
          tabId: tab.id,
          url: tab.url ?? '',
          mimeType: mimeMatch?.[1] ?? 'image/jpeg',
          base64: base64 ?? '',
        };
      } finally {
        if (setOfMark) {
          await callContentScript(tab.id, 'cs.setOfMark', { show: false }).catch(() => {});
        }
      }
    }

    case 'page.act': {
      const parsed = ExtensionActParamsSchema.parse(params);
      const tab = await resolveAccessibleTab(parsed.tabId);
      const outcomes: StepOutcome[] = [];
      let allOk = true;

      await callContentScript(tab.id, 'cs.hud', { active: true, label: 'AI Agent active' }).catch(() => {});
      try {
        for (let i = 0; i < parsed.steps.length; i++) {
          const step = parsed.steps[i]!;
          const started = Date.now();
          try {
            const wantsCdpClick =
              step.kind === 'click' && (parsed.forceCdp || step.useCdp || step.button !== 'left' || step.clickCount > 1);
            const wantsCdpKey = step.kind === 'press' && parsed.forceCdp;

            if (wantsCdpClick) {
              const coords =
                step.x !== undefined && step.y !== undefined
                  ? { x: step.x, y: step.y }
                  : await callContentScript<{ x: number; y: number }>(tab.id, 'cs.resolveCoords', {
                      ref: step.ref,
                      selector: step.selector,
                    });
              const attached = await cdp.ensureAttached(tab.id);
              if (attached) {
                await cdp.dispatchClick(tab.id, coords.x, coords.y, step.button, step.clickCount);
                outcomes.push({
                  index: i,
                  kind: step.kind,
                  ok: true,
                  engine: 'cdp',
                  detail: `Trusted CDP click (${coords.x}, ${coords.y})`,
                  durationMs: Date.now() - started,
                });
                continue;
              }
            }

            if (wantsCdpKey) {
              const attached = await cdp.ensureAttached(tab.id);
              if (attached) {
                await cdp.dispatchKeyPress(tab.id, step.key, step.modifiers ?? []);
                outcomes.push({
                  index: i,
                  kind: step.kind,
                  ok: true,
                  engine: 'cdp',
                  detail: `Trusted CDP key ${step.key}`,
                  durationMs: Date.now() - started,
                });
                continue;
              }
            }

            const res = await callContentScript<{
              ok: boolean;
              detail?: string;
              error?: string;
              coords?: { x: number; y: number };
              needsCdpClick?: boolean;
            }>(tab.id, 'cs.actStep', { step });

            if (res.needsCdpClick && res.coords) {
              const attached = await cdp.ensureAttached(tab.id);
              if (attached) {
                await cdp.dispatchClick(tab.id, res.coords.x, res.coords.y);
                outcomes.push({
                  index: i,
                  kind: step.kind,
                  ok: true,
                  engine: 'cdp',
                  detail: `CDP click (${res.coords.x}, ${res.coords.y})`,
                  durationMs: Date.now() - started,
                });
                continue;
              }
            }

            outcomes.push({
              index: i,
              kind: step.kind,
              ok: res.ok,
              engine: 'content-script',
              detail: res.detail,
              error: res.error,
              durationMs: Date.now() - started,
            });
            if (!res.ok) {
              allOk = false;
              break;
            }
          } catch (err) {
            allOk = false;
            outcomes.push({
              index: i,
              kind: step.kind,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
              durationMs: Date.now() - started,
            });
            break;
          }
        }

        let snapshot: PageSnapshot | undefined;
        if (parsed.returnSnapshot !== 'none') {
          await new Promise((r) => setTimeout(r, 120));
          try {
            snapshot = await callContentScript<PageSnapshot>(tab.id, 'cs.snapshot', {
              tabId: tab.id,
              includeOffscreen: false,
              maxNodes: 220,
            });
          } catch {
            // Page may be mid-navigation
          }
        }

        return {
          tabId: tab.id,
          ok: allOk,
          completedSteps: outcomes.filter((o) => o.ok).length,
          totalSteps: parsed.steps.length,
          outcomes,
          snapshot,
        } satisfies BatchActResult;
      } finally {
        setTimeout(() => {
          void callContentScript(tab.id, 'cs.hud', { active: false }).catch(() => {});
        }, 700);
      }
    }

    case 'devtools.console': {
      const tab = await resolveAccessibleTab(params.tabId as number | undefined);
      if (params.attachCdp !== false) {
        await cdp.ensureAttached(tab.id);
      }
      return cdp.getConsoleEntries(tab.id, String(params.level ?? 'all'), Number(params.limit ?? 50));
    }

    case 'devtools.network': {
      const tab = await resolveAccessibleTab(params.tabId as number | undefined);
      await cdp.ensureAttached(tab.id);
      return cdp.getNetworkEntries(
        tab.id,
        Boolean(params.onlyFailed),
        typeof params.urlFilter === 'string' ? params.urlFilter : undefined,
        Number(params.limit ?? 40),
      );
    }

    case 'devtools.eval': {
      const tab = await resolveAccessibleTab(params.tabId as number | undefined);
      return await cdp.evaluate(tab.id, String(params.expression), params.awaitPromise !== false);
    }

    case 'devtools.audit': {
      const tab = await resolveAccessibleTab(params.tabId as number | undefined);
      return await callContentScript(tab.id, 'cs.audit', { tabId: tab.id });
    }

    case 'webmcp.list': {
      const tab = await resolveAccessibleTab(params.tabId as number | undefined);
      return await discoverWebMcp(tab.id);
    }

    case 'webmcp.call': {
      const tab = await resolveAccessibleTab(params.tabId as number | undefined);
      return await invokeWebMcp(
        tab.id,
        String(params.name),
        (params.arguments as Record<string, unknown>) ?? {},
      );
    }

    case 'workflows.list':
      return await loadWorkflows();

    default:
      throw new Error(`Unsupported RPC method: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// Internal Side Panel & Recorder Messaging
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'sp.getState': {
          const [settings, runtime, tabs, workflows] = await Promise.all([
            loadSettings(),
            loadRuntimeState(),
            listScopedTabs(true),
            loadWorkflows(),
          ]);
          sendResponse({
            ok: true,
            data: {
              settings,
              runtime,
              tabs,
              workflows,
              recordingSteps: activeRecordingSteps,
            },
          });
          return;
        }

        case 'sp.saveSettings': {
          const next = await saveSettings(msg.patch);
          sendToBroker({ type: 'event.policy', policy: next.policy });
          if (msg.reconnect) {
            if (socket) {
              try {
                socket.close(1000, 'Reconnecting with new settings');
              } catch {
                // ignore
              }
              socket = null;
            }
            await connectBroker();
          }
          await pushTabsSnapshotToBroker();
          sendResponse({ ok: true, data: next });
          return;
        }

        case 'sp.setPaused': {
          const paused = Boolean(msg.paused);
          await saveRuntimeState({ paused });
          sendToBroker({ type: 'event.paused', paused });
          await updateBadge();
          sendResponse({ ok: true });
          return;
        }

        case 'sp.attachCurrentTab': {
          const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (!active?.id) throw new Error('No active tab');
          await attachTabToAgentGroup(active.id);
          await sendToastToTab(active.id, 'Attached to AI Agent group');
          await pushTabsSnapshotToBroker();
          sendResponse({ ok: true });
          return;
        }

        case 'sp.toggleTab': {
          const tabId = Number(msg.tabId);
          if (msg.attach) {
            await attachTabToAgentGroup(tabId);
            await sendToastToTab(tabId, 'Attached to AI Agent group');
          } else {
            await detachTabFromAgentGroup(tabId);
            await sendToastToTab(tabId, 'Detached from AI Agent group');
          }
          await pushTabsSnapshotToBroker();
          sendResponse({ ok: true });
          return;
        }

        case 'sp.resolveApproval': {
          sendToBroker({
            type: 'event.approvalDecision',
            approvalId: String(msg.approvalId),
            decision: msg.decision === 'approved' ? 'approved' : 'rejected',
          });
          sendResponse({ ok: true });
          return;
        }

        case 'sp.startRecording': {
          const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (!active?.id) throw new Error('No active tab to record');
          activeRecordingSteps = [];
          activeRecordingStartUrl = active.url ?? '';
          await saveRuntimeState({ recordingTabId: active.id });
          await callContentScript(active.id, 'cs.setRecording', { enabled: true });
          sendResponse({ ok: true, tabId: active.id });
          return;
        }

        case 'sp.stopRecording': {
          const runtime = await loadRuntimeState();
          if (runtime.recordingTabId !== null) {
            await callContentScript(runtime.recordingTabId, 'cs.setRecording', { enabled: false }).catch(
              () => {},
            );
          }
          await saveRuntimeState({ recordingTabId: null });
          if (msg.save && activeRecordingSteps.length > 0) {
            const workflow: RecordedWorkflow = {
              id: `wf-${Date.now().toString(36)}`,
              name: String(msg.name || `Workflow ${new Date().toLocaleTimeString()}`),
              createdAt: Date.now(),
              startUrl: activeRecordingStartUrl,
              steps: activeRecordingSteps,
            };
            const list = [workflow, ...(await loadWorkflows())];
            await saveWorkflows(list);
            sendToBroker({ type: 'event.workflowSaved', workflow });
          }
          activeRecordingSteps = [];
          sendResponse({ ok: true });
          return;
        }

        case 'sp.deleteWorkflow': {
          const id = String(msg.workflowId);
          const list = (await loadWorkflows()).filter((w) => w.id !== id);
          await saveWorkflows(list);
          sendToBroker({ type: 'event.workflowDeleted', workflowId: id });
          sendResponse({ ok: true });
          return;
        }

        case 'recorder.step': {
          const step = msg.step as RecordedStep;
          activeRecordingSteps.push(step);
          await notifySidePanel();
          sendResponse({ ok: true });
          return;
        }

        default:
          sendResponse({ ok: false, error: 'Unknown side panel message' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
  return true;
});

// Boot immediately when SW wakes
void connectBroker();
