import { useCallback, useEffect, useState } from 'react';
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import type { DeckState, RecordedWorkflow } from '@chrome-browser-mcp/protocol';

type DeckTab = 'overview' | 'devtools' | 'workflows' | 'security';

interface ToolStructuredPayload {
  focusTab?: DeckTab;
  state?: DeckState;
}

export function App() {
  const [deckState, setDeckState] = useState<DeckState | null>(null);
  const [activeTab, setActiveTab] = useState<DeckTab>('overview');
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { app, isConnected, error } = useApp({
    appInfo: { name: 'Browser Control Deck', version: '0.1.0' },
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
    const timer = setInterval(() => void callDeckTool('deck_get_state'), 4000);
    return () => clearInterval(timer);
  }, [isConnected, app, callDeckTool]);

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

  const activeProfileId = deckState.defaultProfileId ?? deckState.profiles[0]?.profileId ?? '';
  const profileTabs = activeProfileId ? deckState.tabs[activeProfileId] ?? [] : [];

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

  const tabItems: Array<{ id: DeckTab; label: string }> = [
    { id: 'overview', label: `Overview (${profileTabs.filter((t) => t.inAgentGroup).length})` },
    {
      id: 'devtools',
      label: `DevTools (${deckState.recentErrors.length + deckState.recentFailedNetwork.length})`,
    },
    { id: 'workflows', label: `Workflows (${deckState.workflows.length})` },
    { id: 'security', label: 'Security' },
  ];

  return (
    <div className="deck">
      <header className="deck-header">
        <div className="deck-title-group">
          <span className={`status-dot ${deckState.profiles.length > 0 ? 'ok' : ''}`} />
          <div>
            <div className="deck-title">Browser Control Deck</div>
            <div className="muted">
              v{deckState.brokerVersion} · {deckState.profiles.length} browser profile(s)
            </div>
          </div>
        </div>

        <div className="row">
          {deckState.profiles.length > 0 && (
            <select
              className="select"
              aria-label="Active browser profile"
              value={activeProfileId}
              onChange={(e) => void callDeckTool('deck_select_profile', { profileId: e.target.value })}
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

      <main className="scroller">
        {/* OVERVIEW */}
        <section
          role="tabpanel"
          aria-labelledby="deck-tab-overview"
          hidden={activeTab !== 'overview'}
        >
          <div className="panel-inner">
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

            {deckState.latestScreenshot && (
              <div className="card">
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

            <div className="card">
              <div className="row-between">
                <strong>Browser Tabs</strong>
                <span className="pill">
                  Scope: {deckState.policy.scopeMode === 'all-tabs' ? 'All Tabs' : 'AI Agent Group'}
                </span>
              </div>
              {profileTabs.length === 0 ? (
                <div className="muted">
                  No Chrome profile connected yet. Run <code>npx chrome-browser-mcp token</code> and
                  connect from the Chrome Side Panel.
                </div>
              ) : (
                profileTabs.slice(0, 16).map((t) => (
                  <div key={t.tabId} className="item-row">
                    <div className="item-meta">
                      <div className="item-title">
                        [{t.tabId}] {t.title || '(untitled)'}{' '}
                        {t.inAgentGroup && <span className="pill accent">Agent Group</span>}{' '}
                        {t.cdpAttached && <span className="pill warn">CDP</span>}
                      </div>
                      <div className="item-sub">{t.url}</div>
                    </div>
                    <div className="row">
                      <button
                        type="button"
                        className="btn small"
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
                        onClick={() =>
                          void callDeckTool('deck_tab_action', {
                            profileId: activeProfileId,
                            tabId: t.tabId,
                            action: 'focus',
                          })
                        }
                      >
                        Focus
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="card">
              <strong>Live Action Timeline</strong>
              {deckState.recentActivity.length === 0 ? (
                <div className="muted">Waiting for agent browser actions…</div>
              ) : (
                deckState.recentActivity.slice(0, 15).map((ev) => (
                  <div key={ev.id} className="item-row">
                    <div className="item-meta">
                      <div className="item-title">{ev.tool}</div>
                      <div className="item-sub">
                        {ev.summary}
                        {ev.durationMs !== undefined ? ` · ${ev.durationMs}ms` : ''}
                      </div>
                    </div>
                    <span className={`pill ${ev.status === 'ok' ? 'accent' : 'danger'}`}>
                      {ev.status}
                    </span>
                  </div>
                ))
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
                          .map((n) => `- ${n.method} ${n.status ?? 'ERR'} ${n.url} ${n.errorText ?? ''}`)
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
                      <div className="item-sub">{net.errorText || net.statusText || 'HTTP error'}</div>
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
            <div className="card">
              <strong>Security &amp; Guardrails</strong>
              <label className="row-between">
                <span>Allow all tabs (instead of AI Agent group only)</span>
                <input
                  type="checkbox"
                  checked={deckState.policy.scopeMode === 'all-tabs'}
                  onChange={(e) =>
                    void callDeckTool('deck_update_policy', {
                      scopeMode: e.target.checked ? 'all-tabs' : 'agent-group',
                    })
                  }
                />
              </label>
              <label className="row-between">
                <span>Prompt-Injection Shield</span>
                <input
                  type="checkbox"
                  checked={deckState.policy.promptInjectionShield}
                  onChange={(e) =>
                    void callDeckTool('deck_update_policy', {
                      promptInjectionShield: e.target.checked,
                    })
                  }
                />
              </label>
              <label className="row-between">
                <span>Confirm JS eval on new origins</span>
                <input
                  type="checkbox"
                  checked={deckState.policy.requireApprovalForEval}
                  onChange={(e) =>
                    void callDeckTool('deck_update_policy', {
                      requireApprovalForEval: e.target.checked,
                    })
                  }
                />
              </label>
              <label className="row-between">
                <span>Confirm password input</span>
                <input
                  type="checkbox"
                  checked={deckState.policy.requireApprovalForPasswords}
                  onChange={(e) =>
                    void callDeckTool('deck_update_policy', {
                      requireApprovalForPasswords: e.target.checked,
                    })
                  }
                />
              </label>
              <label className="row-between">
                <span>Confirm payment / destructive submits</span>
                <input
                  type="checkbox"
                  checked={deckState.policy.requireApprovalForPayments}
                  onChange={(e) =>
                    void callDeckTool('deck_update_policy', {
                      requireApprovalForPayments: e.target.checked,
                    })
                  }
                />
              </label>
              <div className="muted">
                Blocked domains ({deckState.policy.blockedDomains.length}):{' '}
                {deckState.policy.blockedDomains.slice(0, 6).join(', ')}
                {deckState.policy.blockedDomains.length > 6 ? '…' : ''}
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
