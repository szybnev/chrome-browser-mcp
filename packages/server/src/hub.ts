import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  type ActivityEvent,
  APP_VERSION,
  type ApprovalRequest,
  type BrokerToExtensionMessage,
  type BrowserProfileInfo,
  type ConsoleEntry,
  type DeckState,
  type ExtensionRpcMethod,
  type ExtensionToBrokerMessage,
  isUrlBlocked,
  isUrlReadOnly,
  type NetworkEntry,
  type PageSnapshot,
  type PendingDialog,
  type RecordedWorkflow,
  type RiskLevel,
  type ScreenshotRecord,
  type SecurityPolicy,
  SecurityPolicySchema,
  type TabInfo,
} from '@chrome-browser-mcp/protocol';
import type { WebSocket } from 'ws';
import { renderAuditHtml, renderAuditJson } from './audit-exporter.js';
import {
  loadPersistedPolicy,
  loadPersistedWorkflows,
  savePersistedPolicy,
  savePersistedWorkflows,
} from './config.js';
import { resolveSecretRef } from './secrets.js';

export const SERVER_VERSION = APP_VERSION;
const MAX_ACTIVITY = 300;
const MAX_CONSOLE = 150;
const MAX_NETWORK = 150;
const APPROVAL_TIMEOUT_MS = 120_000;
const DEFAULT_RPC_TIMEOUT_MS = 30_000;

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingApprovalEntry {
  request: ApprovalRequest;
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
}

interface ConnectedProfile {
  info: BrowserProfileInfo;
  ws: WebSocket;
  tabs: TabInfo[];
  pending: Map<string, PendingRpc>;
}

export interface BrowserHubInterface {
  getDeckState(): Promise<DeckState>;
  listProfiles(): Promise<{ defaultProfileId: string | null; profiles: BrowserProfileInfo[] }>;
  selectDefaultProfile(profileId: string): Promise<BrowserProfileInfo>;
  setPaused(paused: boolean): Promise<{ paused: boolean }>;
  updatePolicy(patch: Partial<SecurityPolicy>): Promise<SecurityPolicy>;
  resolveApproval(approvalId: string, decision: 'approved' | 'rejected'): Promise<ApprovalRequest | null>;
  callExtension<T = unknown>(
    method: ExtensionRpcMethod,
    params?: Record<string, unknown>,
    options?: {
      profileId?: string;
      timeoutMs?: number;
      toolLabel?: string;
      skipPauseCheck?: boolean;
    },
  ): Promise<{ profileId: string; data: T }>;
  checkUrlPolicy(url: string): { blocked: boolean; reason?: string };
  checkReadOnlyPolicy(url: string): { readOnly: boolean; reason?: string };
  requestApprovalIfNeeded(args: {
    profileId: string;
    tabId?: number;
    origin: string;
    action: string;
    reason: string;
    risk: RiskLevel;
    preview: string;
    kind: 'eval' | 'password' | 'payment' | 'upload' | 'read-only-override' | 'dialog';
  }): Promise<void>;
  resolveSecret(secretRef: string): Promise<{ value: string; maskedLabel: string }>;
  exportAudit(format: 'json' | 'html'): Promise<{ contentType: string; content: string; eventCount: number }>;
  getTabUrl(profileId: string, tabId?: number): string | undefined;
  getLiveTabUrl(profileId?: string, tabId?: number): Promise<string | undefined>;
  getLivePolicy(): Promise<SecurityPolicy>;
  createPairingPin(): Promise<{ pin: string; expiresAt: number }>;
  getPreviousSnapshot(profileId: string, tabId: number): PageSnapshot | undefined;
  rememberSnapshot(profileId: string, snapshot: PageSnapshot): void;
  recordScreenshot(record: ScreenshotRecord): void;
  getConsoleEntries(tabId?: number, level?: string, limit?: number): ConsoleEntry[];
  getNetworkEntries(tabId?: number, onlyFailed?: boolean, limit?: number): NetworkEntry[];
  clearDiagnostics(target: 'console' | 'network' | 'all'): Promise<void>;
  listWorkflows(): Promise<RecordedWorkflow[]>;
  deleteWorkflow(workflowId: string): Promise<boolean>;
  getPolicy(): SecurityPolicy;
  isPaused(): boolean;
}

