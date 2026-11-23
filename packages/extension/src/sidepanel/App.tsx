import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  exportWorkflowToPlaywright,
  extractWorkflowParamNames,
  READ_ONLY_DOMAIN_PRESETS,
  resolveLocale,
  translate,
  type I18nKey,
  type LocalePreference,
  type RecordedStep,
  type RecordedWorkflow,
  type TabInfo,
} from '@chrome-browser-mcp/protocol';
import type { ExtensionRuntimeState, ExtensionSettings } from '../shared/storage.js';
import { VirtualList } from './VirtualList.js';
import { InfoTip } from './InfoTip.js';
import { ThemeToggle, type ThemeOverride } from './ThemeToggle.js';
import { OnboardingTour, SIDE_PANEL_TOUR_STEPS } from './OnboardingTour.js';
import { CopyableCode } from './CopyableCode.js';

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

function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function App() {
  const [data, setData] = useState<SidePanelPayload | null>(null);
  const [activeTab, setActiveTab] = useState<PanelTab>('control');
  const [tabQuery, setTabQuery] = useState('');
  const [workflowName, setWorkflowName] = useState('');
  const [wsUrlDraft, setWsUrlDraft] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [labelDraft, setLabelDraft] = useState('');
  const [pinDraft, setPinDraft] = useState('');
  const [blockedDraft, setBlockedDraft] = useState('');
  const [readOnlyDraft, setReadOnlyDraft] = useState('');
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [tourStep, setTourStep] = useState<number | null>(null);
  const [hasDownloadsPerm, setHasDownloadsPerm] = useState(false);
  const [hasNativePerm, setHasNativePerm] = useState(false);
  const [brokerDetected, setBrokerDetected] = useState<boolean | null>(null);

  const checkOptionalPerms = useCallback(async () => {
    try {
      const [dl, nm] = await Promise.all([
        chrome.permissions.contains({ permissions: ['downloads'] }),
        chrome.permissions.contains({ permissions: ['nativeMessaging'] }),
      ]);
      setHasDownloadsPerm(dl);
      setHasNativePerm(nm);
    } catch {
      // ignore in non-extension preview
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const payload = await sendSw<SidePanelPayload>({ type: 'sp.getState' });
      setData(payload);
      if (payload.runtime.connected) {
        setStatusMsg((prev) => (prev?.includes('reconnecting') ? null : prev));
        setBrokerDetected(true);
      } else {
        const httpBase = payload.settings.wsUrl
          .replace(/^ws:/i, 'http:')
          .replace(/^wss:/i, 'https:')
          .replace(/\/ws\/?$/, '');
        fetch(`${httpBase}/health`, { signal: AbortSignal.timeout(800) })
          .then((r) => setBrokerDetected(r.ok))
          .catch(() => setBrokerDetected(false));
      }
      setWsUrlDraft((prev) => prev || payload.settings.wsUrl);
      setTokenDraft((prev) => prev || payload.settings.token);
      setLabelDraft((prev) => prev || payload.settings.profileLabel);
      setBlockedDraft((prev) => prev || payload.settings.policy.blockedDomains.join('\n'));
      setReadOnlyDraft((prev) => prev || payload.settings.policy.readOnlyDomains.join('\n'));
      if (payload.settings.sidePanelTourPending) {
        setTourStep((cur) => (cur === null ? 0 : cur));
      }
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    void checkOptionalPerms();

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
  }, [refresh, checkOptionalPerms]);

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
  const locale = resolveLocale(settings.locale);
  const t = (key: I18nKey) => translate(locale, key);
  const isRecording = runtime.recordingTabId !== null;
  const pendingDialogs = Object.values(runtime.pendingDialogs ?? {});
  const brokerHttpBase = settings.wsUrl
    .replace(/^ws:/i, 'http:')
    .replace(/^wss:/i, 'https:')
    .replace(/\/ws\/?$/, '');

  const handleThemePersist = async (next: ThemeOverride) => {
    await sendSw({ type: 'sp.saveSettings', patch: { theme: next }, reconnect: false });
    await refresh();
  };

  const handleLocaleChange = async (next: LocalePreference) => {
    await sendSw({ type: 'sp.saveSettings', patch: { locale: next }, reconnect: false });
    await refresh();
  };

  const handleVisualHudToggle = async (enabled: boolean) => {
    await sendSw({ type: 'sp.setVisualHud', enabled });
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

  const handleDialogAction = async (tabId: number, accept: boolean) => {
    await sendSw({ type: 'sp.handleDialog', tabId, accept });
    await refresh();
  };

  const handlePairPin = async () => {
    if (pinDraft.trim().length < 6) return;
    try {
      await sendSw({
        type: 'sp.pairWithPin',
        pin: pinDraft.trim(),
        profileLabel: labelDraft.trim() || 'default',
      });
      setPinDraft('');
      setStatusMsg(t('pair.pairedOk'));
      await refresh();
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : String(err));
    }
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
    setStatusMsg(t('pair.savedReconnecting'));
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

  const handleSaveReadOnly = async () => {
    const readOnlyDomains = readOnlyDraft
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    await handlePolicyPatch({ readOnlyDomains });
    setStatusMsg(`Saved ${readOnlyDomains.length} read-only domain rule(s).`);
  };

  const handleToggleReadOnlyPreset = async (domain: string) => {
    const cur = settings.policy.readOnlyDomains;
    const next = cur.includes(domain) ? cur.filter((d) => d !== domain) : [...cur, domain];
    setReadOnlyDraft(next.join('\n'));
    await handlePolicyPatch({ readOnlyDomains: next });
  };

  const handleToggleOptionalPerm = async (perm: 'downloads' | 'nativeMessaging', enable: boolean) => {
    try {
      if (enable) {
        const granted = await chrome.permissions.request({ permissions: [perm] });
        if (granted && perm === 'nativeMessaging') {
          await sendSw({
            type: 'sp.saveSettings',
            patch: { nativeMessagingEnabled: true },
            reconnect: true,
          });
        }
      } else {
        await chrome.permissions.remove({ permissions: [perm] });
        if (perm === 'nativeMessaging') {
          await sendSw({
            type: 'sp.saveSettings',
            patch: { nativeMessagingEnabled: false },
            reconnect: true,
          });
        }
      }
      await checkOptionalPerms();
      await refresh();
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : String(err));
    }
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

  const handleExportPlaywright = (wf: RecordedWorkflow) => {
    const code = exportWorkflowToPlaywright(wf);
    const slug = wf.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || wf.id;
    downloadTextFile(`${slug}.spec.ts`, code, 'text/typescript;charset=utf-8');
  };

  const handleExportTimeline = (format: 'json' | 'html') => {
    const exportedAt = new Date().toISOString();
    if (format === 'json') {
      downloadTextFile(
        `chrome-browser-mcp-timeline.json`,
        JSON.stringify({ exportedAt, profile: settings.profileLabel, events: runtime.recentActivity }, null, 2),
        'application/json;charset=utf-8',
      );
      return;
    }
    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const items = runtime.recentActivity
      .map(
        (ev) =>
          `<div style="border:1px solid #2a2f3a;border-radius:10px;padding:10px 12px;margin-bottom:8px;">
            <strong>${esc(ev.tool)}</strong> <span>[${esc(ev.status)}]</span>
            <div style="color:#9aa3b2;font-size:12px;">${esc(ev.summary)}${ev.durationMs !== undefined ? ` · ${ev.durationMs}ms` : ''}</div>
          </div>`,
      )
      .join('\n');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Chrome Browser MCP Audit</title></head><body style="background:#111317;color:#e6e9ef;font:14px/1.5 system-ui,sans-serif;padding:24px;"><h2>Chrome Browser MCP — Session Audit (${esc(exportedAt)})</h2>${items || '<p>No events recorded.</p>'}</body></html>`;
    downloadTextFile('chrome-browser-mcp-timeline.html', html, 'text/html;charset=utf-8');
  };

  const handleTourStepChange = (nextIdx: number) => {
    setTourStep(nextIdx);
    const target = SIDE_PANEL_TOUR_STEPS[nextIdx]?.targetTab;
    if (target) setActiveTab(target);
  };

  const handleTourClose = async () => {
    setTourStep(null);
    await sendSw({
      type: 'sp.saveSettings',
      patch: { onboardingCompleted: true, sidePanelTourPending: false },
      reconnect: false,
    });
    await refresh();
  };

  const handleReplayTour = () => {
    setActiveTab('control');
    setTourStep(0);
  };

  const tabItems: Array<{ id: PanelTab; label: string }> = [
    { id: 'control', label: `${t('tab.control')} (${attachedTabs.length})` },
    { id: 'timeline', label: `${t('tab.timeline')} (${runtime.recentActivity.length})` },
    { id: 'workflows', label: `${t('tab.recorder')} (${workflows.length})` },
    { id: 'security', label: t('tab.security') },
    { id: 'connect', label: runtime.connected ? t('status.connected') : t('tab.connect') },
  ];

  const renderTabRow = (tab: TabInfo) => (
    <div key={tab.tabId} className="tab-row">
      <div className="tab-meta">
        <div className="tab-title">
          {tab.title || '(untitled)'}{' '}
          {tab.cdpAttached && <span className="pill accent">CDP</span>}
        </div>
        <div className="tab-url">{tab.url}</div>
      </div>
      <button
        type="button"
        className={`btn small ${tab.inAgentGroup ? '' : 'primary'}`}
        onClick={() => void handleToggleTab(tab.tabId, !tab.inAgentGroup)}
      >
        {tab.inAgentGroup ? t('btn.detach') : t('btn.attach')}
      </button>
    </div>
  );

  return (
    <div className="app-shell">
      <header className="header">
        <div className="brand">
          <span className={`brand-dot ${runtime.connected ? 'online' : ''}`} />
          <div>
            <div className="brand-title">{t('app.title')}</div>
            <div className="brand-sub">
              {settings.browserName} · {settings.profileLabel} · {tabs.length} {t('label.tabsCount')}
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
            {runtime.paused ? t('btn.resume') : t('btn.pause')}
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

      {tourStep !== null && (
        <OnboardingTour
          stepIndex={tourStep}
          locale={locale}
          onStepChange={handleTourStepChange}
          onClose={() => void handleTourClose()}
        />
      )}

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
                <div className="card-title">{t('status.paused')}</div>
                <div className="muted">
                  {t('status.pausedDesc')} (<kbd className="kbd-chip">Alt+Shift+P</kbd>)
                </div>
              </div>
            )}

            {!runtime.connected && (
              <div className="card approval">
                <div className="card-title">{t('status.offline')}</div>
                <div className="inline-hint">
                  <span>{t('pair.pinHintPrefix')}</span>
                  <CopyableCode code="pnpm pair" locale={locale} />
                  <span>{t('pair.pinHintSuffix')}</span>
                </div>
                <button
                  type="button"
                  className="btn primary small"
                  onClick={() => setActiveTab('connect')}
                >
                  {t('pair.pinButton')}
                </button>
              </div>
            )}

            {pendingDialogs.map((dlg) => (
              <div key={`dlg-${dlg.tabId}`} className="card approval">
                <div className="card-header">
                  <span className="card-title">{t('section.pendingDialog')}</span>
                  <span className="pill warn">{dlg.type.toUpperCase()}</span>
                </div>
                <div className="muted">{dlg.message}</div>
                <div className="row">
                  <button
                    type="button"
                    className="btn primary small"
                    onClick={() => void handleDialogAction(dlg.tabId, true)}
                  >
                    {t('btn.accept')}
                  </button>
                  <button
                    type="button"
                    className="btn danger small"
                    onClick={() => void handleDialogAction(dlg.tabId, false)}
                  >
                    {t('btn.dismiss')}
                  </button>
                </div>
              </div>
            ))}

            {runtime.pendingApprovals.map((req) => (
              <div key={req.id} className="card approval">
                <div className="card-header">
                  <span className="card-title">{t('section.approvals')}</span>
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
                    {t('btn.approve')}
                  </button>
                  <button
                    type="button"
                    className="btn danger small"
                    onClick={() => void handleApproval(req.id, 'rejected')}
                  >
                    {t('btn.reject')}
                  </button>
                </div>
              </div>
            ))}

            {/* DEDICATED AI AGENT TABS BLOCK */}
            <div className="card agent-box">
              <div className="card-header">
                <span className="card-title">
                  {t('section.agentTabs')} ({attachedTabs.length})
                </span>
                <button type="button" className="btn primary small" onClick={handleAttachCurrent}>
                  {t('btn.attachActive')}
                </button>
              </div>
              <label className="toggle-label">
                <span>{t('setting.allowAllTabs')}</span>
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
                <div className="muted">{t('empty.agentTabs')}</div>
              ) : (
                <div className="scroller agent-tabs-scroll">
                  {attachedTabs.map((item) => renderTabRow(item))}
                </div>
              )}
            </div>

            {/* ALL OTHER BROWSER TABS (ADAPTIVE HEIGHT) */}
            <div className={`card ${otherTabs.length > 0 ? 'fill-card' : ''}`}>
              <div className="card-header">
                <span className="card-title">
                  {t('section.otherTabs')} ({otherTabs.length}
                  {tabQuery ? ` / ${tabs.length - attachedTabs.length}` : ''})
                </span>
              </div>
              <input
                type="search"
                className="search-input"
                placeholder={t('filter.tabsPlaceholder')}
                value={tabQuery}
                onChange={(e) => setTabQuery(e.target.value)}
              />
              <VirtualList
                items={otherTabs}
                rowHeight={52}
                fillHeight
                getKey={(item) => item.tabId}
                renderRow={(item) => renderTabRow(item)}
                emptyState={<div className="muted">{t('empty.matchingTabs')}</div>}
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
                <span className="card-title">{t('tab.timeline')}</span>
                <div className="row">
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => handleExportTimeline('json')}
                  >
                    {t('btn.exportJson')}
                  </button>
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => handleExportTimeline('html')}
                  >
                    {t('btn.exportHtml')}
                  </button>
                </div>
              </div>
              {runtime.recentActivity.length === 0 ? (
                <div className="muted">{t('empty.timeline')}</div>
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
                <span className="card-title">{t('tab.recorder')}</span>
                {isRecording ? (
                  <span className="pill warn">REC ({recordingSteps.length})</span>
                ) : (
                  <span className="pill">{t('status.idle')}</span>
                )}
              </div>
              <div className="muted">{t('recorder.varsHint')}</div>
              {!isRecording ? (
                <button type="button" className="btn primary" onClick={handleStartRecording}>
                  {t('recorder.start')}
                </button>
              ) : (
                <>
                  <input
                    className="input"
                    placeholder={t('recorder.namePlaceholder')}
                    value={workflowName}
                    onChange={(e) => setWorkflowName(e.target.value)}
                  />
                  <div className="row">
                    <button
                      type="button"
                      className="btn primary"
                      onClick={() => void handleStopRecording(true)}
                    >
                      {t('recorder.stop')} ({recordingSteps.length})
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void handleStopRecording(false)}
                    >
                      {t('btn.discard')}
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
              <div className="card-title">{t('section.savedWorkflows')}</div>
              {workflows.length === 0 ? (
                <div className="muted">{t('empty.workflows')}</div>
              ) : (
                <div className="list">
                  {workflows.map((wf) => {
                    const paramNames = extractWorkflowParamNames(wf);
                    return (
                      <div key={wf.id} className="tab-row">
                        <div className="tab-meta">
                          <div className="tab-title">
                            {wf.name}{' '}
                            {paramNames.length > 0 && (
                              <span className="pill accent">
                                {paramNames.length} {t('label.vars')}
                              </span>
                            )}
                          </div>
                          <div className="tab-url">
                            {wf.steps.length} {t('label.steps')} · {wf.startUrl}
                          </div>
                        </div>
                        <div className="row">
                          <button
                            type="button"
                            className="btn small"
                            onClick={() => handleExportPlaywright(wf)}
                          >
                            {t('btn.exportPlaywright')}
                          </button>
                          <button
                            type="button"
                            className="btn small"
                            onClick={() => void handleDeleteWorkflow(wf.id)}
                          >
                            {t('btn.delete')}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* SECURITY & SETTINGS TAB (with Progressive Disclosure Advanced Settings) */}
        <section
          role="tabpanel"
          aria-labelledby="tab-security"
          hidden={activeTab !== 'security'}
        >
          <div className="tab-panel-inner">
            <div className="card security-card">
              <div className="card-title">{t('tab.security')}</div>

              {/* Optional Visual Agent Cursor & HUD (ON by default) */}
              <div className="security-row">
                <span className="security-label-group">
                  <label htmlFor="sp-sec-hud">{t('setting.visualHud')}</label>
                  <InfoTip
                    label={t('setting.visualHud')}
                    text={t('setting.visualHudDesc')}
                  />
                </span>
                <input
                  id="sp-sec-hud"
                  type="checkbox"
                  checked={settings.visualHudEnabled}
                  onChange={(e) => void handleVisualHudToggle(e.target.checked)}
                />
              </div>

              <div className="security-row">
                <span className="security-label-group">
                  <label htmlFor="sp-sec-shield">{t('setting.shield')}</label>
                  <InfoTip label={t('setting.shield')} text={t('setting.shieldInfo')} />
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
                  <label htmlFor="sp-sec-eval">{t('setting.approvalEval')}</label>
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
                  <label htmlFor="sp-sec-pass">{t('setting.approvalPasswords')}</label>
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
                  <label htmlFor="sp-sec-pay">{t('setting.approvalPayments')}</label>
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

              <div className="security-row">
                <span className="security-label-group">
                  <label htmlFor="sp-sec-upload">{t('setting.approvalUploads')}</label>
                </span>
                <input
                  id="sp-sec-upload"
                  type="checkbox"
                  checked={settings.policy.requireApprovalForUploads}
                  onChange={(e) =>
                    void handlePolicyPatch({ requireApprovalForUploads: e.target.checked })
                  }
                />
              </div>

              <div className="security-row">
                <label htmlFor="sp-sec-lang">{t('setting.language')}</label>
                <select
                  id="sp-sec-lang"
                  className="input"
                  style={{ width: 'auto', minWidth: 112 }}
                  value={locale}
                  onChange={(e) => void handleLocaleChange(e.target.value as LocalePreference)}
                >
                  <option value="en">English</option>
                  <option value="ru">Русский</option>
                  <option value="zh-CN">简体中文</option>
                </select>
              </div>

              <div className="row">
                <button type="button" className="btn small" onClick={handleReplayTour}>
                  {t('btn.replayTour')}
                </button>
                <button
                  type="button"
                  className="btn small"
                  onClick={() => void sendSw({ type: 'sp.openWelcome' })}
                >
                  {t('btn.openWelcome')}
                </button>
              </div>
            </div>

            {/* COLLAPSIBLE ADVANCED SETTINGS */}
            <details className="advanced-box">
              <summary>{t('section.advancedSettings')}</summary>
              <div className="advanced-body">
                <div>
                  <div className="card-title">{t('setting.readOnlyDomains')}</div>
                  <div className="muted" style={{ marginBottom: 6 }}>
                    {t('setting.readOnlyHint')}
                  </div>
                  <div className="preset-chips" style={{ marginBottom: 6 }}>
                    {READ_ONLY_DOMAIN_PRESETS.map((domain) => {
                      const active = settings.policy.readOnlyDomains.includes(domain);
                      return (
                        <button
                          key={domain}
                          type="button"
                          className={`preset-chip ${active ? 'active' : ''}`}
                          onClick={() => void handleToggleReadOnlyPreset(domain)}
                        >
                          {active ? '✓ ' : '+ '}
                          {domain}
                        </button>
                      );
                    })}
                  </div>
                  <textarea
                    className="textarea"
                    rows={3}
                    value={readOnlyDraft}
                    onChange={(e) => setReadOnlyDraft(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn small"
                    style={{ marginTop: 6 }}
                    onClick={() => void handleSaveReadOnly()}
                  >
                    {t('btn.save')}
                  </button>
                </div>

                <div>
                  <div className="card-title">{t('setting.blockedDomains')}</div>
                  <textarea
                    className="textarea"
                    rows={4}
                    value={blockedDraft}
                    onChange={(e) => setBlockedDraft(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn small"
                    style={{ marginTop: 6 }}
                    onClick={() => void handleSaveBlocklist()}
                  >
                    {t('btn.save')}
                  </button>
                </div>

                <div className="security-row">
                  <label htmlFor="sp-adv-dialog">{t('setting.dialogPolicy')}</label>
                  <select
                    id="sp-adv-dialog"
                    className="input"
                    style={{ width: 'auto' }}
                    value={settings.policy.dialogPolicy}
                    onChange={(e) =>
                      void handlePolicyPatch({
                        dialogPolicy: e.target.value as ExtensionSettings['policy']['dialogPolicy'],
                      })
                    }
                  >
                    <option value="ask-agent">{t('setting.dialogAsk')}</option>
                    <option value="auto-dismiss">{t('setting.dialogDismiss')}</option>
                    <option value="approval">{t('setting.dialogApproval')}</option>
                  </select>
                </div>

                <div className="security-row">
                  <label htmlFor="sp-adv-cdp-idle">{t('setting.cdpDetach')}</label>
                  <input
                    id="sp-adv-cdp-idle"
                    type="number"
                    min={10}
                    max={600}
                    className="input"
                    style={{ width: 84 }}
                    value={settings.policy.cdpIdleDetachSec}
                    onChange={(e) =>
                      void handlePolicyPatch({
                        cdpIdleDetachSec: Math.max(10, Math.min(600, Number(e.target.value) || 60)),
                      })
                    }
                  />
                </div>

                <div className="security-row">
                  <span className="security-label-group">
                    <label htmlFor="sp-adv-cdp-proxy">{t('setting.cdpProxy')}</label>
                    <InfoTip label={t('setting.cdpProxy')} text={t('setting.cdpProxyDesc')} />
                  </span>
                  <input
                    id="sp-adv-cdp-proxy"
                    type="checkbox"
                    checked={settings.policy.cdpProxyEnabled}
                    onChange={(e) =>
                      void handlePolicyPatch({ cdpProxyEnabled: e.target.checked })
                    }
                  />
                </div>

                <div className="card-title" style={{ marginTop: 4 }}>
                  {t('section.optionalPermissions')}
                </div>
                <div className="security-row">
                  <label htmlFor="sp-perm-dl">{t('setting.downloadsPerm')}</label>
                  <input
                    id="sp-perm-dl"
                    type="checkbox"
                    checked={hasDownloadsPerm}
                    onChange={(e) => void handleToggleOptionalPerm('downloads', e.target.checked)}
                  />
                </div>
                <div className="security-row">
                  <label htmlFor="sp-perm-nm">{t('setting.nativeHostPerm')}</label>
                  <input
                    id="sp-perm-nm"
                    type="checkbox"
                    checked={hasNativePerm}
                    onChange={(e) =>
                      void handleToggleOptionalPerm('nativeMessaging', e.target.checked)
                    }
                  />
                </div>
              </div>
            </details>

            {statusMsg && <div className="muted">{statusMsg}</div>}
          </div>
        </section>

        {/* PAIR / CONNECT TAB (with Progressive Disclosure Advanced Connection) */}
        <section
          role="tabpanel"
          aria-labelledby="tab-connect"
          hidden={activeTab !== 'connect'}
        >
          <div className="tab-panel-inner">
            <div className="card">
              <div className="card-header">
                <span className="card-title">{t('pair.pinTitle')}</span>
                <span className={`pill ${runtime.connected || brokerDetected ? 'accent' : 'warn'}`}>
                  {runtime.connected
                    ? t('status.connected')
                    : brokerDetected
                      ? '127.0.0.1 OK'
                      : t('status.offline')}
                </span>
              </div>
              <div className="inline-hint">
                <span>{t('pair.pinHintPrefix')}</span>
                <CopyableCode code="pnpm pair" locale={locale} />
                <span>{t('pair.pinHintSuffix')}</span>
              </div>
              {brokerDetected && (
                <div className="row">
                  <button
                    type="button"
                    className="btn small"
                    onClick={() =>
                      void chrome.tabs.create({ url: `${brokerHttpBase}/pair`, active: true })
                    }
                  >
                    {t('btn.openPairPage')}
                  </button>
                </div>
              )}
              <div className="pin-row">
                <input
                  className="input pin-input"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder={t('pair.pinPlaceholder')}
                  value={pinDraft}
                  onChange={(e) => setPinDraft(e.target.value.replace(/\D/g, '').slice(0, 6))}
                />
                <button
                  type="button"
                  className="btn primary"
                  disabled={pinDraft.length < 6}
                  onClick={() => void handlePairPin()}
                >
                  {t('pair.pinButton')}
                </button>
              </div>
              <label className="muted">
                {t('pair.profileLabel')}
                <input
                  className="input"
                  value={labelDraft}
                  onChange={(e) => setLabelDraft(e.target.value)}
                />
              </label>
            </div>

            <details className="advanced-box">
              <summary>{t('section.advancedConnection')}</summary>
              <div className="advanced-body">
                <label className="muted">
                  {t('pair.wsUrl')}
                  <input
                    className="input"
                    value={wsUrlDraft}
                    onChange={(e) => setWsUrlDraft(e.target.value)}
                  />
                </label>
                <div className="inline-hint">
                  <span>{t('pair.token')}:</span>
                  <CopyableCode code="pnpm token" locale={locale} />
                </div>
                <input
                  className="input"
                  type="password"
                  placeholder={t('pair.tokenPlaceholder')}
                  value={tokenDraft}
                  onChange={(e) => setTokenDraft(e.target.value)}
                />
                <button type="button" className="btn primary small" onClick={handleSaveConnection}>
                  {t('pair.saveConnect')}
                </button>
              </div>
            </details>

            {statusMsg && <div className="muted">{statusMsg}</div>}
          </div>
        </section>
      </main>
    </div>
  );
}
