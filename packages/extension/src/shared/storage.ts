import {
  type ActivityEvent,
  type ApprovalRequest,
  DEFAULT_BROKER_HOST,
  DEFAULT_BROKER_PORT,
  type LocalePreference,
  type PendingDialog,
  type RecordedWorkflow,
  resolveLocale,
  type SecurityPolicy,
  SecurityPolicySchema,
  validateWsUrl,
} from '@chrome-browser-mcp/protocol';

export interface ExtensionSettings {
  wsUrl: string;
  token: string;
  profileId: string;
  profileLabel: string;
  browserName: string;
  theme?: 'light' | 'dark' | null;
  locale: LocalePreference;
  visualHudEnabled: boolean;
  onboardingCompleted: boolean;
  sidePanelTourPending: boolean;
  nativeMessagingEnabled: boolean;
  policy: SecurityPolicy;
}

export interface ExtensionRuntimeState {
  connected: boolean;
  brokerVersion: string | null;
  lastError: string | null;
  paused: boolean;
  agentGroupId: number | null;
  pendingApprovals: ApprovalRequest[];
  pendingDialogs: Record<string, PendingDialog>;
  recentActivity: ActivityEvent[];
  recordingTabId: number | null;
}

// In-memory write-through caches invalidated on chrome.storage.onChanged
// Eliminates redundant async chrome.storage reads on every RPC call.
let cachedSettings: ExtensionSettings | null = null;
let cachedRuntime: ExtensionRuntimeState | null = null;
let cachedWorkflows: RecordedWorkflow[] | null = null;

if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') {
      if ('settings' in changes) cachedSettings = null;
      if ('workflows' in changes) cachedWorkflows = null;
    } else if (areaName === 'session') {
      if ('runtime' in changes) cachedRuntime = null;
    }
  });
}

function detectBrowserName(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (ua.includes('Edg/')) return 'Edge';
  if (ua.includes('OPR/')) return 'Opera';
  if (ua.includes('Brave')) return 'Brave';
  return 'Chrome';
}

function generateProfileId(): string {
  const browser = detectBrowserName().toLowerCase();
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${browser}-${suffix}`;
}

export async function loadSettings(): Promise<ExtensionSettings> {
  if (cachedSettings) return cachedSettings;

  const stored = await chrome.storage.local.get('settings');
  const existing = stored.settings as Partial<ExtensionSettings> | undefined;
  const defaults: ExtensionSettings = {
    wsUrl: `ws://${DEFAULT_BROKER_HOST}:${DEFAULT_BROKER_PORT}/ws`,
    token: '',
    profileId: existing?.profileId || generateProfileId(),
    profileLabel: existing?.profileLabel || 'default',
    browserName: existing?.browserName || detectBrowserName(),
    locale: resolveLocale(existing?.locale),
    visualHudEnabled: existing?.visualHudEnabled ?? true,
    onboardingCompleted: existing?.onboardingCompleted ?? false,
    sidePanelTourPending: existing?.sidePanelTourPending ?? false,
    nativeMessagingEnabled: existing?.nativeMessagingEnabled ?? false,
    policy: SecurityPolicySchema.parse(existing?.policy ?? {}),
  };

  const merged: ExtensionSettings = {
    ...defaults,
    ...existing,
    policy: SecurityPolicySchema.parse(existing?.policy ?? defaults.policy),
  };

  cachedSettings = merged;
  if (!existing?.profileId) {
    await chrome.storage.local.set({ settings: merged });
  }
  return merged;
}

export async function saveSettings(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const current = await loadSettings();
  let nextWsUrl = patch.wsUrl ?? current.wsUrl;
  if (patch.wsUrl !== undefined) {
    const check = validateWsUrl(patch.wsUrl);
    if (!check.ok || !check.normalized) {
      throw new Error('Broker WebSocket URL must use ws:// or wss:// on localhost / 127.0.0.1 / ::1');
    }
    nextWsUrl = check.normalized;
  }
  const next: ExtensionSettings = {
    ...current,
    ...patch,
    wsUrl: nextWsUrl,
    policy: SecurityPolicySchema.parse(
      patch.policy ? { ...current.policy, ...patch.policy } : current.policy,
    ),
  };
  cachedSettings = next;
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function loadRuntimeState(): Promise<ExtensionRuntimeState> {
  if (cachedRuntime) return cachedRuntime;

  const stored = await chrome.storage.session.get('runtime');
  const existing = stored.runtime as Partial<ExtensionRuntimeState> | undefined;
  cachedRuntime = {
    connected: existing?.connected ?? false,
    brokerVersion: existing?.brokerVersion ?? null,
    lastError: existing?.lastError ?? null,
    paused: existing?.paused ?? false,
    agentGroupId: existing?.agentGroupId ?? null,
    pendingApprovals: existing?.pendingApprovals ?? [],
    pendingDialogs: existing?.pendingDialogs ?? {},
    recentActivity: existing?.recentActivity ?? [],
    recordingTabId: existing?.recordingTabId ?? null,
  };
  return cachedRuntime;
}

export async function saveRuntimeState(
  patch: Partial<ExtensionRuntimeState>,
): Promise<ExtensionRuntimeState> {
  const current = await loadRuntimeState();
  const next: ExtensionRuntimeState = { ...current, ...patch };
  cachedRuntime = next;
  await chrome.storage.session.set({ runtime: next });
  return next;
}

export async function loadWorkflows(): Promise<RecordedWorkflow[]> {
  if (cachedWorkflows) return cachedWorkflows;
  const stored = await chrome.storage.local.get('workflows');
  cachedWorkflows = (stored.workflows as RecordedWorkflow[] | undefined) ?? [];
  return cachedWorkflows;
}

export async function saveWorkflows(workflows: RecordedWorkflow[]): Promise<void> {
  cachedWorkflows = workflows;
  await chrome.storage.local.set({ workflows });
}