export class BrowserBrokerHub implements BrowserHubInterface {
  private profiles = new Map<string, ConnectedProfile>();
  private defaultProfileId: string | null = null;
  private paused = false;
  private policy: SecurityPolicy;
  private workflows: RecordedWorkflow[];
  private activity: ActivityEvent[] = [];
  private consoleBuffer: ConsoleEntry[] = [];
  private networkBuffer: NetworkEntry[] = [];
  private snapshots = new Map<string, PageSnapshot>();
  private latestScreenshot: ScreenshotRecord | null = null;
  private pendingApprovals = new Map<string, PendingApprovalEntry>();
  private pendingDialogs = new Map<string, PendingDialog>();
  private approvedEvalOrigins = new Set<string>();
  private pinFactory: (() => { pin: string; expiresAt: number }) | null = null;

  constructor(
    private readonly dataDir: string,
    private readonly brokerUrl: string,
    private readonly token: string,
  ) {
    this.policy = loadPersistedPolicy(dataDir);
    this.workflows = loadPersistedWorkflows(dataDir);
  }

  setPinFactory(fn: () => { pin: string; expiresAt: number }): void {
    this.pinFactory = fn;
  }

  async createPairingPin(): Promise<{ pin: string; expiresAt: number }> {
    if (!this.pinFactory) {
      throw new Error('Pairing PIN generation is only available on the running broker daemon.');
    }
    return this.pinFactory();
  }

  getPolicy(): SecurityPolicy {
    return this.policy;
  }

  async getLivePolicy(): Promise<SecurityPolicy> {
    return this.policy;
  }

  async getLiveTabUrl(profileId?: string, tabId?: number): Promise<string | undefined> {
    const id = profileId || this.defaultProfileId;
    if (!id) return undefined;
    return this.getTabUrl(id, tabId);
  }

  isPaused(): boolean {
    return this.paused;
  }

