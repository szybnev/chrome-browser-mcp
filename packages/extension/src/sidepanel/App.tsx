import {
  exportWorkflowToPlaywright,
  extractWorkflowParamNames,
  getPauseShortcut,
  type I18nKey,
  type LocalePreference,
  READ_ONLY_DOMAIN_PRESETS,
  type RecordedStep,
  type RecordedWorkflow,
  resolveLocale,
  type TabInfo,
  translate,
  validateCdpIdleSeconds,
  validateDomainRules,
  validatePairingPin,
  validatePairingToken,
  validateProfileLabel,
  validateWorkflowName,
  validateWsUrl,
} from '@chrome-browser-mcp/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ExtensionRuntimeState, ExtensionSettings } from '../shared/storage.js';
import { CopyableCode } from './CopyableCode.js';
import { InfoTip } from './InfoTip.js';
import { OnboardingTour, SIDE_PANEL_TOUR_STEPS } from './OnboardingTour.js';
import { type ThemeOverride, ThemeToggle } from './ThemeToggle.js';
import { VirtualList } from './VirtualList.js';

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
  const [cdpIdleDraft, setCdpIdleDraft] = useState('60');
  const [readOnlyError, setReadOnlyError] = useState<string | null>(null);
  const [blockedError, setBlockedError] = useState<string | null>(null);
  const [cdpIdleError, setCdpIdleError] = useState<string | null>(null);
  const [workflowNameError, setWorkflowNameError] = useState<string | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [connError, setConnError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [timelineExported, setTimelineExported] = useState(false);
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
      setCdpIdleDraft(String(payload.settings.policy.cdpIdleDetachSec));
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

  useEffect(() => {
    if (!statusMsg) return;
    const id = setTimeout(() => setStatusMsg(null), 5000);
    return () => clearTimeout(id);
  }, [statusMsg]);

  const attachedTabs = useMemo(() => (data ? data.tabs.filter((t) => t.inAgentGroup) : []), [data]);

  const otherTabs = useMemo(() => {
    if (!data) return [];
    const q = tabQuery.trim().toLowerCase();
    const list = data.tabs.filter((t) => !t.inAgentGroup);
    if (!q) return list;
    return list.filter(
      (t) =>
        t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q) || String(t.tabId).includes(q),
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
  const t = (key: I18nKey, vars?: Record<string, string | number>) => translate(locale, key, vars);
  const pauseShortcut = getPauseShortcut();
  const isRecording = runtime.recordingTabId !== null;
  const pendingDialogs = Object.values(runtime.pendingDialogs ?? {});
  const brokerHttpBase = settings.wsUrl
    .replace(/^ws:/i, 'http:')
    .replace(/^wss:/i, 'https:')
    .replace(/\/ws\/?$/, '');

  const handleThemePersist = async (next: ThemeOverride) => {
    try {
      await sendSw({ type: 'sp.saveSettings', patch: { theme: next }, reconnect: false });
      await refresh();
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleLocaleChange = async (next: LocalePreference) => {
    try {
      await sendSw({ type: 'sp.saveSettings', patch: { locale: next }, reconnect: false });
      await refresh();
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleVisualHudToggle = async (enabled: boolean) => {
    try {
      await sendSw({ type: 'sp.setVisualHud', enabled });
      await refresh();
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleTogglePause = async () => {
    try {
      await sendSw({ type: 'sp.setPaused', paused: !runtime.paused });
      await refresh();
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleAttachCurrent = async () => {
    try {
      await sendSw({ type: 'sp.attachCurrentTab' });
      await refresh();
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleToggleTab = async (tabId: number, attach: boolean) => {
    try {
      await sendSw({ type: 'sp.toggleTab', tabId, attach });
      await refresh();
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleApproval = async (approvalId: string, decision: 'approved' | 'rejected') => {
    try {
      await sendSw({ type: 'sp.resolveApproval', approvalId, decision });
      await refresh();
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDialogAction = async (tabId: number, accept: boolean) => {
    try {
      await sendSw({ type: 'sp.handleDialog', tabId, accept });
      await refresh();
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePairPin = async () => {
    setPinError(null);
    const pinCheck = validatePairingPin(pinDraft);
    if (!pinCheck.ok || !pinCheck.normalized) {
      setPinError(t('val.pinInvalid'));
      return;
    }
    try {
      await sendSw({
        type: 'sp.pairWithPin',
        pin: pinCheck.normalized,
        profileLabel: labelDraft.trim() || 'default',
      });
      setPinDraft('');
      setStatusMsg(t('pair.pairedOk'));
      await refresh();
      setTimeout(() => setActiveTab('control'), 650);
    } catch (err) {
      setPinError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSaveConnection = async () => {
    setConnError(null);
    const labelCheck = validateProfileLabel(labelDraft);
    if (!labelCheck.ok || !labelCheck.normalized) {
      setConnError(
        labelCheck.errorCode === 'length'
          ? t('val.labelLength')
          : labelCheck.errorCode === 'chars'
            ? t('val.labelChars')
            : t('val.labelEmpty'),
      );
      return;
    }
    const wsCheck = validateWsUrl(wsUrlDraft);
    if (!wsCheck.ok || !wsCheck.normalized) {
      setConnError(
        wsCheck.errorCode === 'protocol'
          ? t('val.wsUrlProtocol')
          : wsCheck.errorCode === 'loopback'
            ? t('val.wsUrlLoopback')
            : t('val.wsUrlInvalid'),
      );
      return;
    }
    const tokenCheck = validatePairingToken(tokenDraft);
    if (!tokenCheck.ok || !tokenCheck.normalized) {
      setConnError(
        tokenCheck.errorCode === 'whitespace'
          ? t('val.tokenWhitespace')
          : tokenCheck.errorCode === 'too_short'
            ? t('val.tokenShort')
            : t('val.tokenEmpty'),
      );
      return;
    }
    try {
      await sendSw({
        type: 'sp.saveSettings',
        patch: {
          wsUrl: wsCheck.normalized,
          token: tokenCheck.normalized,
          profileLabel: labelCheck.normalized,
        },
        reconnect: true,
      });
      setStatusMsg(t('pair.savedReconnecting'));
      await refresh();
      setTimeout(() => setActiveTab('control'), 650);
    } catch (err) {
      setConnError(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePolicyPatch = async (patch: Partial<ExtensionSettings['policy']>) => {
    try {
      await sendSw({
        type: 'sp.saveSettings',
        patch: { policy: { ...settings.policy, ...patch } },
        reconnect: false,
      });
      await refresh();
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const formatDomainError = (issues: ReturnType<typeof validateDomainRules>['issues']): string => {
    const first = issues[0]!;
    return t(first.kind === 'whitespace_or_comma' ? 'val.domainComma' : 'val.domainInvalid', {
      line: first.line,
      val: first.value,
    });
  };

  const handleSaveBlocklist = async () => {
    setBlockedError(null);
    const { valid, issues } = validateDomainRules(blockedDraft);
    if (issues.length > 0) {
      setBlockedError(formatDomainError(issues));
      return;
    }
    setBlockedDraft(valid.join('\n'));
    await handlePolicyPatch({ blockedDomains: valid });
    setStatusMsg(t('val.savedRules', { count: valid.length }));
  };

  const handleSaveReadOnly = async () => {
    setReadOnlyError(null);
    const { valid, issues } = validateDomainRules(readOnlyDraft);
    if (issues.length > 0) {
      setReadOnlyError(formatDomainError(issues));
      return;
    }
    setReadOnlyDraft(valid.join('\n'));
    await handlePolicyPatch({ readOnlyDomains: valid });
    setStatusMsg(t('val.savedRules', { count: valid.length }));
  };

  const handleCdpIdleChange = async (raw: string) => {
    setCdpIdleDraft(raw);
    const check = validateCdpIdleSeconds(raw);
    if (!check.ok || check.value === undefined) {
      setCdpIdleError(t('val.cdpIdleRange'));
      return;
    }
    setCdpIdleError(null);
    await handlePolicyPatch({ cdpIdleDetachSec: check.value });
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
    setRecordError(null);
    try {
      await sendSw({ type: 'sp.startRecording' });
      await refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('RESTRICTED_RECORD_URL') || /cannot access a chrome/i.test(msg)) {
        setRecordError(t('recorder.restrictedUrl'));
      } else {
        setRecordError(msg);
      }
    }
  };

  const handleStopRecording = async (save: boolean) => {
    setWorkflowNameError(null);
    setRecordError(null);
    if (save && workflowName.trim()) {
      const check = validateWorkflowName(workflowName);
      if (!check.ok) {
        setWorkflowNameError(t('val.workflowNameLength'));
        return;
      }
    }
    try {
      await sendSw({
        type: 'sp.stopRecording',
        save,
        name: workflowName.trim() || undefined,
      });
      setWorkflowName('');
      await refresh();
    } catch (err) {
      setRecordError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeleteWorkflow = async (workflowId: string) => {
    try {
      await sendSw({ type: 'sp.deleteWorkflow', workflowId });
      await refresh();
    } catch (err) {
      setRecordError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleExportPlaywright = (wf: RecordedWorkflow) => {
    const code = exportWorkflowToPlaywright(wf);
    const slug =
      wf.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || wf.id;
    downloadTextFile(`${slug}.spec.ts`, code, 'text/typescript;charset=utf-8');
  };

  const handleExportTimeline = () => {
    const exportedAt = new Date().toISOString();
    downloadTextFile(
      'chrome-browser-mcp-timeline.json',
      JSON.stringify({ exportedAt, profile: settings.profileLabel, events: runtime.recentActivity }, null, 2),
      'application/json;charset=utf-8',
    );
    setTimelineExported(true);
    setTimeout(() => setTimelineExported(false), 2000);
  };

  const handleTourStepChange = (nextIdx: number) => {
    setTourStep(nextIdx);
    const target = SIDE_PANEL_TOUR_STEPS[nextIdx]?.targetTab;
    if (target) setActiveTab(target);
  };

  const handleTourClose = async () => {
    setTourStep(null);
    try {
      await sendSw({
        type: 'sp.saveSettings',
        patch: { onboardingCompleted: true, sidePanelTourPending: false },
        reconnect: false,
      });
      await refresh();
    } catch {
      // ignore close errors
    }
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
          {tab.title || '(untitled)'} {tab.cdpAttached && <span className="pill accent">CDP</span>}
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
          <select
            className="lang-select"
            aria-label={t('setting.language')}
            value={locale}
            onChange={(e) => void handleLocaleChange(e.target.value as LocalePreference)}
          >
            <option value="en">EN</option>
            <option value="ru">RU</option>
            <option value="zh-CN">中文</option>
          </select>
          <ThemeToggle
            persistedTheme={settings.theme ?? null}
            onPersist={(next) => void handleThemePersist(next)}
          />
          <button
            type="button"
            className={`btn small ${runtime.paused ? 'primary' : 'danger'}`}
            onClick={handleTogglePause}
            title={pauseShortcut}
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
        <section role="tabpanel" aria-labelledby="tab-control" hidden={activeTab !== 'control'}>
          <div className="tab-panel-inner panel-fill">
            {runtime.paused && (
              <div className="card paused-banner">
                <div className="card-title">{t('status.paused')}</div>
                <div className="muted">
                  {t('status.pausedDesc')} (<kbd className="kbd-chip">{pauseShortcut}</kbd>)
                </div>
              </div>
            )}

            {!runtime.connected && (
              <div className="card approval">
                <div className="card-title">{t('status.offline')}</div>
                <div className="muted">{t('pair.pinSimpleHint')}</div>
                <button type="button" className="btn primary small" onClick={() => setActiveTab('connect')}>
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
              <div className="security-row">
                <span className="security-label-group">
                  <label htmlFor="sp-ctrl-all-tabs">{t('setting.allowAllTabs')}</label>
                  <InfoTip label={t('setting.allowAllTabs')} text={t('setting.allowAllTabsInfo')} />
                </span>
                <input
                  id="sp-ctrl-all-tabs"
                  type="checkbox"
                  checked={settings.policy.scopeMode === 'all-tabs'}
                  onChange={(e) =>
                    void handlePolicyPatch({
                      scopeMode: e.target.checked ? 'all-tabs' : 'agent-group',
                    })
                  }
                />
              </div>

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
        <section role="tabpanel" aria-labelledby="tab-timeline" hidden={activeTab !== 'timeline'}>
          <div className="tab-panel-inner panel-fill">
            <div className={`card ${runtime.recentActivity.length > 0 ? 'fill-card' : ''}`}>
              <div className="card-header">
                <span className="card-title">{t('tab.timeline')}</span>
                <div className="row">
                  <button
                    type="button"
                    className={`btn small ${timelineExported ? 'primary' : ''}`}
                    onClick={handleExportTimeline}
                  >
                    {timelineExported ? `✓ ${t('status.saved')}` : t('btn.exportJson')}
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
                      <span className={`pill ${ev.status === 'ok' ? 'accent' : 'warn'}`}>{ev.status}</span>
                    </div>
                  )}
                />
              )}
            </div>
          </div>
        </section>

        {/* WORKFLOW RECORDER TAB */}
        <section role="tabpanel" aria-labelledby="tab-workflows" hidden={activeTab !== 'workflows'}>
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
              {recordError && <div className="field-error">{recordError}</div>}
              {!isRecording ? (
                <button type="button" className="btn primary" onClick={handleStartRecording}>
                  {t('recorder.start')}
                </button>
              ) : (
                <>
                  <input
                    className={`input ${workflowNameError ? 'input-invalid' : ''}`}
                    placeholder={t('recorder.namePlaceholder')}
                    value={workflowName}
                    onChange={(e) => {
                      setWorkflowName(e.target.value);
                      setWorkflowNameError(null);
                    }}
                  />
                  {workflowNameError && <div className="field-error">{workflowNameError}</div>}
                  <div className="row">
                    <button
                      type="button"
                      className="btn primary"
                      onClick={() => void handleStopRecording(true)}
                    >
                      {t('recorder.stop')} ({recordingSteps.length})
                    </button>
                    <button type="button" className="btn" onClick={() => void handleStopRecording(false)}>
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
        <section role="tabpanel" aria-labelledby="tab-security" hidden={activeTab !== 'security'}>
          <div className="tab-panel-inner">
            <div className="card security-card">
              <div className="card-title">{t('tab.security')}</div>

              {/* Optional Visual Agent Cursor & HUD (ON by default) */}
              <div className="security-row">
                <span className="security-label-group">
                  <label htmlFor="sp-sec-hud">{t('setting.visualHud')}</label>
                  <InfoTip label={t('setting.visualHud')} text={t('setting.visualHudDesc')} />
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
                  onChange={(e) => void handlePolicyPatch({ promptInjectionShield: e.target.checked })}
                />
              </div>

              <div className="security-row">
                <span className="security-label-group">
                  <label htmlFor="sp-sec-eval">{t('setting.approvalEval')}</label>
                  <InfoTip label={t('setting.approvalEval')} text={t('setting.approvalEvalInfo')} />
                </span>
                <input
                  id="sp-sec-eval"
                  type="checkbox"
                  checked={settings.policy.requireApprovalForEval}
                  onChange={(e) => void handlePolicyPatch({ requireApprovalForEval: e.target.checked })}
                />
              </div>

              <div className="security-row">
                <span className="security-label-group">
                  <label htmlFor="sp-sec-pass">{t('setting.approvalPasswords')}</label>
                  <InfoTip label={t('setting.approvalPasswords')} text={t('setting.approvalPasswordsInfo')} />
                </span>
                <input
                  id="sp-sec-pass"
                  type="checkbox"
                  checked={settings.policy.requireApprovalForPasswords}
                  onChange={(e) => void handlePolicyPatch({ requireApprovalForPasswords: e.target.checked })}
                />
              </div>

              <div className="security-row">
                <span className="security-label-group">
                  <label htmlFor="sp-sec-pay">{t('setting.approvalPayments')}</label>
                  <InfoTip label={t('setting.approvalPayments')} text={t('setting.approvalPaymentsInfo')} />
                </span>
                <input
                  id="sp-sec-pay"
                  type="checkbox"
                  checked={settings.policy.requireApprovalForPayments}
                  onChange={(e) => void handlePolicyPatch({ requireApprovalForPayments: e.target.checked })}
                />
              </div>
              <div className="security-row">
                <span className="security-label-group">
                  <label htmlFor="sp-sec-prefer-md">Prefer Markdown (Accept: text/markdown)</label>
                  <InfoTip
                    label="Prefer Markdown (Experimental)"
                    text="Experimental (exp/content-negotiation): adds Accept: text/markdown to main-frame navigations inside AI Agent tabs via declarativeNetRequest session rules. Tradeoffs: sites can fingerprint agent traffic, serve cloaked content different from HTML (split-view prompt-injection risk), or return raw Markdown without interactive UI."
                  />
                </span>
                <input
                  id="sp-sec-prefer-md"
                  type="checkbox"
                  checked={settings.policy.preferMarkdown}
                  onChange={(e) => void handlePolicyPatch({ preferMarkdown: e.target.checked })}
                />
              </div>

              <div className="security-row">
                <span className="security-label-group">
                  <label htmlFor="sp-sec-upload">{t('setting.approvalUploads')}</label>
                  <InfoTip label={t('setting.approvalUploads')} text={t('setting.approvalUploadsInfo')} />
                </span>
                <input
                  id="sp-sec-upload"
                  type="checkbox"
                  checked={settings.policy.requireApprovalForUploads}
                  onChange={(e) => void handlePolicyPatch({ requireApprovalForUploads: e.target.checked })}
                />
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
                  <div className="card-header" style={{ marginBottom: 4 }}>
                    <span className="card-title">{t('setting.readOnlyDomains')}</span>
                    <InfoTip label={t('setting.readOnlyDomains')} text={t('setting.readOnlyInfo')} />
                  </div>
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
                    className={`textarea ${readOnlyError ? 'input-invalid' : ''}`}
                    rows={3}
                    value={readOnlyDraft}
                    onChange={(e) => {
                      setReadOnlyDraft(e.target.value);
                      setReadOnlyError(null);
                    }}
                  />
                  {readOnlyError && <div className="field-error">{readOnlyError}</div>}
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
                  <div className="card-header" style={{ marginBottom: 4 }}>
                    <span className="card-title">{t('setting.blockedDomains')}</span>
                    <InfoTip label={t('setting.blockedDomains')} text={t('setting.blockedDomainsInfo')} />
                  </div>
                  <textarea
                    className={`textarea ${blockedError ? 'input-invalid' : ''}`}
                    rows={4}
                    value={blockedDraft}
                    onChange={(e) => {
                      setBlockedDraft(e.target.value);
                      setBlockedError(null);
                    }}
                  />
                  {blockedError && <div className="field-error">{blockedError}</div>}
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
                  <span className="security-label-group">
                    <label htmlFor="sp-adv-dialog">{t('setting.dialogPolicy')}</label>
                    <InfoTip label={t('setting.dialogPolicy')} text={t('setting.dialogPolicyInfo')} />
                  </span>
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

                <div>
                  <div className="security-row">
                    <span className="security-label-group">
                      <label htmlFor="sp-adv-cdp-idle">{t('setting.cdpDetach')}</label>
                      <InfoTip label={t('setting.cdpDetach')} text={t('setting.cdpDetachInfo')} />
                    </span>
                    <input
                      id="sp-adv-cdp-idle"
                      type="number"
                      min={10}
                      max={600}
                      className={`input ${cdpIdleError ? 'input-invalid' : ''}`}
                      style={{ width: 84 }}
                      value={cdpIdleDraft}
                      onChange={(e) => void handleCdpIdleChange(e.target.value)}
                    />
                  </div>
                  {cdpIdleError && <div className="field-error">{cdpIdleError}</div>}
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
                    onChange={(e) => void handlePolicyPatch({ cdpProxyEnabled: e.target.checked })}
                  />
                </div>

                <div className="card-title" style={{ marginTop: 4 }}>
                  {t('section.optionalPermissions')}
                </div>
                <div className="security-row">
                  <span className="security-label-group">
                    <label htmlFor="sp-perm-dl">{t('setting.downloadsPerm')}</label>
                    <InfoTip label={t('setting.downloadsPerm')} text={t('setting.downloadsPermInfo')} />
                  </span>
                  <input
                    id="sp-perm-dl"
                    type="checkbox"
                    checked={hasDownloadsPerm}
                    onChange={(e) => void handleToggleOptionalPerm('downloads', e.target.checked)}
                  />
                </div>
                <div className="security-row">
                  <span className="security-label-group">
                    <label htmlFor="sp-perm-nm">{t('setting.nativeHostPerm')}</label>
                    <InfoTip label={t('setting.nativeHostPerm')} text={t('setting.nativeHostPermInfo')} />
                  </span>
                  <input
                    id="sp-perm-nm"
                    type="checkbox"
                    checked={hasNativePerm}
                    onChange={(e) => void handleToggleOptionalPerm('nativeMessaging', e.target.checked)}
                  />
                </div>
              </div>
            </details>

            {statusMsg && <div className="muted">{statusMsg}</div>}
          </div>
        </section>

        {/* PAIR / CONNECT TAB (with Progressive Disclosure Advanced Connection) */}
        <section role="tabpanel" aria-labelledby="tab-connect" hidden={activeTab !== 'connect'}>
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
              <div className="muted">{t('pair.pinSimpleHint')}</div>
              <div className="pin-row" style={{ flexWrap: 'wrap' }}>
                {brokerDetected && (
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => void chrome.tabs.create({ url: `${brokerHttpBase}/pair`, active: true })}
                  >
                    {t('btn.openPairPage')}
                  </button>
                )}
                <input
                  className={`input pin-input ${pinError ? 'input-invalid' : ''}`}
                  inputMode="numeric"
                  maxLength={6}
                  placeholder={t('pair.pinPlaceholder')}
                  value={pinDraft}
                  onChange={(e) => {
                    setPinDraft(e.target.value.replace(/\D/g, '').slice(0, 6));
                    setPinError(null);
                  }}
                />
                <button type="button" className="btn primary small" onClick={() => void handlePairPin()}>
                  {t('pair.pinButton')}
                </button>
              </div>
              {pinError && <div className="field-error">{pinError}</div>}
            </div>

            <details className="advanced-box">
              <summary>{t('section.advancedConnection')}</summary>
              <div className="advanced-body">
                <label className="muted">
                  {t('pair.profileLabel')}
                  <input
                    className="input"
                    value={labelDraft}
                    onChange={(e) => {
                      setLabelDraft(e.target.value);
                      setConnError(null);
                    }}
                  />
                </label>
                <label className="muted">
                  {t('pair.wsUrl')}
                  <input
                    className="input"
                    value={wsUrlDraft}
                    onChange={(e) => {
                      setWsUrlDraft(e.target.value);
                      setConnError(null);
                    }}
                  />
                </label>
                <div className="inline-hint">
                  <span>{t('pair.cliRepoHint')}</span>
                  <CopyableCode code="node packages/server/dist/cli.js token" locale={locale} />
                </div>
                <input
                  className={`input ${connError ? 'input-invalid' : ''}`}
                  type="password"
                  placeholder={t('pair.tokenPlaceholder')}
                  value={tokenDraft}
                  onChange={(e) => {
                    setTokenDraft(e.target.value);
                    setConnError(null);
                  }}
                />
                {connError && <div className="field-error">{connError}</div>}
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
