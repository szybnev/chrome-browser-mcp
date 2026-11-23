import { useCallback, useEffect, useState } from 'react';
import {
  getPauseShortcut,
  READ_ONLY_DOMAIN_PRESETS,
  resolveLocale,
  translate,
  validatePairingPin,
  validatePairingToken,
  validateProfileLabel,
  type I18nKey,
  type LocalePreference,
} from '@chrome-browser-mcp/protocol';
import type { ExtensionRuntimeState, ExtensionSettings } from '../shared/storage.js';
import { ThemeToggle, type ThemeOverride } from '../sidepanel/ThemeToggle.js';
import { CopyableCode } from '../sidepanel/CopyableCode.js';

interface StatePayload {
  settings: ExtensionSettings;
  runtime: ExtensionRuntimeState;
}

async function sendSw<T = unknown>(message: Record<string, unknown>): Promise<T> {
  const res = (await chrome.runtime.sendMessage(message)) as {
    ok: boolean;
    data?: T;
    error?: string;
  };
  if (!res?.ok) throw new Error(res?.error || 'Background request failed');
  return res.data as T;
}

export function WelcomeApp() {
  const [step, setStep] = useState(0);
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [runtime, setRuntime] = useState<ExtensionRuntimeState | null>(null);
  const [brokerAlive, setBrokerAlive] = useState<boolean | null>(null);
  const [pin, setPin] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [labelDraft, setLabelDraft] = useState('default');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [manualError, setManualError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadState = useCallback(async () => {
    const payload = await sendSw<StatePayload>({ type: 'sp.getState' });
    setSettings(payload.settings);
    setRuntime(payload.runtime);
    setLabelDraft((prev) => (prev === 'default' ? payload.settings.profileLabel : prev));
    const httpBase = payload.settings.wsUrl
      .replace(/^ws:/i, 'http:')
      .replace(/^wss:/i, 'https:')
      .replace(/\/ws\/?$/, '');
    try {
      const resp = await fetch(`${httpBase}/health`, { signal: AbortSignal.timeout(1200) });
      setBrokerAlive(resp.ok);
    } catch {
      setBrokerAlive(false);
    }
  }, []);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const locale = resolveLocale(settings?.locale);
  const t = (key: I18nKey, vars?: Record<string, string | number>) => translate(locale, key, vars);
  const pauseShortcut = getPauseShortcut();

  if (!settings || !runtime) {
    return (
      <div className="welcome-page">
        <div className="welcome-shell">{t('app.loading')}</div>
      </div>
    );
  }

  const brokerHttpBase = settings.wsUrl
    .replace(/^ws:/i, 'http:')
    .replace(/^wss:/i, 'https:')
    .replace(/\/ws\/?$/, '');

  const updateSettings = async (patch: Partial<ExtensionSettings>, reconnect = false) => {
    const next = await sendSw<ExtensionSettings>({ type: 'sp.saveSettings', patch, reconnect });
    setSettings(next);
  };

  const handleOpenPairPage = () => {
    void chrome.tabs.create({ url: `${brokerHttpBase}/pair`, active: true });
  };

  const handlePairPin = async () => {
    setPinError(null);
    setFeedback(null);
    const pinCheck = validatePairingPin(pin);
    if (!pinCheck.ok || !pinCheck.normalized) {
      setPinError(t('val.pinInvalid'));
      return;
    }
    const labelCheck = validateProfileLabel(labelDraft || 'default');
    if (!labelCheck.ok || !labelCheck.normalized) {
      setPinError(
        labelCheck.errorCode === 'length'
          ? t('val.labelLength')
          : labelCheck.errorCode === 'chars'
            ? t('val.labelChars')
            : t('val.labelEmpty'),
      );
      return;
    }
    setBusy(true);
    try {
      await sendSw({
        type: 'sp.pairWithPin',
        pin: pinCheck.normalized,
        profileLabel: labelCheck.normalized,
      });
      setPin('');
      setFeedback(t('pair.pairedOk'));
      await loadState();
      setTimeout(() => {
        setStep((cur) => (cur === 1 ? 2 : cur));
      }, 650);
    } catch (err) {
      setPinError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleManualToken = async () => {
    setManualError(null);
    setFeedback(null);
    const labelCheck = validateProfileLabel(labelDraft);
    if (!labelCheck.ok || !labelCheck.normalized) {
      setManualError(
        labelCheck.errorCode === 'length'
          ? t('val.labelLength')
          : labelCheck.errorCode === 'chars'
            ? t('val.labelChars')
            : t('val.labelEmpty'),
      );
      return;
    }
    const tokenCheck = validatePairingToken(tokenDraft);
    if (!tokenCheck.ok || !tokenCheck.normalized) {
      setManualError(
        tokenCheck.errorCode === 'whitespace'
          ? t('val.tokenWhitespace')
          : tokenCheck.errorCode === 'too_short'
            ? t('val.tokenShort')
            : t('val.tokenEmpty'),
      );
      return;
    }
    setBusy(true);
    try {
      await updateSettings(
        { token: tokenCheck.normalized, profileLabel: labelCheck.normalized },
        true,
      );
      setFeedback(t('pair.pairedOk'));
      await loadState();
      setTimeout(() => {
        setStep((cur) => (cur === 1 ? 2 : cur));
      }, 650);
    } catch (err) {
      setManualError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleReadOnlyPreset = async (domain: string) => {
    const cur = settings.policy.readOnlyDomains;
    const next = cur.includes(domain) ? cur.filter((d) => d !== domain) : [...cur, domain];
    await updateSettings({ policy: { ...settings.policy, readOnlyDomains: next } });
  };

  const handleOpenHud = async () => {
    await updateSettings({ onboardingCompleted: true, sidePanelTourPending: true });
    try {
      const win = await chrome.windows.getCurrent();
      if (win.id !== undefined) {
        await chrome.sidePanel.open({ windowId: win.id });
      }
    } catch {
      // User can also click toolbar icon
    }
    window.close();
  };

  const steps = [
    t('welcome.step1'),
    t('welcome.step2'),
    t('welcome.step3'),
    t('welcome.step4'),
  ];

  return (
    <div className="welcome-page">
      <div className="welcome-shell">
        <header className="welcome-top">
          <div className="welcome-brand">
            <img src="/icons/icon-48.png" alt="Chrome Browser MCP" />
            <div>
              <h1>{t('welcome.heroTitle')}</h1>
              <p>{t('welcome.heroSub')}</p>
            </div>
          </div>
          <ThemeToggle
            persistedTheme={settings.theme ?? null}
            onPersist={(next: ThemeOverride) => void updateSettings({ theme: next })}
          />
        </header>

        <nav className="welcome-stepper" aria-label="Onboarding steps">
          {steps.map((label, idx) => (
            <button
              key={label}
              type="button"
              className={`step-pill ${step === idx ? 'active' : idx < step ? 'done' : ''}`}
              onClick={() => setStep(idx)}
            >
              {idx + 1}. {label}
            </button>
          ))}
        </nav>

        <section className="welcome-body">
          {step === 0 && (
            <>
              <div className="welcome-grid">
                <div className="card">
                  <div className="card-title">{t('setting.language')}</div>
                  <select
                    className="input"
                    value={locale}
                    onChange={(e) =>
                      void updateSettings({ locale: e.target.value as LocalePreference })
                    }
                  >
                    <option value="en">English</option>
                    <option value="ru">Русский</option>
                    <option value="zh-CN">简体中文</option>
                  </select>
                </div>
                <div className="card">
                  <div className="card-title">{t('welcome.localTitle')}</div>
                  <div className="muted">{t('welcome.localDesc')}</div>
                </div>
              </div>
              <div className="card">
                <div className="card-title">{t('welcome.howTitle')}</div>
                <div className="muted" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div>1. {t('welcome.how1')}</div>
                  <div>2. {t('welcome.how2')}</div>
                  <div>
                    3. {t('welcome.how3Prefix')}
                    <kbd className="kbd-chip">{pauseShortcut}</kbd>
                    {t('welcome.how3Suffix')}
                  </div>
                </div>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <div className="card">
                <div className="card-header">
                  <span className="card-title">{t('pair.pinTitle')}</span>
                  <span className={`pill ${runtime.connected || brokerAlive ? 'accent' : 'warn'}`}>
                    {runtime.connected
                      ? t('status.connected')
                      : brokerAlive
                        ? t('pair.brokerDetected')
                        : t('pair.brokerOffline')}
                  </span>
                </div>
                <div className="muted">{t('pair.pinSimpleHint')}</div>
                <div className="pin-row" style={{ flexWrap: 'wrap' }}>
                  {brokerAlive && (
                    <button type="button" className="btn" onClick={handleOpenPairPage}>
                      {t('btn.openPairPage')}
                    </button>
                  )}
                  <input
                    className="input pin-input"
                    inputMode="numeric"
                    maxLength={6}
                    placeholder={t('pair.pinPlaceholder')}
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  />
                  <button
                    type="button"
                    className="btn primary"
                    disabled={busy || pin.length < 6}
                    onClick={() => void handlePairPin()}
                  >
                    {t('pair.pinButton')}
                  </button>
                </div>
                {pinError && <div className="field-error">{pinError}</div>}
                {feedback && <div className="muted">{feedback}</div>}
              </div>

              <details className="advanced-box">
                <summary>{t('section.advancedConnection')}</summary>
                <div className="advanced-body">
                  <label className="muted">
                    {t('pair.profileLabel')}
                    <input
                      className="input"
                      placeholder={t('pair.profileLabel')}
                      value={labelDraft}
                      onChange={(e) => {
                        setLabelDraft(e.target.value);
                        setManualError(null);
                      }}
                    />
                  </label>
                  <div className="inline-hint">
                    <span>{t('pair.cliRepoHint')}</span>
                    <CopyableCode code="node packages/server/dist/cli.js token" locale={locale} />
                  </div>
                  <input
                    className={`input ${manualError ? 'input-invalid' : ''}`}
                    type="password"
                    placeholder={t('pair.tokenPlaceholder')}
                    value={tokenDraft}
                    onChange={(e) => {
                      setTokenDraft(e.target.value);
                      setManualError(null);
                    }}
                  />
                  {manualError && <div className="field-error">{manualError}</div>}
                  <button
                    type="button"
                    className="btn small"
                    disabled={busy}
                    onClick={() => void handleManualToken()}
                  >
                    {t('pair.saveConnect')}
                  </button>
                </div>
              </details>
            </>
          )}

          {step === 2 && (
            <>
              <div className="card">
                <div className="security-row">
                  <strong>{t('setting.visualHud')}</strong>
                  <input
                    type="checkbox"
                    checked={settings.visualHudEnabled}
                    onChange={(e) =>
                      void sendSw({ type: 'sp.setVisualHud', enabled: e.target.checked }).then(() =>
                        loadState(),
                      )
                    }
                  />
                </div>
                <div className="cursor-preview">
                  <span className="muted">
                    {settings.visualHudEnabled
                      ? t('setting.visualHudActive')
                      : t('setting.visualHudSilent')}
                  </span>
                  <span className={`pill ${settings.visualHudEnabled ? 'accent' : ''}`}>
                    {settings.visualHudEnabled ? t('status.on') : t('status.off')}
                  </span>
                </div>
              </div>

              <div className="card">
                <div className="card-title">{t('setting.readOnlyOptional')}</div>
                <div className="muted">{t('setting.readOnlyHint')}</div>
                <div className="preset-chips">
                  {READ_ONLY_DOMAIN_PRESETS.map((domain) => {
                    const active = settings.policy.readOnlyDomains.includes(domain);
                    return (
                      <button
                        key={domain}
                        type="button"
                        className={`preset-chip ${active ? 'active' : ''}`}
                        onClick={() => void toggleReadOnlyPreset(domain)}
                      >
                        {active ? '✓ ' : '+ '}
                        {domain}
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {step === 3 && (
            <div className="card">
              <div className="card-title">{t('welcome.readyTitle')}</div>
              <div className="muted">{t('welcome.readyDesc')}</div>
              <div className="row" style={{ marginTop: 8 }}>
                <button type="button" className="btn primary" onClick={() => void handleOpenHud()}>
                  {t('welcome.openHud')}
                </button>
              </div>
            </div>
          )}
        </section>

        <footer className="welcome-footer">
          <button
            type="button"
            className="btn small"
            onClick={() => {
              void updateSettings({ onboardingCompleted: true }).then(() => window.close());
            }}
          >
            {t('btn.skip')}
          </button>
          <div className="row">
            {step > 0 && (
              <button type="button" className="btn small" onClick={() => setStep((s) => s - 1)}>
                {t('btn.back')}
              </button>
            )}
            {step < steps.length - 1 ? (
              <button
                type="button"
                className="btn primary small"
                onClick={() => setStep((s) => s + 1)}
              >
                {t('btn.next')}
              </button>
            ) : (
              <button
                type="button"
                className="btn primary small"
                onClick={() => void handleOpenHud()}
              >
                {t('btn.finish')}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