  verifyToken(candidate: string): boolean {
    if (typeof candidate !== 'string' || !candidate) return false;
    const a = Buffer.from(candidate, 'utf8');
    const b = Buffer.from(this.token, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  isSocketRegistered(ws: WebSocket): boolean {
    return this.findBySocket(ws) !== undefined;
  }

  // -------------------------------------------------------------------------
  // WebSocket Extension Registration & Messaging
  // -------------------------------------------------------------------------

  registerExtension(ws: WebSocket, profile: BrowserProfileInfo): void {
    const existing = this.profiles.get(profile.profileId);
    if (existing && existing.ws !== ws) {
      for (const req of existing.pending.values()) {
        clearTimeout(req.timer);
        req.reject(new Error('Extension reconnected'));
      }
      try {
        existing.ws.close(4002, 'Replaced by new connection');
      } catch {
        // ignore
      }
    }

    const now = Date.now();
    const entry: ConnectedProfile = {
      info: {
        ...profile,
        connectedAt: profile.connectedAt || now,
        lastSeenAt: now,
      },
      ws,
      tabs: [],
      pending: new Map(),
    };
    this.profiles.set(profile.profileId, entry);

    if (!this.defaultProfileId || !this.profiles.has(this.defaultProfileId)) {
      this.defaultProfileId = profile.profileId;
    }

    this.sendToSocket(ws, {
      type: 'broker.welcome',
      brokerVersion: SERVER_VERSION,
      policy: this.policy,
      paused: this.paused,
    });

    this.pushActivity({
      profileId: profile.profileId,
      tool: 'connection',
      summary: `Connected ${profile.browserName} (${profile.label})`,
      status: 'ok',
      engine: 'broker',
    });

    // Sync pending approvals immediately
    this.broadcastApprovals();
  }

  unregisterExtension(ws: WebSocket): void {
    for (const [profileId, entry] of this.profiles.entries()) {
      if (entry.ws === ws) {
        for (const req of entry.pending.values()) {
          clearTimeout(req.timer);
          req.reject(new Error(`Browser profile "${profileId}" disconnected`));
        }
        this.profiles.delete(profileId);
        if (this.defaultProfileId === profileId) {
          this.defaultProfileId = this.profiles.keys().next().value ?? null;
        }
        this.pushActivity({
          profileId,
          tool: 'connection',
          summary: `Disconnected ${entry.info.browserName} (${entry.info.label})`,
          status: 'error',
          engine: 'broker',
        });
        break;
      }
    }
  }

  handleExtensionMessage(ws: WebSocket, msg: ExtensionToBrokerMessage): void {
    if (msg.type === 'hello') {
      if (!this.verifyToken(msg.token)) {
        ws.close(4001, 'Invalid pairing token');
        return;
      }
      this.registerExtension(ws, msg.profile);
      return;
    }

    const entry = this.findBySocket(ws);
    if (!entry) {
      ws.close(4003, 'Handshake required');
      return;
    }
    entry.info.lastSeenAt = Date.now();

    switch (msg.type) {
      case 'ping':
        this.sendToSocket(ws, { type: 'pong', ts: Date.now() });
        break;

      case 'rpc.response': {
        const pending = entry.pending.get(msg.id);
        if (!pending) return;
        entry.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.ok) {
          pending.resolve(msg.result);
        } else {
          pending.reject(new Error(msg.error || `Extension RPC failed (${msg.errorCode ?? 'UNKNOWN'})`));
        }
        break;
      }

      case 'event.tabs':
        entry.tabs = msg.tabs;
        entry.info.tabGroupId = msg.tabGroupId;
        entry.info.allowAllTabs = msg.allowAllTabs;
        entry.info.tabCount = msg.tabs.length;
        break;

      case 'event.console':
        this.consoleBuffer.push(msg.entry);
        if (this.consoleBuffer.length > MAX_CONSOLE) {
          this.consoleBuffer.splice(0, this.consoleBuffer.length - MAX_CONSOLE);
        }
        break;

      case 'event.network':
        this.networkBuffer.push(msg.entry);
        if (this.networkBuffer.length > MAX_NETWORK) {
          this.networkBuffer.splice(0, this.networkBuffer.length - MAX_NETWORK);
        }
        break;

      case 'event.approvalDecision':
        void this.resolveApproval(msg.approvalId, msg.decision);
        break;

      case 'event.paused':
        this.paused = msg.paused;
        this.broadcastEvent('paused.updated', { paused: this.paused });
        break;

      case 'event.policy':
        this.policy = SecurityPolicySchema.parse(msg.policy);
        savePersistedPolicy(this.dataDir, this.policy);
        this.broadcastEvent('policy.updated', this.policy);
        break;

      case 'event.workflowSaved': {
        const idx = this.workflows.findIndex((w) => w.id === msg.workflow.id);
        if (idx >= 0) {
          this.workflows[idx] = msg.workflow;
        } else {
          this.workflows.unshift(msg.workflow);
        }
        savePersistedWorkflows(this.dataDir, this.workflows);
        this.pushActivity({
          profileId: entry.info.profileId,
          tool: 'workflow_recorder',
          summary: `Recorded workflow "${msg.workflow.name}" (${msg.workflow.steps.length} steps)`,
          status: 'ok',
          engine: 'content-script',
        });
        break;
      }

      case 'event.workflowDeleted':
        this.workflows = this.workflows.filter((w) => w.id !== msg.workflowId);
        savePersistedWorkflows(this.dataDir, this.workflows);
        break;

      case 'event.dialog': {
        const key = `${entry.info.profileId}:${msg.tabId}`;
        if (msg.dialog) {
          this.pendingDialogs.set(key, msg.dialog);
        } else {
          this.pendingDialogs.delete(key);
        }
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Profile & RPC Operations
  // -------------------------------------------------------------------------

  private findBySocket(ws: WebSocket): ConnectedProfile | undefined {
    for (const entry of this.profiles.values()) {
      if (entry.ws === ws) return entry;
    }
    return undefined;
  }

  private resolveProfile(profileId?: string): ConnectedProfile {
    const id = profileId || this.defaultProfileId;
    if (!id) {
      throw new Error(
        `No Chrome Browser MCP extension is connected. Open Chrome, load the extension, and pair via ${this.brokerUrl}/pair.`,
      );
    }
    const found = this.profiles.get(id);
    if (!found) {
      const available = [...this.profiles.keys()].join(', ') || 'none';
      throw new Error(`Browser profile "${id}" is not connected. Connected profiles: ${available}`);
    }
    return found;
  }

  async listProfiles(): Promise<{ defaultProfileId: string | null; profiles: BrowserProfileInfo[] }> {
    return {
      defaultProfileId: this.defaultProfileId,
      profiles: [...this.profiles.values()].map((p) => ({
        ...p.info,
        paused: this.paused,
      })),
    };
  }

  async selectDefaultProfile(profileId: string): Promise<BrowserProfileInfo> {
    const found = this.resolveProfile(profileId);
    this.defaultProfileId = found.info.profileId;
    return found.info;
  }

  async setPaused(paused: boolean): Promise<{ paused: boolean }> {
    this.paused = paused;
    this.broadcastEvent('paused.updated', { paused });
    for (const entry of this.profiles.values()) {
      entry.info.paused = paused;
    }
    this.pushActivity({
      profileId: this.defaultProfileId ?? 'broker',
      tool: 'pause',
      summary: paused ? 'Automation PAUSED by user' : 'Automation RESUMED',
      status: paused ? 'blocked' : 'ok',
      engine: 'broker',
    });
    return { paused };
  }

  async updatePolicy(patch: Partial<SecurityPolicy>): Promise<SecurityPolicy> {
    this.policy = SecurityPolicySchema.parse({ ...this.policy, ...patch });
    savePersistedPolicy(this.dataDir, this.policy);
    this.broadcastEvent('policy.updated', this.policy);
    return this.policy;
  }

  checkUrlPolicy(url: string): { blocked: boolean; reason?: string } {
    return isUrlBlocked(url, this.policy.blockedDomains, this.policy.allowedDomains);
  }

  checkReadOnlyPolicy(url: string): { readOnly: boolean; reason?: string } {
    return isUrlReadOnly(url, this.policy.readOnlyDomains);
  }

  getTabUrl(profileId: string, tabId?: number): string | undefined {
    const profile = this.profiles.get(profileId);
    if (!profile) return undefined;
    if (tabId !== undefined) {
      return profile.tabs.find((t) => t.tabId === tabId)?.url;
    }
    return profile.tabs.find((t) => t.active && t.inAgentGroup)?.url ?? profile.tabs[0]?.url;
  }

  async resolveSecret(secretRef: string): Promise<{ value: string; maskedLabel: string }> {
    return await resolveSecretRef(secretRef, this.dataDir);
  }

  async exportAudit(
    format: 'json' | 'html',
  ): Promise<{ contentType: string; content: string; eventCount: number }> {
    const payload = {
      exportedAt: new Date().toISOString(),
      brokerVersion: SERVER_VERSION,
      profiles: [...this.profiles.values()].map((p) => ({ ...p.info, paused: this.paused })),
      policySummary: {
        scopeMode: this.policy.scopeMode,
        promptInjectionShield: this.policy.promptInjectionShield,
        blockedDomainsCount: this.policy.blockedDomains.length,
        readOnlyDomainsCount: this.policy.readOnlyDomains.length,
        cdpProxyEnabled: this.policy.cdpProxyEnabled,
      },
      events: [...this.activity].reverse(),
    };
    if (format === 'html') {
      return {
        contentType: 'text/html; charset=utf-8',
        content: renderAuditHtml(payload),
        eventCount: payload.events.length,
      };
    }
    return {
      contentType: 'application/json; charset=utf-8',
      content: renderAuditJson(payload),
      eventCount: payload.events.length,
    };
  }

  async requestApprovalIfNeeded(args: {
    profileId: string;
    tabId?: number;
    origin: string;
    action: string;
    reason: string;
    risk: RiskLevel;
    preview: string;
    kind: 'eval' | 'password' | 'payment' | 'upload' | 'read-only-override' | 'dialog';
  }): Promise<void> {
    const isConcreteHttpOrigin = /^https?:\/\/[^/\s]+$/i.test(args.origin);
    const needsApproval =
      (args.kind === 'eval' &&
        this.policy.requireApprovalForEval &&
        (!isConcreteHttpOrigin || !this.approvedEvalOrigins.has(args.origin))) ||
      (args.kind === 'password' && this.policy.requireApprovalForPasswords) ||
      (args.kind === 'payment' && this.policy.requireApprovalForPayments) ||
      (args.kind === 'upload' && this.policy.requireApprovalForUploads) ||
      (args.kind === 'dialog' && this.policy.dialogPolicy === 'approval') ||
      args.kind === 'read-only-override';

    if (!needsApproval) return;

    const id = randomUUID().slice(0, 8);
    const request: ApprovalRequest = {
      id,
      profileId: args.profileId,
      tabId: args.tabId,
      origin: args.origin,
      action: args.action,
      reason: args.reason,
      risk: args.risk,
      preview: args.preview.slice(0, 300),
      createdAt: Date.now(),
      status: 'pending',
    };

    const approved = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const entry = this.pendingApprovals.get(id);
        if (entry) {
          entry.request.status = 'expired';
          this.pendingApprovals.delete(id);
          this.broadcastApprovals();
        }
        resolve(false);
      }, APPROVAL_TIMEOUT_MS);

      this.pendingApprovals.set(id, { request, resolve, timer });
      this.broadcastApprovals();
    });

    if (!approved) {
      this.pushActivity({
        profileId: args.profileId,
        tabId: args.tabId,
        tool: args.action,
        summary: `Blocked/rejected: ${args.reason}`,
        status: 'blocked',
        engine: 'broker',
      });
      throw new Error(
        `Action "${args.action}" was rejected or timed out waiting for user approval (${args.reason}). Approve in Chrome Side Panel or Antigravity Browser Deck.`,
      );
    }

    // Never cache 'active-tab', 'null', or non-http(s) opaque origins
    if (args.kind === 'eval' && isConcreteHttpOrigin) {
      this.approvedEvalOrigins.add(args.origin);
    }
  }

