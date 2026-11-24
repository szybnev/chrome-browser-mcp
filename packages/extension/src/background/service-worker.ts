import {
  type ActivityEvent,
  APP_VERSION,
  type ApprovalRequest,
  type BatchActResult,
  BrokerToExtensionMessageSchema,
  type DownloadItem,
  EmulationConfigSchema,
  ExtensionActParamsSchema,
  type ExtensionRpcMethod,
  type ExtensionToBrokerMessage,
  type FrameSummary,
  isUrlBlocked,
  isUrlReadOnly,
  type PageSnapshot,
  type PendingDialog,
  type RecordedStep,
  type RecordedWorkflow,
  SecurityPolicySchema,
  type StepOutcome,
  type TabInfo,
  validateWsUrl,
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
let nativePort: chrome.runtime.Port | null = null;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
let tabSyncTimer: ReturnType<typeof setTimeout> | null = null;
let lastTabsFingerprint = '';
const injectedTabs = new Set<number>();
const sidePanelPorts = new Set<chrome.runtime.Port>();
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
  onDialog: (tabId, dialog) => {
    void handleDialogEvent(tabId, dialog);
  },
});

async function handleDialogEvent(tabId: number, dialog: PendingDialog | null): Promise<void> {
  const settings = await loadSettings();
  if (dialog && settings.policy.dialogPolicy === 'auto-dismiss') {
    await cdp.handleDialog(tabId, false).catch(() => {});
    return;
  }
  const runtime = await loadRuntimeState();
  const nextDialogs = { ...runtime.pendingDialogs };
  if (dialog) {
    nextDialogs[String(tabId)] = dialog;
  } else {
    delete nextDialogs[String(tabId)];
  }
  await saveRuntimeState({ pendingDialogs: nextDialogs });
  sendToBroker({ type: 'event.dialog', tabId, dialog });
  await notifySidePanel();
}

async function openWelcomeTourIfNeeded(): Promise<void> {
  const settings = await loadSettings();
  if (settings.onboardingCompleted) return;
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html'), active: true });
  } catch {
    // Ignore if browser window is not ready
  }
}

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

chrome.runtime.onInstalled.addListener((details) => {
  void initializeExtension();
  if (details.reason === 'install') {
    void openWelcomeTourIfNeeded();
  }
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

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' || changeInfo.url !== undefined) {
    injectedTabs.delete(tabId);
  }
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
chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
  scheduleTabSync();
});
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

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return;
  sidePanelPorts.add(port);
  port.onDisconnect.addListener(() => {
    sidePanelPorts.delete(port);
  });
});

