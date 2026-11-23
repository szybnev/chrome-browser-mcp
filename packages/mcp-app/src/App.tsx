import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import { APP_VERSION, type DeckState, type RecordedWorkflow, type TabInfo } from '@chrome-browser-mcp/protocol';
import { VirtualList } from './VirtualList.js';
import { InfoTip } from './InfoTip.js';

type DeckTab = 'overview' | 'timeline' | 'devtools' | 'workflows' | 'security';

interface ToolStructuredPayload {
  focusTab?: DeckTab;
  state?: DeckState;
}

export function App() {
  const [deckState, setDeckState] = useState<DeckState | null>(null);
  const [activeTab, setActiveTab] = useState<DeckTab>('overview');
  const [tabQuery, setTabQuery] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { app, isConnected, error } = useApp({
    appInfo: { name: 'Browser Control Deck', version: APP_VERSION },
    capabilities: {},
    onAppCreated: (instance) => {
      instance.ontoolresult = (result) => {
        const structured = result.structuredContent as ToolStructuredPayload | undefined;
        if (structured?.state) setDeckState(structured.state);
        if (structured?.focusTab) setActiveTab(structured.focusTab);
      };
    },
  });

  useHostStyles(app, app?.getHostContext());

  const callDeckTool = useCallback(
    async (name: string, args: Record<string, unknown> = {}) => {
      if (!app) return;
      setBusy(true);
      try {
        const res = await app.callServerTool({ name, arguments: args });
        const structured = res.structuredContent as ToolStructuredPayload | undefined;
        if (structured?.state) setDeckState(structured.state);
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [app],
  );

  useEffect(() => {
    if (!isConnected || !app) return;
    void callDeckTool('deck_get_state');
    const timer = setInterval(() => void callDeckTool('deck_get_state'), 3000);
    return () => clearInterval(timer);
  }, [isConnected, app, callDeckTool]);

  const activeProfileId = deckState?.defaultProfileId ?? deckState?.profiles[0]?.profileId ?? '';
  const profileTabs = useMemo(
    () => (activeProfileId && deckState ? deckState.tabs[activeProfileId] ?? [] : []),
    [activeProfileId, deckState],
  );

  const agentTabs = useMemo(
    () => profileTabs.filter((t) => t.inAgentGroup),
    [profileTabs],
  );

  const otherTabs = useMemo(() => {
    const q = tabQuery.trim().toLowerCase();
    const list = profileTabs.filter((t) => !t.inAgentGroup);
    if (!q) return list;
    return list.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.url.toLowerCase().includes(q) ||
        String(t.tabId).includes(q),
    );
  }, [profileTabs, tabQuery]);

  if (error) {
    return (
      <div className="panel-inner">
        <div className="card danger">
          <strong>MCP App connection error:</strong> {error.message}
        </div>
      </div>
    );
  }

  if (!isConnected || !deckState) {
    return (
      <div className="panel-inner">
        <div className="card">Connecting to Chrome Browser MCP Control Deck…</div>
      </div>
    );
  }

  const hostCaps = app?.getHostCapabilities();
  const canSendMessage = Boolean(hostCaps?.message);
  const canUpdateContext = Boolean(hostCaps?.updateModelContext);

  const handleSendDiagnosticsToAgent = async (summary: string) => {
    if (!app || !canSendMessage) return;
    await app.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: summary }],
    });
    setNotice('Sent diagnostics to conversation.');
  };

  const handleAttachWorkflowToContext = async (wf: RecordedWorkflow) => {
    if (!app || !canUpdateContext) return;
    await app.updateModelContext({
      content: [
        {
          type: 'text',
          text: `Recorded browser workflow "${wf.name}" (id: ${wf.id}, startUrl: ${wf.startUrl}):\n${JSON.stringify(
            wf.steps.map((s) => ({ description: s.description, step: s.step })),
            null,
            2,
          )}`,
        },
      ],
    });
    setNotice(`Attached workflow "${wf.name}" to your next message.`);
  };

  const controlledCount =
    deckState.policy.scopeMode === 'all-tabs' ? profileTabs.length : agentTabs.length;

  const tabItems: Array<{ id: DeckTab; label: string }> = [
    { id: 'overview', label: `Overview (${controlledCount})` },
    { id: 'timeline', label: `Timeline (${deckState.recentActivity.length})` },
    {
      id: 'devtools',
      label: `DevTools (${deckState.recentErrors.length + deckState.recentFailedNetwork.length})`,
    },
    { id: 'workflows', label: `Workflows (${deckState.workflows.length})` },
    { id: 'security', label: 'Security' },
  ];

  const renderTabRow = (t: TabInfo, highlight = false) => (
    <div key={t.tabId} className={`item-row ${highlight ? 'agent-row' : ''}`}>
      <div className="item-meta">
        <div className="item-title">
          [{t.tabId}] {t.title || '(untitled)'}{' '}
          {t.active && <span className="pill">Active</span>}{' '}
          {t.cdpAttached && <span className="pill warn">CDP</span>}
        </div>
        <div className="item-sub">{t.url}</div>
      </div>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <button
          type="button"
          className={`btn small ${t.inAgentGroup ? '' : 'primary'}`}
          onClick={() =>
            void callDeckTool('deck_tab_action', {
              profileId: activeProfileId,
              tabId: t.tabId,
              action: t.inAgentGroup ? 'detach' : 'attach',
            })
          }
        >
          {t.inAgentGroup ? 'Detach' : 'Attach'}
        </button>
        <button
          type="button"
          className="btn small"
          title="Switch tab in background (Shift+Click to bring Chrome to front)"
          onClick={(e) =>
            void callDeckTool('deck_tab_action', {
              profileId: activeProfileId,
              tabId: t.tabId,
              action: 'focus',
              bringToFront: e.shiftKey,
            })
          }
        >
          Focus
        </button>
      </div>
    </div>
  );

  return (
    <div className="deck">
      <header className="deck-header">
        <div className="deck-title-group">
          <span className={`status-dot ${deckState.profiles.length > 0 ? 'ok' : ''}`} />
          <div>
            <div className="deck-title">Browser Control Deck</div>
            <div className="muted">
              v{deckState.brokerVersion} · {deckState.profiles.length} profile(s) ·{' '}
              {profileTabs.length} total tab(s)
            </div>
          </div>
        </div>

        <div className="row">
          {deckState.profiles.length > 0 && (
            <select
              className="select"
              aria-label="Active browser profile"
              value={activeProfileId}
              onChange={(e) =>
                void callDeckTool('deck_select_profile', { profileId: e.target.value })
              }
            >
              {deckState.profiles.map((p) => (
                <option key={p.profileId} value={p.profileId}>
                  {p.browserName}: {p.label} ({p.profileId})
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="btn small"
            disabled={busy}
            onClick={() => void callDeckTool('deck_get_state')}
          >
            Refresh
          </button>
          <button
            type="button"
            className={`btn small ${deckState.paused ? 'primary' : 'danger'}`}
            onClick={() => void callDeckTool('deck_set_paused', { paused: !deckState.paused })}
          >
            {deckState.paused ? 'Resume' : 'Pause All'}
          </button>
        </div>
      </header>

      <div
        className="tablist"
        role="tablist"
        aria-label="Browser Control Deck views"
        {...({ focusgroup: 'tablist nomemory' } as Record<string, string>)}
      >
        {tabItems.map((t) => (
          <button
            key={t.id}
            type="button"
            id={`deck-tab-${t.id}`}
            role="tab"
            className="tab-btn"
            aria-selected={activeTab === t.id}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <main className="scroller deck-main">
        {/* OVERVIEW */}
        <section
          role="tabpanel"
          aria-labelledby="deck-tab-overview"
          hidden={activeTab !== 'overview'}
        >
          <div className="panel-inner panel-fill">
            {notice && <div className="card">{notice}</div>}

            {deckState.paused && (
              <div className="card danger">
                <strong>Automation Paused</strong>
                <div className="muted">All agent actions are halted until resumed.</div>
              </div>
            )}

            {deckState.pendingApprovals.map((req) => (
              <div key={req.id} className="card warn">
                <div className="row-between">
                  <strong>Approval Required — {req.action}</strong>
                  <span className="pill warn">{req.risk.toUpperCase()}</span>
                </div>
                <div className="muted">{req.reason}</div>
                <div className="code-box">{req.preview}</div>
                <div className="row">
                  <button
                    type="button"
                    className="btn primary small"
                    onClick={() =>
                      void callDeckTool('deck_resolve_approval', {
                        approvalId: req.id,
                        decision: 'approved',
                      })
                    }
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="btn danger small"
                    onClick={() =>
                      void callDeckTool('deck_resolve_approval', {
                        approvalId: req.id,
                        decision: 'rejected',
                      })
                    }
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}

            {/* DEDICATED AI AGENT CONTROLLED TABS */}
            <div className="card agent-box">
              <div className="row-between">
                <strong>AI Agent Tabs ({agentTabs.length})</strong>
              </div>
              {agentTabs.length === 0 ? (
                <div className="muted">
                  No tabs in the <strong>AI Agent</strong> group yet. Drag any tab into the cyan
                  &ldquo;AI Agent&rdquo; group in Chrome, or click <strong>Attach</strong> below.
                </div>
              ) : (
                <div className="scroller agent-tabs-scroll">
                  {agentTabs.map((t) => renderTabRow(t, true))}
                </div>
              )}
            </div>

            {deckState.latestScreenshot && (
              <div className="card" style={{ flex: '0 0 auto' }}>
                <div className="row-between">
                  <strong>Latest Viewport Capture</strong>
                  <span className="pill accent">
                    Tab {deckState.latestScreenshot.tabId}
                    {deckState.latestScreenshot.setOfMark ? ' · SoM' : ''}
                  </span>
                </div>
                <img
                  className="screenshot-frame"
                  src={deckState.latestScreenshot.dataUrl}
                  alt={`Screenshot of ${deckState.latestScreenshot.url}`}
                />
                <div className="muted">{deckState.latestScreenshot.url}</div>
              </div>
            )}

            {/* ALL OTHER BROWSER TABS (ADAPTIVE HEIGHT + VIRTUALIZED) */}
            <div className={`card ${otherTabs.length > 0 ? 'fill-card' : ''}`}>
              <div className="row-between">
                <strong>
                  All Browser Tabs ({otherTabs.length}
                  {tabQuery ? ` / ${profileTabs.length - agentTabs.length}` : ''})
                </strong>
              </div>
              <input
                type="search"
                className="search-input"
                placeholder={`Filter ${profileTabs.length - agentTabs.length} tabs by title, URL, or ID…`}
                value={tabQuery}
                onChange={(e) => setTabQuery(e.target.value)}
              />
              {profileTabs.length === 0 ? (
                <div className="muted">
                  No Chrome profile connected yet. Run <code>npx chrome-browser-mcp token</code> and
                  connect from the Chrome Side Panel.
                </div>
              ) : (
                <VirtualList
                  items={otherTabs}
                  rowHeight={56}
                  fillHeight
                  getKey={(t) => t.tabId}
                  renderRow={(t) => renderTabRow(t, false)}
                  emptyState={<div className="muted">No matching tabs.</div>}
                />
              )}
            </div>
          </div>
        </section>

        {/* TIMELINE (DEDICATED TOP-LEVEL TAB) */}
        <section
          role="tabpanel"
          aria-labelledby="deck-tab-timeline"
          hidden={activeTab !== 'timeline'}
        >
          <div className="panel-inner panel-fill">
            <div className={`card ${deckState.recentActivity.length > 0 ? 'fill-card' : ''}`}>
              <div className="row-between">
                <strong>Live Action Timeline ({deckState.recentActivity.length})</strong>
                <span className="muted">Most recent first</span>
              </div>
              {deckState.recentActivity.length === 0 ? (
                <div className="muted">Waiting for agent browser actions…</div>
              ) : (
                <VirtualList
                  items={deckState.recentActivity}
                  rowHeight={54}
                  fillHeight
                  getKey={(ev) => ev.id}
                  renderRow={(ev) => (
                    <div className="item-row">
                      <div className="item-meta">
                        <div className="item-title">
                          {ev.tool}{' '}
                          <span className="muted" style={{ fontWeight: 400 }}>
                            · {new Date(ev.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                        <div className="item-sub">
                          {ev.summary}
                          {ev.durationMs !== undefined ? ` · ${ev.durationMs}ms` : ''}
                        </div>
                      </div>
                      <span className={`pill ${ev.status === 'ok' ? 'accent' : 'danger'}`}>
                        {ev.status}
                      </span>
                    </div>
                  )}
                />
              )}
            </div>
          </div>
        </section>

        {/* DEVTOOLS */}
        <section
          role="tabpanel"
          aria-labelledby="deck-tab-devtools"
          hidden={activeTab !== 'devtools'}
        >
          <div className="panel-inner">
            <div className="card">
              <div className="row-between">
                <strong>Console Errors &amp; Warnings</strong>
                {canSendMessage && deckState.recentErrors.length > 0 && (
                  <button
                    type="button"
                    className="btn primary small"
                    onClick={() =>
                      void handleSendDiagnosticsToAgent(
                        `Please investigate these browser console errors:\n${deckState.recentErrors
                          .slice(0, 8)
                          .map((e) => `- [${e.level}] ${e.text} (${e.source ?? ''}:${e.line ?? ''})`)
                          .join('\n')}`,
                      )
                    }
                  >
                    Ask Agent to Fix
                  </button>
                )}
              </div>
              {deckState.recentErrors.length === 0 ? (
                <div className="muted">No console warnings or errors captured yet.</div>
              ) : (
                deckState.recentErrors.map((errEntry) => (
                  <div key={errEntry.id} className="item-row">
                    <div className="item-meta">
                      <div className="item-title">
                        [{errEntry.level.toUpperCase()}] {errEntry.text}
                      </div>
                      <div className="item-sub">
                        Tab {errEntry.tabId}
                        {errEntry.source ? ` · ${errEntry.source}:${errEntry.line ?? 0}` : ''}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="card">
              <div className="row-between">
                <strong>Failed Network Requests</strong>
                {canSendMessage && deckState.recentFailedNetwork.length > 0 && (
                  <button
                    type="button"
                    className="btn primary small"
                    onClick={() =>
                      void handleSendDiagnosticsToAgent(
                        `Please investigate these failed browser network requests:\n${deckState.recentFailedNetwork
                          .slice(0, 8)
                          .map(
                            (n) =>
                              `- ${n.method} ${n.status ?? 'ERR'} ${n.url} ${n.errorText ?? ''}`,
                          )
                          .join('\n')}`,
                      )
                    }
                  >
                    Ask Agent to Debug
                  </button>
                )}
              </div>
              {deckState.recentFailedNetwork.length === 0 ? (
                <div className="muted">No failed HTTP/network requests captured.</div>
              ) : (
                deckState.recentFailedNetwork.map((net) => (
                  <div key={net.requestId} className="item-row">
                    <div className="item-meta">
                      <div className="item-title">
                        {net.method} {net.status ?? 'FAILED'} · {net.url}
                      </div>
                      <div className="item-sub">
                        {net.errorText || net.statusText || 'HTTP error'}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>

        {/* WORKFLOWS */}
        <section
          role="tabpanel"
          aria-labelledby="deck-tab-workflows"
          hidden={activeTab !== 'workflows'}
        >
          <div className="panel-inner">
            <div className="card">
              <strong>Recorded User Workflows</strong>
              <div className="muted">
                Record multi-step flows in Chrome Side Panel (“Show by hand”) and attach them to
                your conversation or let the agent replay them via <code>browser_workflows</code>.
              </div>
              {deckState.workflows.length === 0 ? (
                <div className="muted">No saved workflows yet.</div>
              ) : (
                deckState.workflows.map((wf) => (
                  <div key={wf.id} className="item-row">
                    <div className="item-meta">
                      <div className="item-title">{wf.name}</div>
                      <div className="item-sub">
                        {wf.steps.length} steps · {wf.startUrl}
                      </div>
                    </div>
                    <div className="row">
                      {canUpdateContext && (
                        <button
                          type="button"
                          className="btn primary small"
                          onClick={() => void handleAttachWorkflowToContext(wf)}
                        >
                          Attach to Agent
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn small"
                        onClick={() =>
                          void callDeckTool('deck_delete_workflow', { workflowId: wf.id })
                        }
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>

        {/* SECURITY */}
        <section
          role="tabpanel"
          aria-labelledby="deck-tab-security"
          hidden={activeTab !== 'security'}
        >
          <div className="panel-inner">
            <div className="card security-card">
              <strong>Security &amp; Guardrails</strong>
              <div className="security-row">
                <span className="security-label-group">
                  <label htmlFor="sec-all-tabs">
                    Allow all tabs (instead of AI Agent group only)
                  </label>
                  <InfoTip
                    label="Allow all tabs"
                    text="By default, agents can only read and control tabs inside the cyan “AI Agent” tab group. Turn this on to let agents access any open tab in your browser window (blocked domains still stay protected)."
                  />
                </span>
                <input
                  id="sec-all-tabs"
                  type="checkbox"
                  checked={deckState.policy.scopeMode === 'all-tabs'}
                  onChange={(e) =>
                    void callDeckTool('deck_update_policy', {
                      scopeMode: e.target.checked ? 'all-tabs' : 'agent-group',
                    })
                  }
                />
              </div>

              <div className="security-row">
                <span className="security-label-group">
                  <label htmlFor="sec-shield">Prompt-Injection Shield</label>
                  <InfoTip
                    label="Prompt-Injection Shield"
                    text="Filters hidden, zero-opacity, and offscreen DOM traps, strips invisible zero-width/bidi characters, wraps page text in UNTRUSTED_PAGE_CONTENT markers, and flags suspicious prompt-override instructions."
                  />
                </span>
                <input
                  id="sec-shield"
                  type="checkbox"
                  checked={deckState.policy.promptInjectionShield}
                  onChange={(e) =>
                    void callDeckTool('deck_update_policy', {
                      promptInjectionShield: e.target.checked,
                    })
                  }
                />
              </div>

              <div className="security-row">
                <span className="security-label-group">
                  <label htmlFor="sec-eval">Confirm JS eval on new origins</label>
                  <InfoTip
                    label="Confirm JS eval on new origins"
                    text="Pauses and asks for your explicit Approve/Reject confirmation the first time an agent attempts to run arbitrary JavaScript (browser_eval) on a website origin."
                  />
                </span>
                <input
                  id="sec-eval"
                  type="checkbox"
                  checked={deckState.policy.requireApprovalForEval}
                  onChange={(e) =>
                    void callDeckTool('deck_update_policy', {
                      requireApprovalForEval: e.target.checked,
                    })
                  }
                />
              </div>

              <div className="security-row">
                <span className="security-label-group">
                  <label htmlFor="sec-pass">Confirm password input</label>
                  <InfoTip
                    label="Confirm password input"
                    text="Requires explicit approval before an agent can fill or type into any password field (input[type=password])."
                  />
                </span>
                <input
                  id="sec-pass"
                  type="checkbox"
                  checked={deckState.policy.requireApprovalForPasswords}
                  onChange={(e) =>
                    void callDeckTool('deck_update_policy', {
                      requireApprovalForPasswords: e.target.checked,
                    })
                  }
                />
              </div>

              <div className="security-row">
                <span className="security-label-group">
                  <label htmlFor="sec-pay">Confirm payment / destructive submits</label>
                  <InfoTip
                    label="Confirm payment and destructive submits"
                    text="Pauses for explicit confirmation before clicking buttons labeled with checkout, payment, transfer, or account-deletion actions."
                  />
                </span>
                <input
                  id="sec-pay"
                  type="checkbox"
                  checked={deckState.policy.requireApprovalForPayments}
                  onChange={(e) =>
                    void callDeckTool('deck_update_policy', {
                      requireApprovalForPayments: e.target.checked,
                    })
                  }
                />
              </div>

              <div className="security-row" style={{ alignItems: 'flex-start' }}>
                <div className="muted">
                  Blocked domains ({deckState.policy.blockedDomains.length}):{' '}
                  {deckState.policy.blockedDomains.slice(0, 6).join(', ')}
                  {deckState.policy.blockedDomains.length > 6 ? '…' : ''}
                </div>
                <InfoTip
                  label="Blocked domains"
                  text="Hard-blocked URLs and wildcard patterns (e.g. chrome://*, *.paypal.com, banking & password managers). Agents cannot navigate, read, or act on these domains even if “Allow all tabs” is enabled. Edit the full list in Chrome Side Panel → Security."
                />
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