  async resolveApproval(
    approvalId: string,
    decision: 'approved' | 'rejected',
  ): Promise<ApprovalRequest | null> {
    const entry = this.pendingApprovals.get(approvalId);
    if (!entry) return null;
    clearTimeout(entry.timer);
    entry.request.status = decision;
    this.pendingApprovals.delete(approvalId);
    entry.resolve(decision === 'approved');
    this.broadcastApprovals();
    return entry.request;
  }

  async callExtension<T = unknown>(
    method: ExtensionRpcMethod,
    params: Record<string, unknown> = {},
    options?: {
      profileId?: string;
      timeoutMs?: number;
      toolLabel?: string;
      skipPauseCheck?: boolean;
    },
  ): Promise<{ profileId: string; data: T }> {
    if (this.paused && !options?.skipPauseCheck) {
      throw new Error(
        'Browser automation is currently PAUSED by the user. Resume in Chrome Side Panel or Antigravity Browser Deck to continue.',
      );
    }

    const profile = this.resolveProfile(options?.profileId);
    const id = randomUUID();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    const startedAt = Date.now();
    const tabId = typeof params.tabId === 'number' ? params.tabId : undefined;

    // Resolve Zero-Secret Autofill references strictly inside BrowserBrokerHub (never over HTTP)
    // and remember resolved values solely to scrub them from any returned snapshot/error!
    const resolvedSecrets: string[] = [];
    let effectiveParams = params;
    if (method === 'page.act' && Array.isArray(params.steps)) {
      const stepsCopy: Array<Record<string, unknown>> = [];
      for (const rawStep of params.steps) {
        if (rawStep && typeof rawStep === 'object') {
          const step = { ...(rawStep as Record<string, unknown>) };
          if (
            (step.kind === 'fill' || step.kind === 'type') &&
            typeof step.secretRef === 'string' &&
            step.secretRef.trim().length > 0
          ) {
            const secret = await this.resolveSecret(step.secretRef);
            if (secret.value.length >= 3) {
              resolvedSecrets.push(secret.value);
            }
            if (step.kind === 'fill') {
              step.value = secret.value;
            } else {
              step.text = secret.value;
            }
            step.isSecret = true;
            step.secretRef = undefined;
          }
          stepsCopy.push(step);
        }
      }
      effectiveParams = { ...params, steps: stepsCopy };
    }

    const scrubValue = (input: unknown): unknown => {
      if (resolvedSecrets.length === 0) return input;
      if (typeof input === 'string') {
        let out = input;
        for (const s of resolvedSecrets) {
          if (out.includes(s)) out = out.replaceAll(s, '[REDACTED_SECRET]');
        }
        return out;
      }
      if (Array.isArray(input)) return input.map((item) => scrubValue(item));
      if (input && typeof input === 'object') {
        const res: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
          res[k] = scrubValue(v);
        }
        return res;
      }
      return input;
    };