async function notifySidePanel(): Promise<void> {
  if (sidePanelPorts.size > 0) {
    for (const port of sidePanelPorts) {
      try {
        port.postMessage({ type: 'sp.stateChanged' });
      } catch {
        sidePanelPorts.delete(port);
      }
    }
    return;
  }
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
  if (nativePort) {
    try {
      nativePort.postMessage(msg);
      return;
    } catch {
      nativePort = null;
    }
  }
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

async function tryConnectNativeHost(): Promise<boolean> {
  const settings = await loadSettings();
  if (!settings.nativeMessagingEnabled) return false;
  try {
    const hasPerm = await chrome.permissions.contains({ permissions: ['nativeMessaging'] });
    if (!hasPerm) return false;
    if (nativePort) return true;

    const port = chrome.runtime.connectNative('com.chromebrowsermcp.host');
    nativePort = port;
    port.onMessage.addListener((raw: unknown) => {
      const parsed = BrokerToExtensionMessageSchema.safeParse(raw);
      if (parsed.success) {
        void handleBrokerMessage(parsed.data);
      }
    });
    port.onDisconnect.addListener(() => {
      nativePort = null;
      void saveRuntimeState({ connected: false, lastError: 'Native Messaging Host disconnected' });
      void updateBadge();
      void notifySidePanel();
    });

    const runtime = await loadRuntimeState();
    const tabs = await listScopedTabs(true);
    port.postMessage({
      type: 'hello',
      token: settings.token.trim(),
      profile: {
        profileId: settings.profileId,
        browserName: settings.browserName,
        label: settings.profileLabel,
        extensionVersion: EXTENSION_VERSION,
        connectedAt: Date.now(),
        lastSeenAt: Date.now(),
        tabGroupId: runtime.agentGroupId,
        allowAllTabs: settings.policy.scopeMode === 'all-tabs',
        paused: runtime.paused,
        tabCount: tabs.length,
      },
    } satisfies ExtensionToBrokerMessage);
    await saveRuntimeState({ connected: true, lastError: null });
    await updateBadge();
    await pushTabsSnapshotToBroker();
    await notifySidePanel();
    return true;
  } catch {
    nativePort = null;
    return false;
  }
}

async function connectBroker(): Promise<void> {
  if (await tryConnectNativeHost()) return;

  const settings = await loadSettings();
  if (!settings.token.trim()) {
    await saveRuntimeState({
      connected: false,
      lastError:
        'Pair at http://127.0.0.1:43179/pair or run node packages/server/dist/cli.js pair in the repo',
    });
    await updateBadge();
    await notifySidePanel();
    return;
  }

  const wsCheck = validateWsUrl(settings.wsUrl);
  if (!wsCheck.ok || !wsCheck.normalized) {
    await saveRuntimeState({
      connected: false,
      lastError:
        'Invalid broker WebSocket URL: only localhost / 127.0.0.1 / ::1 ws(s):// endpoints are allowed.',
    });
    await updateBadge();
    await notifySidePanel();
    return;
  }

  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    const ws = new WebSocket(wsCheck.normalized);
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

      lastTabsFingerprint = '';
      await saveRuntimeState({ connected: true, lastError: null });
      await updateBadge();
      await pushTabsSnapshotToBroker(true);
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
          ? 'Invalid pairing token — pair at http://127.0.0.1:43179/pair or run node packages/server/dist/cli.js token in the repo'
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

function computeTabsFingerprint(tabs: TabInfo[], groupId: number | null, allowAllTabs: boolean): string {
  let fp = `${groupId ?? -1}|${allowAllTabs ? 1 : 0}|${tabs.length}`;
  for (let i = 0; i < tabs.length; i++) {
    const t = tabs[i]!;
    fp += `;${t.tabId}:${t.active ? 1 : 0}${t.inAgentGroup ? 1 : 0}${t.cdpAttached ? 1 : 0}${t.status === 'loading' ? 1 : 0}:${t.title}:${t.url}`;
  }
  return fp;
}

async function pushTabsSnapshotToBroker(force = false): Promise<void> {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const settings = await loadSettings();
  const groupId = await getValidAgentGroupId();
  const tabs = await listScopedTabs(true);
  const allowAllTabs = settings.policy.scopeMode === 'all-tabs';
  const fp = computeTabsFingerprint(tabs, groupId, allowAllTabs);
  if (!force && fp === lastTabsFingerprint) return;
  lastTabsFingerprint = fp;
  sendToBroker({
    type: 'event.tabs',
    tabs,
    tabGroupId: groupId,
    allowAllTabs,
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

async function ensureContentScript(tabId: number, allFrames = false): Promise<void> {
  if (!allFrames && injectedTabs.has(tabId)) return;
  await chrome.scripting.executeScript({
    target: allFrames ? { tabId, allFrames: true } : { tabId },
    files: ['content-script.js'],
  });
  injectedTabs.add(tabId);
}

async function callContentScript<T = unknown>(
  tabId: number,
  type: string,
  params: Record<string, unknown> = {},
  frameId = 0,
): Promise<T> {
  // Optimistic single-hop IPC when tab is already injected; fall back to lazy inject on miss
  const sendOnce = async () =>
    (await chrome.tabs.sendMessage(tabId, { type, params }, { frameId })) as
      | { ok: boolean; data?: T; error?: string }
      | undefined;

  let res: { ok: boolean; data?: T; error?: string } | undefined;
  if (frameId === 0 && injectedTabs.has(tabId)) {
    try {
      res = await sendOnce();
    } catch {
      injectedTabs.delete(tabId);
      await ensureContentScript(tabId, false);
      res = await sendOnce();
    }
  } else {
    try {
      res = await sendOnce();
      if (frameId === 0) injectedTabs.add(tabId);
    } catch {
      await ensureContentScript(tabId, frameId > 0);
      res = await sendOnce();
    }
  }

  if (!res?.ok) {
    throw new Error(res?.error || `Content script error on ${type}`);
  }
  return res.data as T;
}

function parseFrameRef(ref?: string): { frameId: number; ref?: string } {
  if (!ref) return { frameId: 0, ref };
  const match = /^f(\d+):(e\d+)$/.exec(ref);
  if (!match) return { frameId: 0, ref };
  return { frameId: Number(match[1]), ref };
}

const SAFE_CDP_READ_METHODS = new Set([
  'Runtime.enable',
  'Network.enable',
  'Page.enable',
  'DOM.getDocument',
  'DOM.querySelector',
  'DOM.querySelectorAll',
  'DOM.getBoxModel',
  'DOM.getOuterHTML',
  'DOM.describeNode',
  'Accessibility.getFullAXTree',
  'Page.captureScreenshot',
  'Page.getLayoutMetrics',
  'Page.getFrameTree',
  'CSS.getComputedStyleForNode',
  'Performance.getMetrics',
]);

const SAFE_CDP_MUTATE_METHODS = new Set([
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  'Page.navigate',
  'Page.reload',
  'Emulation.setDeviceMetricsOverride',
  'Emulation.clearDeviceMetricsOverride',
  'Emulation.setUserAgentOverride',
  'Emulation.setTimezoneOverride',
  'Emulation.setGeolocationOverride',
  'Emulation.setEmulatedMedia',
  'Network.emulateNetworkConditions',
]);

function isAllowedCdpMethod(method: string): 'read' | 'mutate' | null {
  if (SAFE_CDP_READ_METHODS.has(method)) return 'read';
  if (SAFE_CDP_MUTATE_METHODS.has(method)) return 'mutate';
  return null;
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

async function downscaleBase64Image(
  base64: string,
  mimeType: string,
  maxWidth: number,
  quality: number,
): Promise<{ base64: string; mimeType: string; width?: number; height?: number }> {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    return { base64, mimeType };
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }));
  try {
    if (bitmap.width <= maxWidth) {
      return { base64, mimeType, width: bitmap.width, height: bitmap.height };
    }
    const scale = maxWidth / bitmap.width;
    const targetW = Math.max(1, Math.round(bitmap.width * scale));
    const targetH = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(targetW, targetH);
    const ctx = canvas.getContext('2d');
    if (!ctx) return { base64, mimeType, width: bitmap.width, height: bitmap.height };
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    const blob = await canvas.convertToBlob({
      type: mimeType,
      quality: mimeType === 'image/png' ? undefined : Math.max(0.3, Math.min(0.95, quality / 100)),
    });
    const outBuf = new Uint8Array(await blob.arrayBuffer());
    let outBin = '';
    const chunk = 0x8000;
    for (let i = 0; i < outBuf.length; i += chunk) {
      outBin += String.fromCharCode(...outBuf.subarray(i, i + chunk));
    }
    return { base64: btoa(outBin), mimeType: blob.type || mimeType, width: targetW, height: targetH };
  } finally {
    bitmap.close();
  }
}

async function discoverWebMcp(tabId: number): Promise<{ supported: boolean; tools: WebMcpToolInfo[] }> {
  const timeoutMs = 300;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<{ supported: boolean; tools: WebMcpToolInfo[] }>((resolve) => {
    timer = setTimeout(() => resolve({ supported: false, tools: [] }), timeoutMs);
  });
  const execPromise = (async () => {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async () => {
        const nav = navigator as unknown as {
          modelContext?: {
            getTools?: () => Promise<
              Array<{
                name: string;
                description?: string;
                inputSchema?: Record<string, unknown>;
                annotations?: { readOnlyHint?: boolean };
              }>
            >;
            tools?: Array<{
              name: string;
              description?: string;
              inputSchema?: Record<string, unknown>;
              annotations?: { readOnlyHint?: boolean };
            }>;
          };
        };
        const mc = nav.modelContext;
        if (!mc) return { supported: false, tools: [] };
        const rawTools = typeof mc.getTools === 'function' ? await mc.getTools() : (mc.tools ?? []);
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
    return (
      (result?.result as { supported: boolean; tools: WebMcpToolInfo[] }) ?? { supported: false, tools: [] }
    );
  })();
  try {
    return await Promise.race([execPromise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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

async function dispatchRpc(method: ExtensionRpcMethod, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'ping':
      return { pong: true, version: EXTENSION_VERSION };

    case 'tabs.list':
      return await listScopedTabs(false);

    case 'tabs.open': {
      const settings = await loadSettings();
      const url = typeof params.url === 'string' ? params.url : 'about:blank';
      if (url !== 'about:blank') {
        const preCheck = isUrlBlocked(url, settings.policy.blockedDomains, settings.policy.allowedDomains);
        if (preCheck.blocked) {
          throw new Error(`Blocked by domain policy: ${preCheck.reason}`);
        }
      }
      const active = params.active !== false;
      const tab = await chrome.tabs.create({ url, active });
      if (tab.id !== undefined) {
        await attachTabToAgentGroup(tab.id);
        await waitForTabLoad(tab.id, 12_000);
        const refreshed = await chrome.tabs.get(tab.id);
        const finalUrl = refreshed.url ?? url;
        if (finalUrl && finalUrl !== 'about:blank') {
          const postCheck = isUrlBlocked(
            finalUrl,
            settings.policy.blockedDomains,
            settings.policy.allowedDomains,
          );
          if (postCheck.blocked) {
            await detachTabFromAgentGroup(tab.id);
            await pushTabsSnapshotToBroker();
            throw new Error(`Blocked by domain policy after redirect: ${postCheck.reason}`);
          }
        }
        await pushTabsSnapshotToBroker();
        return {
          tabId: tab.id,
          windowId: refreshed.windowId,
          url: finalUrl,
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
      if (params.userInitiated !== true) {
        throw new Error('Only the user can attach existing browser tabs via Side Panel or Browser Deck.');
      }
      let tabId = params.tabId as number | undefined;
      if (tabId === undefined) {
        const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        tabId = active?.id;
      }
      if (tabId === undefined) throw new Error('No tabId to attach');
      const settings = await loadSettings();
      const targetTab = await chrome.tabs.get(tabId);
      const blocked = isUrlBlocked(
        targetTab.url ?? '',
        settings.policy.blockedDomains,
        settings.policy.allowedDomains,
      );
      if (blocked.blocked) {
        throw new Error(`Cannot attach blocked tab ${tabId}: ${blocked.reason}`);
      }
      const groupId = await attachTabToAgentGroup(tabId);
      await sendToastToTab(tabId, 'Attached to AI Agent group');
      await pushTabsSnapshotToBroker();
      return { attached: true, tabId, groupId };
    }

    case 'tabs.detach': {
      const tabId = params.tabId as number | undefined;
      if (tabId === undefined) throw new Error('tabId required');
      const targetTab = await chrome.tabs.get(tabId);
      const groupIds = await getAgentGroupIds();
      const inAgentGroup =
        targetTab.groupId !== undefined &&
        targetTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE &&
        groupIds.has(targetTab.groupId);
      if (!inAgentGroup) {
        throw new Error(`Tab ${tabId} is not in the AI Agent tab group`);
      }
      await detachTabFromAgentGroup(tabId);
      await sendToastToTab(tabId, 'Detached from AI Agent group');
      await pushTabsSnapshotToBroker();
      return { detached: true, tabId };
    }

    case 'page.navigate': {
      const tab = await resolveAccessibleTab(params.tabId as number | undefined);
      const settings = await loadSettings();
      const action = String(params.action ?? 'goto');
      const timeoutMs = Number(params.timeoutMs ?? 15_000);
      const requestedUrl = action === 'goto' ? String(params.url) : undefined;
      if (action === 'goto' && requestedUrl) {
        const preCheck = isUrlBlocked(
          requestedUrl,
          settings.policy.blockedDomains,
          settings.policy.allowedDomains,
        );
        if (preCheck.blocked) {
          throw new Error(`Blocked by domain policy: ${preCheck.reason}`);
        }
        await chrome.tabs.update(tab.id, { url: requestedUrl });
        await waitForTabLoad(tab.id, timeoutMs);
      } else if (action === 'back') {
        try {
          await chrome.tabs.goBack(tab.id);
        } catch (err) {
          const [res] = await chrome.scripting
            .executeScript({
              target: { tabId: tab.id },
              func: () => {
                if (window.history.length > 1) {
                  window.history.back();
                  return true;
                }
                return false;
              },
            })
            .catch(() => [{ result: false }]);
          if (!res?.result) throw err;
        }
        await waitForTabLoad(tab.id, timeoutMs);
      } else if (action === 'forward') {
        try {
          await chrome.tabs.goForward(tab.id);
        } catch (err) {
          const [res] = await chrome.scripting
            .executeScript({
              target: { tabId: tab.id },
              func: () => {
                if (window.history.length > 1) {
                  window.history.forward();
                  return true;
                }
                return false;
              },
            })
            .catch(() => [{ result: false }]);
          if (!res?.result) throw err;
        }
        await waitForTabLoad(tab.id, timeoutMs);
      } else if (action === 'reload') {
        await chrome.tabs.reload(tab.id);
        await waitForTabLoad(tab.id, timeoutMs);
      }

      const postNav = await chrome.tabs.get(tab.id);
      const postUrl = postNav.url ?? '';
      if (postUrl) {
        const postCheck = isUrlBlocked(
          postUrl,
          settings.policy.blockedDomains,
          settings.policy.allowedDomains,
        );
        if (postCheck.blocked) {
          await pushTabsSnapshotToBroker();
          throw new Error(`Blocked by domain policy after redirect: ${postCheck.reason}`);
        }
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
      const maxNodes = Number(params.maxNodes ?? 220);
      const includeOffscreen = Boolean(params.includeOffscreen);
      const includeIframes = params.includeIframes !== false;
      const includeClosedShadow = Boolean(params.includeClosedShadow);

      const snapshot = await callContentScript<PageSnapshot>(tab.id, 'cs.snapshot', {
        tabId: tab.id,
        includeOffscreen,
        maxNodes,
        frameId: 0,
        refPrefix: '',
      });

      const frames: FrameSummary[] = [{ frameId: 0, url: snapshot.url, title: snapshot.title }];

      // Multi-frame traversal (including cross-origin iframes, respecting domain policy)
      if (includeIframes && snapshot.nodes.length < maxNodes) {
        try {
          const settings = await loadSettings();
          const probe = await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            func: () => ({ url: location.href, title: document.title }),
          });
          const childFrames = probe.filter((r) => typeof r.frameId === 'number' && r.frameId > 0 && r.result);
          if (childFrames.length > 0) {
            await ensureContentScript(tab.id, true).catch(() => {});
            for (const f of childFrames) {
              const remaining = maxNodes - snapshot.nodes.length;
              if (remaining <= 0) break;
              const info = f.result as { url: string; title: string };
              const frameCheck = isUrlBlocked(
                info.url ?? '',
                settings.policy.blockedDomains,
                settings.policy.allowedDomains,
              );
              if (frameCheck.blocked) continue;
              frames.push({ frameId: f.frameId, url: info.url, title: info.title });
              try {
                const childSnap = await callContentScript<PageSnapshot>(
                  tab.id,
                  'cs.snapshot',
                  {
                    tabId: tab.id,
                    includeOffscreen,
                    maxNodes: Math.min(remaining, 80),
                    frameId: f.frameId,
                    refPrefix: `f${f.frameId}:`,
                  },
                  f.frameId,
                );
                snapshot.nodes.push(...childSnap.nodes);
                snapshot.filteredHiddenCount += childSnap.filteredHiddenCount;
              } catch {
                // Restricted/sandboxed subframe
              }
            }
          }
        } catch {
          // Ignore frame probe error on restricted pages
        }
      }

      if (frames.length > 1) {
        snapshot.frames = frames;
      }

      // Check WebMCP tool count silently so agent knows native tools exist
      try {
        const webMcp = await discoverWebMcp(tab.id);
        snapshot.webMcpToolCount = webMcp.tools.length;
      } catch {
        // ignore
      }

      // Optional CDP Accessibility escalation for closed Shadow DOM
      if (params.useCdp || includeClosedShadow) {
        const attached = await cdp.ensureAttached(tab.id);
        if (attached) {
          snapshot.engine = 'hybrid';
          if (includeClosedShadow && snapshot.nodes.length < maxNodes) {
            const axNodes = await cdp.getClosedShadowSnapshotNodes(
              tab.id,
              Math.min(60, maxNodes - snapshot.nodes.length),
            );
            const existingNames = new Set(snapshot.nodes.map((n) => `${n.role}:${n.name}`));
            for (const axNode of axNodes) {
              if (!existingNames.has(`${axNode.role}:${axNode.name}`)) {
                snapshot.nodes.push(axNode);
              }
            }
          }
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
        tableCount?: number;
        isPdf?: boolean;
        url: string;
        origin: string;
        title: string;
      }>(tab.id, 'cs.read', {
        selector: params.selector,
        maxChars: Number(params.maxChars ?? 30_000),
        offset: Number(params.offset ?? 0),
        scope: params.scope === 'body' ? 'body' : 'main',
        format: typeof params.format === 'string' ? params.format : 'markdown',
      });
      return { tabId: tab.id, ...data };
    }

    case 'page.screenshot': {
      const tab = await resolveAccessibleTab(params.tabId as number | undefined);
      const setOfMark = Boolean(params.setOfMark);
      const fullPage = Boolean(params.fullPage);
      const format = (params.format as 'jpeg' | 'webp' | 'png') ?? 'webp';
      const quality = Number(params.quality ?? 70);
      const maxWidth = typeof params.maxWidth === 'number' ? params.maxWidth : undefined;

      if (setOfMark) {
        await callContentScript(tab.id, 'cs.setOfMark', { show: true });
      }
      try {
        let mimeType: string;
        let base64: string;
        let width: number | undefined;
        let height: number | undefined;

        const attached = await cdp.ensureAttached(tab.id);
        if (attached) {
          const shot = await cdp.captureScreenshot(tab.id, { format, quality, fullPage });
          mimeType = shot.mimeType;
          base64 = shot.base64;
        } else {
          // Fallback to captureVisibleTab if user has DevTools open
          await chrome.tabs.update(tab.id, { active: true });
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
            format: format === 'png' ? 'png' : 'jpeg',
            quality,
          });
          const [prefix, rawB64] = dataUrl.split(',');
          const mimeMatch = prefix?.match(/data:(.*?);base64/);
          mimeType = mimeMatch?.[1] ?? 'image/jpeg';
          base64 = rawB64 ?? '';
        }

        if (maxWidth && base64) {
          const resized = await downscaleBase64Image(base64, mimeType, maxWidth, quality);
          base64 = resized.base64;
          mimeType = resized.mimeType;
          width = resized.width;
          height = resized.height;
        }

        return { tabId: tab.id, url: tab.url ?? '', mimeType, base64, width, height };
      } finally {
        if (setOfMark) {
          await callContentScript(tab.id, 'cs.setOfMark', { show: false }).catch(() => {});
        }
      }
    }

    case 'page.act': {
      const parsed = ExtensionActParamsSchema.parse(params);
      const tab = await resolveAccessibleTab(parsed.tabId);
      if (parsed.expectedOrigin) {
        let liveOrigin: string | null = null;
        if (tab.url) {
          try {
            liveOrigin = new URL(tab.url).origin;
          } catch {
            liveOrigin = null;
          }
        }
        if (!liveOrigin || liveOrigin !== parsed.expectedOrigin) {
          throw new Error(
            `Origin changed before action (expected ${parsed.expectedOrigin}, got ${liveOrigin ?? 'unknown'}) — approval invalidated`,
          );
        }
      }
      const settings = await loadSettings();
      const policyFlags = {
        requireApprovalForPasswords: settings.policy.requireApprovalForPasswords,
        requireApprovalForPayments: settings.policy.requireApprovalForPayments,
      };
      const hudEnabled = settings.visualHudEnabled;
      const outcomes: StepOutcome[] = [];
      let allOk = true;
      let pendingDialog: PendingDialog | undefined;

      await callContentScript(tab.id, 'cs.hud', {
        active: true,
        label: 'AI Agent active',
        hudEnabled,
      }).catch(() => {});

      try {
        for (let i = 0; i < parsed.steps.length; i++) {
          const step = parsed.steps[i]!;
          const started = Date.now();
          const targetRef = 'ref' in step ? step.ref : 'sourceRef' in step ? step.sourceRef : undefined;
          const { frameId } = parseFrameRef(targetRef);

          if (frameId > 0) {
            const [frameProbe] = await chrome.scripting
              .executeScript({
                target: { tabId: tab.id, frameIds: [frameId] },
                func: () => location.href,
              })
              .catch(() => [{ result: '' }]);
            const frameUrl = typeof frameProbe?.result === 'string' ? frameProbe.result : '';
            if (!frameUrl) {
              throw new Error(`Iframe ${frameId} URL could not be verified — action blocked`);
            }
            const frameBlocked = isUrlBlocked(
              frameUrl,
              settings.policy.blockedDomains,
              settings.policy.allowedDomains,
            );
            if (frameBlocked.blocked) {
              throw new Error(`Iframe action blocked by domain policy: ${frameBlocked.reason}`);
            }
            if (step.kind !== 'scroll' && step.kind !== 'wait') {
              const frameRo = isUrlReadOnly(frameUrl, settings.policy.readOnlyDomains);
              if (frameRo.readOnly) {
                throw new Error(`Iframe action blocked by read-only rule: ${frameRo.reason}`);
              }
            }
          }

          if (hudEnabled) {
            const label =
              step.kind === 'click'
                ? `Agent: Clicking ${step.ref || step.selector || 'point'}`
                : step.kind === 'fill' || step.kind === 'type'
                  ? `Agent: Typing into ${step.ref || step.selector || 'input'}`
                  : step.kind === 'upload'
                    ? `Agent: Uploading ${step.files.length} file(s)`
                    : `Agent: ${step.kind}`;
            await callContentScript(tab.id, 'cs.hud', {
              active: true,
              label,
              hudEnabled,
            }).catch(() => {});
          }

          try {
            if (step.kind === 'upload') {
              let selector = step.selector;
              if (!selector && step.ref) {
                const resolved = await callContentScript<{
                  x: number;
                  y: number;
                  selectorHint?: string;
                }>(
                  tab.id,
                  'cs.resolveCoords',
                  { ref: step.ref, selector: step.selector, hudEnabled },
                  frameId,
                );
                selector = resolved.selectorHint;
              }
              if (!selector) {
                throw new Error('Could not resolve CSS selector for file input upload');
              }
              const upRes = await cdp.setFileInputFiles(tab.id, selector, step.files);
              outcomes.push({
                index: i,
                kind: step.kind,
                ok: upRes.ok,
                engine: 'cdp',
                detail: `Uploaded ${upRes.fileCount} file(s) to ${step.ref || selector}`,
                durationMs: Date.now() - started,
              });
              continue;
            }

            const wantsCdpClick =
              frameId === 0 &&
              step.kind === 'click' &&
              (parsed.forceCdp || step.useCdp || step.button !== 'left' || step.clickCount > 1);
            const wantsCdpKey = step.kind === 'press' && parsed.forceCdp;

            if (wantsCdpClick) {
              const coords = await callContentScript<{ x: number; y: number }>(
                tab.id,
                'cs.resolveCoords',
                {
                  x: step.x,
                  y: step.y,
                  ref: step.ref,
                  selector: step.selector,
                  hudEnabled,
                  policyFlags,
                  preApproved: step.preApproved,
                },
                frameId,
              );
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
                const dialog = cdp.getPendingDialog(tab.id);
                if (dialog) {
                  pendingDialog = dialog;
                  break;
                }
                continue;
              }
            }

            if (wantsCdpKey) {
              if (step.key === 'Enter' || step.key === 'Space' || step.key === ' ') {
                await callContentScript(
                  tab.id,
                  'cs.checkPress',
                  {
                    key: step.key,
                    ref: step.ref,
                    policyFlags,
                    preApproved: step.preApproved,
                  },
                  frameId,
                );
              }
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
            }>(tab.id, 'cs.actStep', { step, hudEnabled, policyFlags }, frameId);

            if (res.needsCdpClick && res.coords && frameId === 0) {
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
                const dialog = cdp.getPendingDialog(tab.id);
                if (dialog) {
                  pendingDialog = dialog;
                  break;
                }
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
            const dialog = cdp.getPendingDialog(tab.id);
            if (dialog) {
              pendingDialog = dialog;
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
        if (parsed.returnSnapshot !== 'none' && !pendingDialog) {
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
          ...(pendingDialog ? { pendingDialog } : {}),
        } satisfies BatchActResult;
      } finally {
        setTimeout(() => {
          void callContentScript(tab.id, 'cs.hud', { active: false, hudEnabled }).catch(() => {});
        }, 700);
      }
    }

    case 'page.dialog': {
      const tab = await resolveAccessibleTab(params.tabId as number | undefined);
      const action = String(params.action ?? 'status');
      if (action === 'status') {
        await cdp.ensureAttached(tab.id);
        return { tabId: tab.id, dialog: cdp.getPendingDialog(tab.id) };
      }
      const accept = action === 'accept';
      const promptText = typeof params.promptText === 'string' ? params.promptText : undefined;
      return await cdp.handleDialog(tab.id, accept, promptText);
    }

    case 'page.emulate': {
      const tab = await resolveAccessibleTab(params.tabId as number | undefined);
      const config = EmulationConfigSchema.parse(params);
      const applied = await cdp.setEmulation(tab.id, config);
      return { tabId: tab.id, ...applied };
    }

    case 'devtools.networkBody': {
      const tab = await resolveAccessibleTab(params.tabId as number | undefined);
      const requestId = String(params.requestId ?? '');
      if (!requestId) throw new Error('requestId is required');
      const maxChars = typeof params.maxChars === 'number' ? params.maxChars : 65_536;
      return await cdp.getResponseBody(tab.id, requestId, maxChars);
    }

    case 'browser.downloads': {
      const hasPerm = await chrome.permissions.contains({ permissions: ['downloads'] });
      if (!hasPerm || !chrome.downloads) {
        return {
          permissionRequired: true,
          downloads: [] as DownloadItem[],
          hint: 'Enable optional "Downloads tracking" permission in Chrome Browser MCP Side Panel -> Security -> Advanced Settings.',
        };
      }
      const action = String(params.action ?? 'list');
      const limit = Number(params.limit ?? 15);
      if (action === 'wait') {
        const timeoutMs = Number(params.timeoutMs ?? 15_000);
        const startTs = Date.now();
        const completed = await new Promise<DownloadItem | null>((resolve) => {
          const timer = setTimeout(() => {
            chrome.downloads.onChanged.removeListener(listener);
            resolve(null);
          }, timeoutMs);
          const listener = async (delta: chrome.downloads.DownloadDelta) => {
            if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') {
              const [item] = await chrome.downloads.search({ id: delta.id });
              if (item && new Date(item.startTime).getTime() >= startTs - 10_000) {
                clearTimeout(timer);
                chrome.downloads.onChanged.removeListener(listener);
                resolve({
                  id: item.id,
                  filename: item.filename,
                  url: item.url,
                  state: item.state as DownloadItem['state'],
                  bytesReceived: item.bytesReceived,
                  totalBytes: item.totalBytes,
                  mime: item.mime,
                  startTime: item.startTime,
                });
              }
            }
          };
          chrome.downloads.onChanged.addListener(listener);
        });
        return { permissionRequired: false, completed };
      }

      const items = await chrome.downloads.search({
        orderBy: ['-startTime'],
        limit,
      });
      const downloads: DownloadItem[] = items.map((item) => ({
        id: item.id,
        filename: item.filename,
        url: item.url,
        state: item.state as DownloadItem['state'],
        bytesReceived: item.bytesReceived,
        totalBytes: item.totalBytes,
        mime: item.mime,
        startTime: item.startTime,
      }));
      return { permissionRequired: false, downloads };
    }

    case 'cdp.raw': {
      const runtime = await loadRuntimeState();
      if (runtime.paused) {
        throw new Error('Automation is paused (Alt+Shift+P)');
      }
      const tab = await resolveAccessibleTab(params.tabId as number | undefined);
      const settings = await loadSettings();
      const methodName = String(params.method ?? '');
      if (!methodName) throw new Error('CDP method is required');
      const allowedKind = isAllowedCdpMethod(methodName);
      if (!allowedKind) {
        throw new Error(`CDP method "${methodName}" is not permitted by the security allowlist`);
      }
      const cdpParams = (params.params as Record<string, unknown> | undefined) ?? undefined;
      if (methodName === 'Page.navigate' && typeof cdpParams?.url === 'string') {
        const navBlocked = isUrlBlocked(
          cdpParams.url,
          settings.policy.blockedDomains,
          settings.policy.allowedDomains,
        );
        if (navBlocked.blocked) {
          throw new Error(`CDP Page.navigate blocked by domain policy: ${navBlocked.reason}`);
        }
      }
      const ro = isUrlReadOnly(tab.url ?? '', settings.policy.readOnlyDomains);
      if (ro.readOnly && allowedKind !== 'read') {
        throw new Error(`CDP method "${methodName}" blocked by read-only rule: ${ro.reason}`);
      }
      return await cdp.sendRaw(tab.id, methodName, cdpParams);
    }

    case 'devtools.console': {
      const tab = await resolveAccessibleTab(params.tabId as number | undefined);
      let attached = cdp.isAttached(tab.id);
      if (params.attachCdp !== false) {
        attached = await cdp.ensureAttached(tab.id);
      }
      const entries = cdp.getConsoleEntries(
        tab.id,
        String(params.level ?? 'all'),
        Number(params.limit ?? 50),
      );
      if (!attached && entries.length === 0 && params.attachCdp !== false) {
        const reason =
          cdp.getLastAttachError(tab.id) ??
          'Chrome debugger could not attach (close DevTools on this tab and retry)';
        throw new Error(`CDP debugger not attached on tab ${tab.id}: ${reason}`);
      }
      return entries;
    }

    case 'devtools.network': {
      const tab = await resolveAccessibleTab(params.tabId as number | undefined);
      const attached = await cdp.ensureAttached(tab.id);
      const entries = cdp.getNetworkEntries(
        tab.id,
        Boolean(params.onlyFailed),
        typeof params.urlFilter === 'string' ? params.urlFilter : undefined,
        Number(params.limit ?? 40),
      );
      if (!attached && entries.length === 0) {
        const reason =
          cdp.getLastAttachError(tab.id) ??
          'Chrome debugger could not attach (close DevTools on this tab and retry)';
        throw new Error(`CDP debugger not attached on tab ${tab.id}: ${reason}`);
      }
      return entries;
    }

    case 'devtools.eval': {
      const tab = await resolveAccessibleTab(params.tabId as number | undefined);
      if (typeof params.expectedOrigin === 'string') {
        let liveOrigin: string | null = null;
        if (tab.url) {
          try {
            liveOrigin = new URL(tab.url).origin;
          } catch {
            liveOrigin = null;
          }
        }
        if (!liveOrigin || liveOrigin !== params.expectedOrigin) {
          throw new Error(
            `Origin changed before script evaluation: expected ${params.expectedOrigin}, got ${liveOrigin ?? 'unknown'} — approval invalidated`,
          );
        }
      }
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const extOrigin = chrome.runtime.getURL('');
      const isExtensionPage =
        sender.id === chrome.runtime.id &&
        Boolean(sender.url?.startsWith(extOrigin)) &&
        (sender.frameId === undefined || sender.frameId === 0);
      if (typeof msg?.type === 'string' && msg.type.startsWith('sp.') && !isExtensionPage) {
        sendResponse({ ok: false, error: 'Forbidden: side panel API requires extension page origin' });
        return;
      }

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
          const url = active.url ?? '';
          const isWebPage = /^https?:\/\//i.test(url);
          const isWebStore = /^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(
            url,
          );
          if (!isWebPage || isWebStore) {
            throw new Error('RESTRICTED_RECORD_URL');
          }
          await callContentScript(active.id, 'cs.setRecording', { enabled: true });
          activeRecordingSteps = [];
          activeRecordingStartUrl = url;
          await saveRuntimeState({ recordingTabId: active.id });
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
          const runtime = await loadRuntimeState();
          if (runtime.recordingTabId === null || sender.tab?.id !== runtime.recordingTabId) {
            sendResponse({ ok: false, error: 'Forbidden: recording is not active on this tab' });
            return;
          }
          const step = msg.step as RecordedStep;
          activeRecordingSteps.push(step);
          await notifySidePanel();
          sendResponse({ ok: true });
          return;
        }

        case 'cs.togglePause': {
          const runtime = await loadRuntimeState();
          const nextPaused = !runtime.paused;
          await saveRuntimeState({ paused: nextPaused });
          sendToBroker({ type: 'event.paused', paused: nextPaused });
          await updateBadge();
          await notifySidePanel();
          sendResponse({ ok: true, paused: nextPaused });
          return;
        }

        case 'sp.setVisualHud': {
          const enabled = Boolean(msg.enabled);
          const next = await saveSettings({ visualHudEnabled: enabled });
          const allTabs = await chrome.tabs.query({});
          for (const t of allTabs) {
            if (t.id !== undefined && injectedTabs.has(t.id)) {
              void callContentScript(t.id, 'cs.setHudEnabled', { enabled }).catch(() => {});
            }
          }
          await notifySidePanel();
          sendResponse({ ok: true, data: next });
          return;
        }

        case 'sp.pairWithPin': {
          const pin = String(msg.pin ?? '').trim();
          const settings = await loadSettings();
          const wsCheck = validateWsUrl(settings.wsUrl);
          if (!wsCheck.ok || !wsCheck.normalized) {
            throw new Error('Broker WebSocket URL must be a localhost / 127.0.0.1 / ::1 ws(s):// endpoint');
          }
          const baseHttp = wsCheck.normalized
            .replace(/^ws:/i, 'http:')
            .replace(/^wss:/i, 'https:')
            .replace(/\/ws\/?$/, '');
          const resp = await fetch(`${baseHttp}/pair/exchange`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pin }),
          });
          const payload = (await resp.json()) as {
            ok: boolean;
            data?: { token: string; wsUrl?: string };
            error?: string;
          };
          if (!resp.ok || !payload.ok || !payload.data?.token) {
            throw new Error(payload.error || 'Invalid or expired pairing PIN');
          }
          const next = await saveSettings({
            token: payload.data.token,
            ...(payload.data.wsUrl ? { wsUrl: payload.data.wsUrl } : {}),
            ...(typeof msg.profileLabel === 'string' && msg.profileLabel.trim()
              ? { profileLabel: msg.profileLabel.trim() }
              : {}),
          });
          if (socket) {
            try {
              socket.close(1000, 'Reconnecting after PIN pair');
            } catch {
              // ignore
            }
            socket = null;
          }
          await connectBroker();
          await notifySidePanel();
          sendResponse({ ok: true, data: next });
          return;
        }

        case 'sp.updateWorkflow': {
          const updated = msg.workflow as RecordedWorkflow;
          const list = (await loadWorkflows()).map((w) => (w.id === updated.id ? updated : w));
          await saveWorkflows(list);
          sendToBroker({ type: 'event.workflowSaved', workflow: updated });
          await notifySidePanel();
          sendResponse({ ok: true, data: updated });
          return;
        }

        case 'sp.openWelcome': {
          await chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html'), active: true });
          sendResponse({ ok: true });
          return;
        }

        case 'sp.handleDialog': {
          const tabId = Number(msg.tabId);
          const accept = Boolean(msg.accept);
          const promptText = typeof msg.promptText === 'string' ? msg.promptText : undefined;
          await cdp.handleDialog(tabId, accept, promptText);
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
