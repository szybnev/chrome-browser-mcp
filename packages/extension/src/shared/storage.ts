import {
  DEFAULT_BROKER_HOST,
  DEFAULT_BROKER_PORT,
  SecurityPolicySchema,
  type ActivityEvent,
  type ApprovalRequest,
  type RecordedWorkflow,
  type SecurityPolicy,
} from '@chrome-browser-mcp/protocol';

export interface ExtensionSettings {
  wsUrl: string;
  token: string;
  profileId: string;
  profileLabel: string;
  browserName: string;
  policy: SecurityPolicy;
}

export interface ExtensionRuntimeState {
  connected: boolean;
  lastError: string | null;
  paused: boolean;
  agentGroupId: number | null;
  pendingApprovals: ApprovalRequest[];
  recentActivity: ActivityEvent[];
  recordingTabId: number | null;
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
  const stored = await chrome.storage.local.get('settings');
  const existing = stored.settings as Partial<ExtensionSettings> | undefined;
  const defaults: ExtensionSettings = {
    wsUrl: `ws://${DEFAULT_BROKER_HOST}:${DEFAULT_BROKER_PORT}/ws`,
    token: '',
    profileId: existing?.profileId || generateProfileId(),
    profileLabel: existing?.profileLabel || 'default',
    browserName: existing?.browserName || detectBrowserName(),
    policy: SecurityPolicySchema.parse(existing?.policy ?? {}),
  };

  const merged: ExtensionSettings = {
    ...defaults,
    ...existing,
    policy: SecurityPolicySchema.parse(existing?.policy ?? defaults.policy),
  };

  if (!existing?.profileId) {
    await chrome.storage.local.set({ settings: merged });
  }
  return merged;
}

export async function saveSettings(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const current = await loadSettings();
  const next: ExtensionSettings = {
    ...current,
    ...patch,
    policy: SecurityPolicySchema.parse(patch.policy ? { ...current.policy, ...patch.policy } : current.policy),
  };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function loadRuntimeState(): Promise<ExtensionRuntimeState> {
  const stored = await chrome.storage.session.get('runtime');
  const existing = stored.runtime as Partial<ExtensionRuntimeState> | undefined;
  return {
    connected: existing?.connected ?? false,
    lastError: existing?.lastError ?? null,
    paused: existing?.paused ?? false,
    agentGroupId: existing?.agentGroupId ?? null,
    pendingApprovals: existing?.pendingApprovals ?? [],
    recentActivity: existing?.recentActivity ?? [],
    recordingTabId: existing?.recordingTabId ?? null,
  };
}

export async function saveRuntimeState(
  patch: Partial<ExtensionRuntimeState>,
): Promise<ExtensionRuntimeState> {
  const current = await loadRuntimeState();
  const next: ExtensionRuntimeState = { ...current, ...patch };
  await chrome.storage.session.set({ runtime: next });
  return next;
}

export async function loadWorkflows(): Promise<RecordedWorkflow[]> {
  const stored = await chrome.storage.local.get('workflows');
  return (stored.workflows as RecordedWorkflow[] | undefined) ?? [];
}

export async function saveWorkflows(workflows: RecordedWorkflow[]): Promise<void> {
  await chrome.storage.local.set({ workflows });
}
