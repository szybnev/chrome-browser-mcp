import {
  APP_VERSION,
  type DeckState,
  type I18nKey,
  type LocalePreference,
  READ_ONLY_DOMAIN_PRESETS,
  type RecordedWorkflow,
  resolveLocale,
  type TabInfo,
  translate,
} from '@chrome-browser-mcp/protocol';
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { InfoTip } from './InfoTip.js';
import { ThemeToggle } from './ThemeToggle.js';
import { VirtualList } from './VirtualList.js';

type DeckTab = 'overview' | 'timeline' | 'devtools' | 'workflows' | 'security';

const DECK_SECRET =
  (typeof window !== 'undefined'
    ? (window as unknown as { __CBMCP_DECK_SECRET__?: string }).__CBMCP_DECK_SECRET__
    : undefined) ?? '';

const SAFE_IMAGE_DATA_URL_RE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

interface ToolStructuredPayload {
  focusTab?: DeckTab;
  state?: DeckState;
  pin?: string;
  expiresAt?: number;
}

export function App() {
  const [deckState, setDeckState] = useState<DeckState | null>(null);
  const [activeTab, setActiveTab] = useState<DeckTab>('overview');
  const [tabQuery, setTabQuery] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [pairingPin, setPairingPin] = useState<{ pin: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissedErrorIds, setDismissedErrorIds] = useState<Set<string>>(() => new Set());
  const [dismissedNetworkIds, setDismissedNetworkIds] = useState<Set<string>>(() => new Set());
  const [localePref, setLocalePref] = useState<LocalePreference>(() => {
    try {
      const saved = localStorage.getItem('cbmcp-deck-locale');
      return resolveLocale(saved ?? undefined);
    } catch {
      return 'en';
    }
  });
  const [localeDirty, setLocaleDirty] = useState(false);
  const locale = resolveLocale(localePref);
  const tr = (key: I18nKey, vars?: Record<string, string | number>) => translate(locale, key, vars);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(id);
  }, [notice]);

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
        const finalArgs =
          name !== 'deck_get_state' && DECK_SECRET ? { deckSecret: DECK_SECRET, ...args } : args;
        const res = await app.callServerTool({ name, arguments: finalArgs });
        const structured = res.structuredContent as ToolStructuredPayload | undefined;
        if (structured?.state) setDeckState(structured.state);
        if (structured?.pin && structured?.expiresAt) {
          setPairingPin({ pin: structured.pin, expiresAt: structured.expiresAt });
        }
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [app],
  );

  useEffect(() => {
    if (!localeDirty && deckState?.policy?.uiLocale) {
      setLocalePref(resolveLocale(deckState.policy.uiLocale));
    }
  }, [deckState?.policy?.uiLocale, localeDirty]);

  const handleLocaleChange = (next: LocalePreference) => {
    setLocaleDirty(true);
    setLocalePref(next);
    try {
      localStorage.setItem('cbmcp-deck-locale', next);
    } catch {
      // ignore sandboxed iframe storage errors
    }
    void callDeckTool('deck_update_policy', { uiLocale: next });
  };

  useEffect(() => {
    if (!isConnected || !app) return;
    void callDeckTool('deck_get_state');

    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const scheduleNext = () => {
      if (disposed) return;
      if (timer) clearTimeout(timer);
      // Poll faster while visible, drop to 10s idle cadence when hidden
      const delay = document.visibilityState === 'visible' ? 3000 : 10_000;
      timer = setTimeout(async () => {
        await callDeckTool('deck_get_state');
        scheduleNext();
      }, delay);
    };
    scheduleNext();

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void callDeckTool('deck_get_state');
      }
      scheduleNext();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [isConnected, app, callDeckTool]);

  const activeProfileId = deckState?.defaultProfileId ?? deckState?.profiles[0]?.profileId ?? '';
  const profileTabs = useMemo(
    () => (activeProfileId && deckState ? (deckState.tabs[activeProfileId] ?? []) : []),
    [activeProfileId, deckState],
  );

  const agentTabs = useMemo(() => profileTabs.filter((t) => t.inAgentGroup), [profileTabs]);

  const otherTabs = useMemo(() => {
    const q = tabQuery.trim().toLowerCase();
    const list = profileTabs.filter((t) => !t.inAgentGroup);
    if (!q) return list;
    return list.filter(
      (t) =>
        t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q) || String(t.tabId).includes(q),
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
    try {
      await app.sendMessage({
        role: 'user',
        content: [{ type: 'text', text: summary }],
      });
      setNotice('Sent diagnostics to conversation.');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };

  const handleAttachWorkflowToContext = async (wf: RecordedWorkflow) => {
    if (!app || !canUpdateContext) return;
    try {
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
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };

  const controlledCount = deckState.policy.scopeMode === 'all-tabs' ? profileTabs.length : agentTabs.length;

  const visibleErrors = deckState.recentErrors.filter((e) => !dismissedErrorIds.has(e.id));
  const visibleFailedNetwork = deckState.recentFailedNetwork.filter(
    (n) => !dismissedNetworkIds.has(n.requestId),
  );

  const handleClearDiagnostics = (target: 'console' | 'network') => {
    if (target === 'console') {
      setDismissedErrorIds((prev) => {
        const next = new Set(prev);
        for (const err of deckState.recentErrors) next.add(err.id);
        return next;
      });
    } else {
      setDismissedNetworkIds((prev) => {
        const next = new Set(prev);
        for (const net of deckState.recentFailedNetwork) next.add(net.requestId);
        return next;
      });
    }
    if (!app) return;
    void app
      .callServerTool({
        name: 'deck_clear_diagnostics',
        arguments: DECK_SECRET ? { deckSecret: DECK_SECRET, target } : { target },
      })
      .then((res) => {
        const structured = res.structuredContent as ToolStructuredPayload | undefined;
        if (structured?.state) setDeckState(structured.state);
      })
      .catch(() => {
        // Fallback: local dismissal already cleared the block even on older MCP stdio sessions
      });
  };

  const tabItems: Array<{ id: DeckTab; label: string }> = [
    { id: 'overview', label: `${tr('tab.overview')} (${controlledCount})` },
    { id: 'timeline', label: `${tr('tab.timeline')} (${deckState.recentActivity.length})` },
    {
      id: 'devtools',
      label: `${tr('tab.devtools')} (${visibleErrors.length + visibleFailedNetwork.length})`,
    },
    { id: 'workflows', label: `${tr('tab.workflows')} (${deckState.workflows.length})` },
    { id: 'security', label: tr('tab.security') },
  ];

  const renderTabRow = (t: TabInfo) => (
    <div key={t.tabId} className="item-row">
      <div className="item-meta">
        <div className="item-title">
          [{t.tabId}] {t.title || '(untitled)'} {t.active && <span className="pill">Active</span>}{' '}
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
          {t.inAgentGroup ? tr('btn.detach') : tr('btn.attach')}
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
          {tr('btn.focus')}
        </button>
      </div>
    </div>
  );

  return (
    <div className="deck">
      <header className="deck-header">
        <div className="deck-header-top">
          <div className="deck-title-group">
            <span className={`status-dot ${deckState.profiles.length > 0 ? 'ok' : ''}`} />
            <div>
              <div className="deck-title">{tr('app.deckTitle')}</div>
              <div className="muted">
                v{deckState.brokerVersion} · {deckState.profiles.length} {tr('label.profilesCount')} ·{' '}
                {profileTabs.length} {tr('label.tabsCount')}
              </div>
            </div>
          </div>
          <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
            <select
              className="select lang-select"
              aria-label={tr('setting.language')}
              value={locale}
              onChange={(e) => handleLocaleChange(e.target.value as LocalePreference)}
            >
              <option value="en">EN</option>
              <option value="ru">RU</option>
              <option value="zh-CN">中文</option>
            </select>
            <ThemeToggle />
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
            onClick={() => void callDeckTool('deck_create_pin')}
          >
            {tr('btn.generatePin')}
          </button>
          <button
            type="button"
            className="btn small"
            disabled={busy}
            onClick={() => void callDeckTool('deck_get_state')}
          >
            {tr('btn.refresh')}
          </button>
          <button
            type="button"
            className={`btn small ${deckState.paused ? 'primary' : 'danger'}`}
            onClick={() => void callDeckTool('deck_set_paused', { paused: !deckState.paused })}
          >
            {deckState.paused ? tr('btn.resume') : tr('btn.pauseAll')}
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

      {pairingPin && (
        <div className="toast-banner" role="status" aria-live="polite">
          <span className="toast-text">
            {tr('pair.pinTitle')}:{' '}
            <button
              type="button"
              className="btn small primary"
              style={{ marginLeft: 6, fontFamily: 'ui-monospace, monospace', letterSpacing: '0.14em' }}
              title={tr('status.clickToCopy')}
              onClick={() => {
                void navigator.clipboard?.writeText(pairingPin.pin).catch(() => {});
                setNotice(`${tr('status.copied')} (${pairingPin.pin})`);
              }}
            >
              {pairingPin.pin}
            </button>
          </span>
          <button
            type="button"
            className="toast-close"
            aria-label={tr('btn.dismiss')}
            onClick={() => setPairingPin(null)}
          >
            ×
          </button>
        </div>
      )}

      {notice && (
        <div className="toast-banner" role="status" aria-live="polite">
          <span className="toast-text">{notice}</span>
          <button
            type="button"
            className="toast-close"
            aria-label={tr('btn.dismiss')}
            onClick={() => setNotice(null)}
          >
            ×
          </button>
        </div>
      )}

      <main className="scroller deck-main">
        {/* OVERVIEW */}
        <section role="tabpanel" aria-labelledby="deck-tab-overview" hidden={activeTab !== 'overview'}>
          <div className="panel-inner panel-fill">
            {deckState.paused && (
              <div className="card danger">
                <strong>{tr('status.paused')}</strong>
                <div className="muted">{tr('status.pausedDesc')}</div>
              </div>
            )}

            {deckState.pendingApprovals.map((req) => (
              <div key={req.id} className="card warn">
                <div className="row-between">
                  <strong>
                    {tr('section.approvals')} — {req.action}
                  </strong>
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
                    {tr('btn.approve')}
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
                    {tr('btn.reject')}
                  </button>
                </div>
              </div>
            ))}

            {/* DEDICATED AI AGENT CONTROLLED TABS */}
            <div className="card agent-box">
              <div className="row-between">
                <strong>
                  {tr('section.agentTabs')} ({agentTabs.length})
                </strong>
              </div>
              {agentTabs.length === 0 ? (
                <div className="muted">{tr('empty.agentTabs')}</div>
              ) : (
                <div className="scroller agent-tabs-scroll">{agentTabs.map((t) => renderTabRow(t))}</div>
              )}
            </div>

            {deckState.latestScreenshot &&
              SAFE_IMAGE_DATA_URL_RE.test(deckState.latestScreenshot.dataUrl) && (
                <div className="card" style={{ flex: '0 0 auto' }}>
                  <div className="row-between">
                    <strong>{tr('section.latestCapture')}</strong>
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
                  {tr('section.otherTabs')} ({otherTabs.length}
                  {tabQuery ? ` / ${profileTabs.length - agentTabs.length}` : ''})
                </strong>
              </div>
              <input
                type="search"
                className="search-input"
                placeholder={tr('filter.tabsPlaceholder')}
                value={tabQuery}
                onChange={(e) => setTabQuery(e.target.value)}
              />
              {profileTabs.length === 0 ? (
                <div className="muted">
                  {tr('pair.brokerOffline')} — <code>http://127.0.0.1:43179/pair</code>
                </div>
              ) : (
                <VirtualList
                  items={otherTabs}
                  rowHeight={56}
                  fillHeight
                  getKey={(t) => t.tabId}
                  renderRow={(t) => renderTabRow(t)}
                  emptyState={<div className="muted">{tr('empty.matchingTabs')}</div>}
                />
              )}
            </div>
          </div>
        </section>

        {/* TIMELINE (DEDICATED TOP-LEVEL TAB) */}
        <section role="tabpanel" aria-labelledby="deck-tab-timeline" hidden={activeTab !== 'timeline'}>
          <div className="panel-inner panel-fill">
            <div className={`card ${deckState.recentActivity.length > 0 ? 'fill-card' : ''}`}>
              <div className="row-between">
                <strong>
                  {tr('tab.timeline')} ({deckState.recentActivity.length})
                </strong>
              </div>
              {deckState.recentActivity.length === 0 ? (
                <div className="muted">{tr('deck.waitingActions')}</div>
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
                      <span className={`pill ${ev.status === 'ok' ? 'accent' : 'danger'}`}>{ev.status}</span>
                    </div>
                  )}
                />
              )}
            </div>
          </div>
        </section>

        {/* DEVTOOLS */}
        <section role="tabpanel" aria-labelledby="deck-tab-devtools" hidden={activeTab !== 'devtools'}>
          <div className="panel-inner">
            <div className="card">
              <div className="row-between">
                <strong>{tr('section.consoleErrors')}</strong>
                {visibleErrors.length > 0 && (
                  <div className="row" style={{ gap: 6 }}>
                    <button
                      type="button"
                      className="btn small"
                      onClick={() => handleClearDiagnostics('console')}
                    >
                      {tr('btn.clear')}
                    </button>
                    {canSendMessage && (
                      <button
                        type="button"
                        className="btn primary small"
                        onClick={() =>
                          void handleSendDiagnosticsToAgent(
                            `Please investigate these browser console errors:\n${visibleErrors
                              .slice(0, 8)
                              .map((e) => `- [${e.level}] ${e.text} (${e.source ?? ''}:${e.line ?? ''})`)
                              .join('\n')}`,
                          )
                        }
                      >
                        {tr('btn.askAgentFix')}
                      </button>
                    )}
                  </div>
                )}
              </div>
              {visibleErrors.length === 0 ? (
                <div className="muted">{tr('empty.console')}</div>
              ) : (
                visibleErrors.map((errEntry) => (
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
                <strong>{tr('section.failedNetwork')}</strong>
                {visibleFailedNetwork.length > 0 && (
                  <div className="row" style={{ gap: 6 }}>
                    <button
                      type="button"
                      className="btn small"
                      onClick={() => handleClearDiagnostics('network')}
                    >
                      {tr('btn.clear')}
                    </button>
                    {canSendMessage && (
                      <button
                        type="button"
                        className="btn primary small"
                        onClick={() =>
                          void handleSendDiagnosticsToAgent(
                            `Please investigate these failed browser network requests:\n${visibleFailedNetwork
                              .slice(0, 8)
                              .map((n) => `- ${n.method} ${n.status ?? 'ERR'} ${n.url} ${n.errorText ?? ''}`)
                              .join('\n')}`,
                          )
                        }
                      >
                        {tr('btn.askAgentDebug')}
                      </button>
                    )}
                  </div>
                )}
              </div>
              {visibleFailedNetwork.length === 0 ? (
                <div className="muted">{tr('empty.network')}</div>
              ) : (
                visibleFailedNetwork.map((net) => (
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
        <section role="tabpanel" aria-labelledby="deck-tab-workflows" hidden={activeTab !== 'workflows'}>
          <div className="panel-inner">
            <div className="card">
              <strong>{tr('section.savedWorkflows')}</strong>
              <div className="muted">{tr('deck.workflowsDesc')}</div>
              {deckState.workflows.length === 0 ? (
                <div className="muted">{tr('empty.workflows')}</div>
              ) : (
                deckState.workflows.map((wf) => (
                  <div key={wf.id} className="item-row">
                    <div className="item-meta">
                      <div className="item-title">{wf.name}</div>
                      <div className="item-sub">
                        {wf.steps.length} {tr('label.steps')} · {wf.startUrl}
                      </div>
                    </div>
                    <div className="row">
                      {canUpdateContext && (
                        <button
                          type="button"
                          className="btn primary small"
                          onClick={() => void handleAttachWorkflowToContext(wf)}
                        >
                          {tr('btn.attachToAgent')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn small"
                        onClick={() => void callDeckTool('deck_delete_workflow', { workflowId: wf.id })}
                      >
                        {tr('btn.delete')}
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>

        {/* SECURITY */}
        <section role="tabpanel" aria-labelledby="deck-tab-security" hidden={activeTab !== 'security'}>
          <div className="panel-inner">
            <div className="card security-card">
              <strong>{tr('deck.securityTitle')}</strong>
              <div className="security-row">
                <span className="security-label-group">
                  <label htmlFor="sec-all-tabs">{tr('setting.allowAllTabs')}</label>
                  <InfoTip label={tr('setting.allowAllTabs')} text={tr('setting.allowAllTabsInfo')} />
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
                  <label htmlFor="sec-shield">{tr('setting.shield')}</label>
                  <InfoTip label={tr('setting.shield')} text={tr('setting.shieldInfo')} />
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
                  <label htmlFor="sec-eval">{tr('setting.approvalEval')}</label>
                  <InfoTip label={tr('setting.approvalEval')} text={tr('setting.approvalEvalInfo')} />
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
                  <label htmlFor="sec-pass">{tr('setting.approvalPasswords')}</label>
                  <InfoTip
                    label={tr('setting.approvalPasswords')}
                    text={tr('setting.approvalPasswordsInfo')}
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
                  <label htmlFor="sec-pay">{tr('setting.approvalPayments')}</label>
                  <InfoTip label={tr('setting.approvalPayments')} text={tr('setting.approvalPaymentsInfo')} />
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

              <div className="security-row">
                <span className="security-label-group">
                  <label htmlFor="sec-upload">{tr('setting.approvalUploads')}</label>
                  <InfoTip label={tr('setting.approvalUploads')} text={tr('setting.approvalUploadsInfo')} />
                </span>
                <input
                  id="sec-upload"
                  type="checkbox"
                  checked={deckState.policy.requireApprovalForUploads}
                  onChange={(e) =>
                    void callDeckTool('deck_update_policy', {
                      requireApprovalForUploads: e.target.checked,
                    })
                  }
                />
              </div>
            </div>

            {/* COLLAPSIBLE ADVANCED SETTINGS */}
            <details className="advanced-box">
              <summary>{tr('section.advancedSettings')}</summary>
              <div className="advanced-body">
                <div>
                  <span className="security-label-group">
                    <strong>{tr('setting.readOnlyDomains')}</strong>
                    <InfoTip label={tr('setting.readOnlyDomains')} text={tr('setting.readOnlyInfo')} />
                  </span>
                  <div className="muted" style={{ marginBottom: 6 }}>
                    {tr('setting.readOnlyHint')}
                  </div>
                  <div className="preset-chips">
                    {READ_ONLY_DOMAIN_PRESETS.map((domain) => {
                      const active = deckState.policy.readOnlyDomains.includes(domain);
                      return (
                        <button
                          key={domain}
                          type="button"
                          className={`preset-chip ${active ? 'active' : ''}`}
                          onClick={() => {
                            const cur = deckState.policy.readOnlyDomains;
                            const next = active ? cur.filter((d) => d !== domain) : [...cur, domain];
                            void callDeckTool('deck_update_policy', { readOnlyDomains: next });
                          }}
                        >
                          {active ? '✓ ' : '+ '}
                          {domain}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="security-row">
                  <span className="security-label-group">
                    <label htmlFor="sec-dialog">{tr('setting.dialogPolicy')}</label>
                    <InfoTip label={tr('setting.dialogPolicy')} text={tr('setting.dialogPolicyInfo')} />
                  </span>
                  <select
                    id="sec-dialog"
                    className="select"
                    style={{ width: 'auto' }}
                    value={deckState.policy.dialogPolicy}
                    onChange={(e) =>
                      void callDeckTool('deck_update_policy', {
                        dialogPolicy: e.target.value,
                      })
                    }
                  >
                    <option value="ask-agent">{tr('setting.dialogAsk')}</option>
                    <option value="auto-dismiss">{tr('setting.dialogDismiss')}</option>
                    <option value="approval">{tr('setting.dialogApproval')}</option>
                  </select>
                </div>

                <div className="security-row">
                  <span className="security-label-group">
                    <label htmlFor="sec-cdp-proxy">{tr('setting.cdpProxy')}</label>
                    <InfoTip label={tr('setting.cdpProxy')} text={tr('setting.cdpProxyDesc')} />
                  </span>
                  <input
                    id="sec-cdp-proxy"
                    type="checkbox"
                    checked={deckState.policy.cdpProxyEnabled}
                    onChange={(e) =>
                      void callDeckTool('deck_update_policy', {
                        cdpProxyEnabled: e.target.checked,
                      })
                    }
                  />
                </div>

                <div className="security-row" style={{ alignItems: 'flex-start' }}>
                  <div className="muted">
                    {tr('deck.blockedSummary')} ({deckState.policy.blockedDomains.length}):{' '}
                    {deckState.policy.blockedDomains.slice(0, 6).join(', ')}
                    {deckState.policy.blockedDomains.length > 6 ? '…' : ''}
                  </div>
                  <InfoTip label={tr('deck.blockedSummary')} text={tr('setting.blockedDomainsInfo')} />
                </div>
              </div>
            </details>
          </div>
        </section>
      </main>
    </div>
  );
}
