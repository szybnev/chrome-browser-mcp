import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  RecordedStep,
  RecordedWorkflow,
  TabInfo,
} from '@chrome-browser-mcp/protocol';
import type { ExtensionRuntimeState, ExtensionSettings } from '../shared/storage.js';
import { VirtualList } from './VirtualList.js';
import { InfoTip } from './InfoTip.js';
import { ThemeToggle, type ThemeOverride } from './ThemeToggle.js';

interface SidePanelPayload {
  settings: ExtensionSettings;
  runtime: ExtensionRuntimeState;
  tabs: TabInfo[];
  workflows: RecordedWorkflow[];
  recordingSteps: RecordedStep[];
}

type PanelTab = 'control' | 'timeline' | 'workflows' | 'security' | 'connect';

async function sendSw<T = unknown>(message: Record<string, unknown>): Promise<T> {
  const res = (await chrome.runtime.sendMessage(message)) as {
    ok: boolean;
    data?: T;
    error?: string;
  };
  if (!res?.ok) throw new Error(res?.error || 'Background request failed');
  return res.data as T;
}

export function App() {
  const [data, setData] = useState<SidePanelPayload | null>(null);
  const [activeTab, setActiveTab] = useState<PanelTab>('control');
  const [tabQuery, setTabQuery] = useState('');
  const [workflowName, setWorkflowName] = useState('');
  const [wsUrlDraft, setWsUrlDraft] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [labelDraft, setLabelDraft] = useState('');
  const [blockedDraft, setBlockedDraft] = useState('');
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const payload = await sendSw<SidePanelPayload>({ type: 'sp.getState' });
      setData(payload);
      if (payload.runtime.connected) {
        setStatusMsg((prev) => (prev?.includes('reconnecting') ? null : prev));
      }
      setWsUrlDraft((prev) => prev || payload.settings.wsUrl);
      setTokenDraft((prev) => prev || payload.settings.token);
      setLabelDraft((prev) => prev || payload.settings.profileLabel);
      setBlockedDraft((prev) => prev || payload.settings.policy.blockedDomains.join('\n'));
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();

    // Event-driven push port to Service Worker (eliminates 3s polling)
    let port: chrome.runtime.Port | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const connectPort = () => {
      if (disposed) return;
      try {
        port = chrome.runtime.connect({ name: 'sidepanel' });
        port.onMessage.addListener((msg: { type?: string }) => {
          if (msg?.type === 'sp.stateChanged') {
            void refresh();
          }
        });
        port.onDisconnect.addListener(() => {
          port = null;
          if (!disposed) {
            reconnectTimer = setTimeout(() => {
              connectPort();
              void refresh();
            }, 1500);
          }
        });
      } catch {
        // Fallback to runtime.onMessage below
      }
    };
    connectPort();

    const listener = (msg: { type?: string }) => {
      if (msg.type === 'sp.stateChanged') {
        void refresh();
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    // Calm 15s safety sync only if background SW slept/restarted
    const safetyInterval = setInterval(() => {
      if (!port) void refresh();
    }, 15_000);

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearInterval(safetyInterval);
      chrome.runtime.onMessage.removeListener(listener);
      try {
        port?.disconnect();
      } catch {
        // ignore
      }
    };
  }, [refresh]);

  const attachedTabs = useMemo(
    () => (data ? data.tabs.filter((t) => t.inAgentGroup) : []),
    [data],
  );

  const otherTabs = useMemo(() => {
    if (!data) return [];
    const q = tabQuery.trim().toLowerCase();
    const list = data.tabs.filter((t) => !t.inAgentGroup);
    if (!q) return list;
    return list.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.url.toLowerCase().includes(q) ||
        String(t.tabId).includes(q),
    );
  }, [data, tabQuery]);

  if (!data) {
    return (
      <div className="app-shell">
        <div className="tab-panel-inner">
          <div className="card">Loading Chrome Browser MCP Control HUD…</div>
        </div>
      </div>
    );
  }

  const { settings, runtime, tabs, workflows, recordingSteps } = data;
  const isRecording = runtime.recordingTabId !== null;

  const handleThemePersist = async (next: ThemeOverride) => {
    await sendSw({
      type: 'sp.saveSettings',
      patch: { theme: next },
      reconnect: false,
    });
    await refresh();
  };

  const handleTogglePause = async () => {
    await sendSw({ type: 'sp.setPaused', paused: !runtime.paused });
    await refresh();
  };

  const handleAttachCurrent = async () => {
    await sendSw({ type: 'sp.attachCurrentTab' });
    await refresh();
  };

  const handleToggleTab = async (tabId: number, attach: boolean) => {
    await sendSw({ type: 'sp.toggleTab', tabId, attach });
    await refresh();
  };

  const handleApproval = async (approvalId: string, decision: 'approved' | 'rejected') => {
    await sendSw({ type: 'sp.resolveApproval', approvalId, decision });
    await refresh();
  };

  const handleSaveConnection = async () => {
    await sendSw({
      type: 'sp.saveSettings',
      patch: {
        wsUrl: wsUrlDraft.trim(),
        token: tokenDraft.trim(),
        profileLabel: labelDraft.trim() || 'default',
      },
      reconnect: true,
    });
    setStatusMsg('Connection settings saved — reconnecting…');
    await refresh();
  };

  const handlePolicyPatch = async (patch: Partial<ExtensionSettings['policy']>) => {
    await sendSw({
      type: 'sp.saveSettings',
      patch: { policy: { ...settings.policy, ...patch } },
      reconnect: false,
    });
    await refresh();
  };

  const handleSaveBlocklist = async () => {
    const blockedDomains = blockedDraft
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    await handlePolicyPatch({ blockedDomains });
    setStatusMsg(`Saved ${blockedDomains.length} blocked domain rule(s).`);
  };

  const handleStartRecording = async () => {
    await sendSw({ type: 'sp.startRecording' });
    await refresh();
  };

  const handleStopRecording = async (save: boolean) => {
    await sendSw({
      type: 'sp.stopRecording',
      save,
      name: workflowName.trim() || undefined,
    });
    setWorkflowName('');
    await refresh();
  };

  const handleDeleteWorkflow = async (workflowId: string) => {
    await sendSw({ type: 'sp.deleteWorkflow', workflowId });
    await refresh();
  };

  const tabItems: Array<{ id: PanelTab; label: string }> = [
    { id: 'control', label: `Control (${attachedTabs.length})` },
    { id: 'timeline', label: `Timeline (${runtime.recentActivity.length})` },
    { id: 'workflows', label: `Recorder (${workflows.length})` },
    { id: 'security', label: 'Security' },
    { id: 'connect', label: runtime.connected ? 'Connected' : 'Pair' },
  ];

  const renderTabRow = (t: TabInfo) => (
    <div key={t.tabId} className="tab-row">
      <div className="tab-meta">
        <div className="tab-title">
          {t.title || '(untitled)'}{' '}
          {t.cdpAttached && <span className="pill accent">CDP</span>}
        </div>
        <div className="tab-url">{t.url}</div>
      </div>
      <button
        type="button"
        className={`btn small ${t.inAgentGroup ? '' : 'primary'}`}
        onClick={() => void handleToggleTab(t.tabId, !t.inAgentGroup)}
      >
        {t.inAgentGroup ? 'Detach' : 'Attach'}
      </button>
    </div>
  );

  return (
    <div className="app-shell">
      <header className="header">
        <div className="brand">
          <span className={`brand-dot ${runtime.connected ? 'online' : ''}`} />
          <div>
            <div className="brand-title">Chrome Browser MCP</div>
            <div className="brand-sub">
              {settings.browserName} · {settings.profileLabel} · {tabs.length} tabs
            </div>
          </div>
        </div>
        <div className="header-actions">
          <ThemeToggle
            persistedTheme={settings.theme ?? null}
            onPersist={(next) => void handleThemePersist(next)}
          />
          <button
            type="button"
            className={`btn small ${runtime.paused ? 'primary' : 'danger'}`}
            onClick={handleTogglePause}
            title="Shortcut: Alt+Shift+P"
          >
            {runtime.paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      </header>

      <div
        className="tablist"
        role="tablist"
        aria-label="Control HUD sections"
        {...({ focusgroup: 'tablist nomemory' } as Record<string, string>)}
      >
        {tabItems.map((item) => (
          <button
            key={item.id}
            type="button"
            id={`tab-${item.id}`}
            role="tab"
            className="tab-btn"
            aria-selected={activeTab === item.id}
            onClick={() => setActiveTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <main className="scroller sp-main">
        {/* CONTROL TAB */}
        <section
          role="tabpanel"
          aria-labelledby="tab-control"
          hidden={activeTab !== 'control'}
        >
          <div className="tab-panel-inner panel-fill">
            {runtime.paused && (
              <div className="card paused-banner">
                <div className="card-title">Automation Paused</div>
                <div className="muted">
                  All external MCP actions are blocked until you resume (Alt+Shift+P).
                </div>
              </div>
            )}

            {!runtime.connected && (
              <div className="card approval">
                <div className="card-title">Not connected to local broker</div>
                <div className="muted">
                  {runtime.lastError ||
                    'Run `npx chrome-browser-mcp token`, open the Pair tab, and paste the token.'}
                </div>
                <button
                  type="button"
                  className="btn primary small"
                  onClick={() => setActiveTab('connect')}
                >
                  Open Pair Settings
                </button>
              </div>
            )}

            {runtime.pendingApprovals.map((req) => (
              <div key={req.id} className="card approval">
                <div className="card-header">
                  <span className="card-title">Approval Needed</span>
                  <span className="pill warn">{req.risk.toUpperCase()}</span>
                </div>
                <div className="muted">{req.reason}</div>
                <div className="code-preview">{req.preview}</div>
                <div className="row">
                  <button
                    type="button"
                    className="btn primary small"
                    onClick={() => void handleApproval(req.id, 'approved')}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="btn danger small"
                    onClick={() => void handleApproval(req.id, 'rejected')}
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}

            {/* DEDICATED AI AGENT TABS BLOCK */}
            <div className="card agent-box">
              <div className="card-header">
                <span className="card-title">AI Agent Tabs ({attachedTabs.length})</span>
                <button type="button" className="btn primary small" onClick={handleAttachCurrent}>
                  + Attach Active
                </button>
              </div>
              <label className="toggle-label">
                <span>Allow all tabs in window</span>
                <input
                  type="checkbox"
                  checked={settings.policy.scopeMode === 'all-tabs'}
                  onChange={(e) =>
                    void handlePolicyPatch({
                      scopeMode: e.target.checked ? 'all-tabs' : 'agent-group',
                    })
                  }
                />
              </label>

              {attachedTabs.length === 0 ? (
                <div className="muted">
                  No tabs in the AI Agent group. Drag a tab into the cyan &ldquo;AI Agent&rdquo;
                  group or click <strong>Attach</strong> below.
                </div>
              ) : (
                <div className="scroller agent-tabs-scroll">
                  {attachedTabs.map((t) => renderTabRow(t))}
                </div>
              )}
            </div>

            {/* ALL OTHER BROWSER TABS (ADAPTIVE HEIGHT) */}
            <div className={`card ${otherTabs.length > 0 ? 'fill-card' : ''}`}>
              <div className="card-header">
                <span className="card-title">
                  All Browser Tabs ({otherTabs.length}
                  {tabQuery ? ` / ${tabs.length - attachedTabs.length}` : ''})
                </span>
              </div>
              <input
                type="search"
                className="search-input"
                placeholder={`Filter ${tabs.length - attachedTabs.length} tabs…`}
                value={tabQuery}
                onChange={(e) => setTabQuery(e.target.value)}
              />
              <VirtualList
                items={otherTabs}
                rowHeight={52}
                fillHeight
                getKey={(t) => t.tabId}
                renderRow={(t) => renderTabRow(t)}
                emptyState={<div className="muted">No matching tabs.</div>}
              />
            </div>
          </div>
        </section>

        {/* TIMELINE TAB */}
        <section
          role="tabpanel"
          aria-labelledby="tab-timeline"
          hidden={activeTab !== 'timeline'}
        >
          <div className="tab-panel-inner panel-fill">
            <div className={`card ${runtime.recentActivity.length > 0 ? 'fill-card' : ''}`}>
              <div className="card-header">
                <span className="card-title">Live Action Timeline</span>
                <span className="muted">{runtime.recentActivity.length} events</span>
              </div>
              {runtime.recentActivity.length === 0 ? (
                <div className="muted">No actions recorded in this session yet.</div>
              ) : (
                <VirtualList
                  items={runtime.recentActivity}
                  rowHeight={48}
                  fillHeight
                  getKey={(ev) => ev.id}
                  renderRow={(ev) => (
                    <div className="tab-row">
                      <div className="tab-meta">
                        <div className="tab-title">{ev.tool}</div>
                        <div className="tab-url">
                          {ev.summary}
                          {ev.durationMs !== undefined ? ` · ${ev.durationMs}ms` : ''}
                        </div>
                      </div>
                      <span className={`pill ${ev.status === 'ok' ? 'accent' : 'warn'}`}>
                        {ev.status}
                      </span>
                    </div>
                  )}
                />
              )}
            </div>
          </div>
        </section>

        {/* WORKFLOW RECORDER TAB */}
        <section
          role="tabpanel"
          aria-labelledby="tab-workflows"
          hidden={activeTab !== 'workflows'}
        >
          <div className="tab-panel-inner">
            <div className="card">
              <div className="card-header">
                <span className="card-title">Workflow Recorder (“Show by hand”)</span>
                {isRecording ? (
                  <span className="pill warn">REC ({recordingSteps.length})</span>
                ) : (
                  <span className="pill">Idle</span>
                )}
              </div>
              <div className="muted">
                Record clicks, inputs, and selects on the active tab. Passwords are automatically
                masked as <code>{'{{PASSWORD}}'}</code>.
              </div>
              {!isRecording ? (
                <button type="button" className="btn primary" onClick={handleStartRecording}>
                  Start Recording Active Tab
                </button>
              ) : (
                <>
                  <input
                    className="input"
                    placeholder="Workflow name (e.g. Deploy preview)"
                    value={workflowName}
                    onChange={(e) => setWorkflowName(e.target.value)}
                  />
                  <div className="row">
                    <button
                      type="button"
                      className="btn primary"
                      onClick={() => void handleStopRecording(true)}
                    >
                      Stop &amp; Save ({recordingSteps.length})
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void handleStopRecording(false)}
                    >
                      Discard
                    </button>
                  </div>
                  {recordingSteps.length > 0 && (
                    <div className="code-preview">
                      {recordingSteps.map((s, i) => `${i + 1}. ${s.description}`).join('\n')}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="card">
              <div className="card-title">Saved Workflows</div>
              {workflows.length === 0 ? (
                <div className="muted">No saved workflows yet.</div>
              ) : (
                <div className="list">
                  {workflows.map((wf) => (
                    <div key={wf.id} className="tab-row">
                      <div className="tab-meta">
                        <div className="tab-title">{wf.name}</div>
                        <div className="tab-url">
                          {wf.steps.length} steps · {wf.startUrl}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn small"
                        onClick={() => void handleDeleteWorkflow(wf.id)}
                      >
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* SECURITY TAB */}
        <section
          role="tabpanel"
          aria-labelledby="tab-security"
          hidden={activeTab !== 'security'}
        >
          <div className="tab-panel-inner">
            <div className="card security-card">
              <div className="card-title">Protection &amp; Approval Gates</div>
              <div className="security-row">
                <span className="security-label-group">
                  <label htmlFor="sp-sec-shield">Prompt-Injection Shield</label>
                  <InfoTip
                    label="Prompt-Injection Shield"
                    text="Filters hidden/zero-opacity/offscreen DOM nodes, strips invisible zero-width/bidi characters, and frames page text with UNTRUSTED_PAGE_CONTENT boundaries."
                  />
                </span>
                <input
                  id="sp-sec-shield"
                  type="checkbox"
                  checked={settings.policy.promptInjectionShield}
                  onChange={(e) =>
                    void handlePolicyPatch({ promptInjectionShield: e.target.checked })
                  }
                />
              </div>

              <div className="security-row">
                <span className="security-label-group">
                  <label htmlFor="sp-sec-eval">Confirm JS eval on new origins</label>
                  <InfoTip
                    label="Confirm JS eval on new origins"
                    text="Requires Approve/Reject confirmation the first time an agent runs browser_eval on a domain."
                  />
                </span>
                <input
                  id="sp-sec-eval"
                  type="checkbox"
                  checked={settings.policy.requireApprovalForEval}
                  onChange={(e) =>
                    void handlePolicyPatch({ requireApprovalForEval: e.target.checked })
                  }
                />
              </div>

              <div className="security-row">
                <span className="security-label-group">
                  <label htmlFor="sp-sec-pass">Confirm password field input</label>
                  <InfoTip
                    label="Confirm password field input"
                    text="Pauses for explicit confirmation before filling or typing into any password field."
                  />
                </span>
                <input
                  id="sp-sec-pass"
                  type="checkbox"
                  checked={settings.policy.requireApprovalForPasswords}
                  onChange={(e) =>
                    void handlePolicyPatch({ requireApprovalForPasswords: e.target.checked })
                  }
                />
              </div>

              <div className="security-row">
                <span className="security-label-group">
                  <label htmlFor="sp-sec-pay">Confirm payment / delete submits</label>
                  <InfoTip
                    label="Confirm payment and delete submits"
                    text="Requires explicit approval before clicking controls related to checkout, payments, transfers, or account deletion."
                  />
                </span>
                <input
                  id="sp-sec-pay"
                  type="checkbox"
                  checked={settings.policy.requireApprovalForPayments}
                  onChange={(e) =>
                    void handlePolicyPatch({ requireApprovalForPayments: e.target.checked })
                  }
                />
              </div>
            </div>

            <div className="card">
              <div className="card-header">
                <span className="card-title">Blocked Domains (one per line)</span>
                <InfoTip
                  label="Blocked Domains"
                  text="Wildcard rules (e.g. chrome://*, *.paypal.com, *.stripe.com/dashboard*) that hard-block agent access even when “Allow all tabs” is enabled."
                />
              </div>
              <textarea
                className="textarea"
                value={blockedDraft}
                onChange={(e) => setBlockedDraft(e.target.value)}
              />
              <button type="button" className="btn primary small" onClick={handleSaveBlocklist}>
                Save Blocklist
              </button>
            </div>
          </div>
        </section>

        {/* PAIR / CONNECT TAB */}
        <section
          role="tabpanel"
          aria-labelledby="tab-connect"
          hidden={activeTab !== 'connect'}
        >
          <div className="tab-panel-inner">
            <div className="card">
              <div className="card-title">Local Broker Connection</div>
              <div className="muted">
                Run <code>npx chrome-browser-mcp token</code> in your terminal to get your local
                loopback pairing token.
              </div>
              <label className="muted">
                Profile Label (e.g. work, personal)
                <input
                  className="input"
                  value={labelDraft}
                  onChange={(e) => setLabelDraft(e.target.value)}
                />
              </label>
              <label className="muted">
                Local Broker WebSocket URL
                <input
                  className="input"
                  value={wsUrlDraft}
                  onChange={(e) => setWsUrlDraft(e.target.value)}
                />
              </label>
              <label className="muted">
                Pairing Token
                <input
                  className="input"
                  type="password"
                  placeholder="Paste token from CLI"
                  value={tokenDraft}
                  onChange={(e) => setTokenDraft(e.target.value)}
                />
              </label>
              <button type="button" className="btn primary" onClick={handleSaveConnection}>
                Save &amp; Connect
              </button>
              {statusMsg && <div className="muted">{statusMsg}</div>}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
