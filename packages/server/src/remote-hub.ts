import type {
  ApprovalRequest,
  BrowserProfileInfo,
  ConsoleEntry,
  DeckState,
  ExtensionRpcMethod,
  NetworkEntry,
  PageSnapshot,
  RecordedWorkflow,
  RiskLevel,
  ScreenshotRecord,
  SecurityPolicy,
} from '@chrome-browser-mcp/protocol';
import type { BrowserHubInterface } from './hub.js';
import { isUrlBlocked, SecurityPolicySchema } from '@chrome-browser-mcp/protocol';

/**
 * HTTP proxy implementation of BrowserHubInterface used by stdio shims to
 * multiplex onto the shared local Broker Daemon without port conflicts.
 */
export class RemoteBrokerHub implements BrowserHubInterface {
  private cachedPolicy: SecurityPolicy = SecurityPolicySchema.parse({});
  private cachedPaused = false;
  private localSnapshots = new Map<string, PageSnapshot>();

  constructor(
    private readonly brokerUrl: string,
    private readonly token: string,
  ) {}

  private async post<T>(path: string, body: unknown = {}): Promise<T> {
    const res = await fetch(`${this.brokerUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-broker-token': this.token,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: { ok?: boolean; data?: T; error?: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Broker returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok || parsed.ok === false) {
      throw new Error(parsed.error || `Broker HTTP error ${res.status}`);
    }
    return parsed.data as T;
  }

  async getDeckState(): Promise<DeckState> {
    const state = await this.post<DeckState>('/internal/deck-state');
    this.cachedPolicy = state.policy;
    this.cachedPaused = state.paused;
    return state;
  }

  async listProfiles(): Promise<{ defaultProfileId: string | null; profiles: BrowserProfileInfo[] }> {
    return this.post('/internal/profiles');
  }

  async selectDefaultProfile(profileId: string): Promise<BrowserProfileInfo> {
    return this.post('/internal/select-profile', { profileId });
  }

  async setPaused(paused: boolean): Promise<{ paused: boolean }> {
    const res = await this.post<{ paused: boolean }>('/internal/set-paused', { paused });
    this.cachedPaused = res.paused;
    return res;
  }

  async updatePolicy(patch: Partial<SecurityPolicy>): Promise<SecurityPolicy> {
    const updated = await this.post<SecurityPolicy>('/internal/update-policy', patch);
    this.cachedPolicy = updated;
    return updated;
  }

  async resolveApproval(
    approvalId: string,
    decision: 'approved' | 'rejected',
  ): Promise<ApprovalRequest | null> {
    return this.post('/internal/resolve-approval', { approvalId, decision });
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
    return this.post('/internal/call-extension', { method, params, options });
  }

  checkUrlPolicy(url: string): { blocked: boolean; reason?: string } {
    return isUrlBlocked(url, this.cachedPolicy.blockedDomains, this.cachedPolicy.allowedDomains);
  }

  async requestApprovalIfNeeded(args: {
    profileId: string;
    tabId?: number;
    origin: string;
    action: string;
    reason: string;
    risk: RiskLevel;
    preview: string;
    kind: 'eval' | 'password' | 'payment';
  }): Promise<void> {
    await this.post('/internal/request-approval', args);
  }

  getPreviousSnapshot(profileId: string, tabId: number): PageSnapshot | undefined {
    return this.localSnapshots.get(`${profileId}:${tabId}`);
  }

  rememberSnapshot(profileId: string, snapshot: PageSnapshot): void {
    this.localSnapshots.set(`${profileId}:${snapshot.tabId}`, snapshot);
  }

  recordScreenshot(record: ScreenshotRecord): void {
    void this.post('/internal/record-screenshot', record).catch(() => {});
  }

  getConsoleEntries(): ConsoleEntry[] {
    return [];
  }

  getNetworkEntries(): NetworkEntry[] {
    return [];
  }

  async listWorkflows(): Promise<RecordedWorkflow[]> {
    return this.post('/internal/workflows');
  }

  async deleteWorkflow(workflowId: string): Promise<boolean> {
    return this.post('/internal/delete-workflow', { workflowId });
  }

  getPolicy(): SecurityPolicy {
    return this.cachedPolicy;
  }

  isPaused(): boolean {
    return this.cachedPaused;
  }
}