    const resultPromise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        profile.pending.delete(id);
        reject(new Error(`Extension RPC "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      profile.pending.set(id, {
        resolve: (val) => resolve(scrubValue(val) as T),
        reject: (err) => {
          const msg = scrubValue(err.message) as string;
          reject(new Error(msg));
        },
        timer,
      });

      this.sendToSocket(profile.ws, {
        type: 'rpc.request',
        id,
        method,
        params: effectiveParams,
      });
    });

    try {
      const data = await resultPromise;
      if (options?.toolLabel) {
        this.pushActivity({
          profileId: profile.info.profileId,
          tabId,
          tool: options.toolLabel,
          summary: `${method}${tabId ? ` (tab ${tabId})` : ''}`,
          status: 'ok',
          durationMs: Date.now() - startedAt,
        });
      }
      return { profileId: profile.info.profileId, data };
    } catch (err) {
      if (options?.toolLabel) {
        this.pushActivity({
          profileId: profile.info.profileId,
          tabId,
          tool: options.toolLabel,
          summary: err instanceof Error ? err.message : String(err),
          status: 'error',
          durationMs: Date.now() - startedAt,
        });
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // State Helpers for Diffs, Screenshots, DevTools & Deck UI
  // -------------------------------------------------------------------------

  getPreviousSnapshot(profileId: string, tabId: number): PageSnapshot | undefined {
    return this.snapshots.get(`${profileId}:${tabId}`);
  }

  rememberSnapshot(profileId: string, snapshot: PageSnapshot): void {
    this.snapshots.set(`${profileId}:${snapshot.tabId}`, snapshot);
  }

  recordScreenshot(record: ScreenshotRecord): void {
    this.latestScreenshot = record;
  }

  getConsoleEntries(tabId?: number, level?: string, limit = 50): ConsoleEntry[] {
    let items = this.consoleBuffer;
    if (tabId !== undefined) {
      items = items.filter((e) => e.tabId === tabId);
    }
    if (level && level !== 'all') {
      items = items.filter((e) => e.level === level);
    }
    return items.slice(-limit);
  }

  getNetworkEntries(tabId?: number, onlyFailed = false, limit = 50): NetworkEntry[] {
    let items = this.networkBuffer;
    if (tabId !== undefined) {
      items = items.filter((e) => e.tabId === tabId);
    }
    if (onlyFailed) {
      items = items.filter((e) => e.failed || (e.status !== undefined && e.status >= 400));
    }
    return items.slice(-limit);
  }

  async listWorkflows(): Promise<RecordedWorkflow[]> {
    return this.workflows;
  }

  async deleteWorkflow(workflowId: string): Promise<boolean> {
    const before = this.workflows.length;
    this.workflows = this.workflows.filter((w) => w.id !== workflowId);
    if (this.workflows.length !== before) {
      savePersistedWorkflows(this.dataDir, this.workflows);
      return true;
    }
    return false;
  }

  async clearDiagnostics(target: 'console' | 'network' | 'all'): Promise<void> {
    if (target === 'console' || target === 'all') {
      this.consoleBuffer = [];
    }
    if (target === 'network' || target === 'all') {
      this.networkBuffer = [];
    }
  }

  async getDeckState(): Promise<DeckState> {
    const tabsByProfile: Record<string, TabInfo[]> = {};
    const profiles: BrowserProfileInfo[] = [];

    for (const [profileId, entry] of this.profiles.entries()) {
      profiles.push({ ...entry.info, paused: this.paused });
      tabsByProfile[profileId] = entry.tabs;
    }

    return {
      brokerVersion: SERVER_VERSION,
      brokerUrl: this.brokerUrl,
      paused: this.paused,
      defaultProfileId: this.defaultProfileId,
      profiles,
      tabs: tabsByProfile,
      policy: this.policy,
      pendingApprovals: [...this.pendingApprovals.values()].map((e) => e.request),
      pendingDialogs: Object.fromEntries(this.pendingDialogs.entries()),
      recentActivity: this.activity.slice(-30).reverse(),
      recentErrors: this.consoleBuffer
        .filter((c) => c.level === 'error' || c.level === 'warn')
        .slice(-20)
        .reverse(),
      recentFailedNetwork: this.networkBuffer
        .filter((n) => n.failed || (n.status !== undefined && n.status >= 400))
        .slice(-20)
        .reverse(),
      workflows: this.workflows,
      latestScreenshot: this.latestScreenshot,
    };
  }

  // -------------------------------------------------------------------------
  // Internal Broadcasts
  // -------------------------------------------------------------------------

  private pushActivity(event: Omit<ActivityEvent, 'id' | 'timestamp'>): void {
    const full: ActivityEvent = {
      id: randomUUID().slice(0, 8),
      timestamp: Date.now(),
      ...event,
    };
    this.activity.push(full);
    if (this.activity.length > MAX_ACTIVITY) {
      this.activity.splice(0, this.activity.length - MAX_ACTIVITY);
    }
    this.broadcastEvent('activity.updated', full);
  }

  private broadcastApprovals(): void {
    const approvals = [...this.pendingApprovals.values()].map((e) => e.request);
    this.broadcastEvent('approvals.updated', { approvals });
  }

  private broadcastEvent(
    event: 'approvals.updated' | 'policy.updated' | 'paused.updated' | 'activity.updated',
    payload: unknown,
  ): void {
    for (const entry of this.profiles.values()) {
      this.sendToSocket(entry.ws, {
        type: 'broker.event',
        event,
        payload,
      });
    }
  }

  private sendToSocket(ws: WebSocket, message: BrokerToExtensionMessage): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }
}
