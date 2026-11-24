import {
  getPauseShortcut,
  type I18nKey,
  type SupportedLocale,
  translate,
} from '@chrome-browser-mcp/protocol';
import { useEffect } from 'react';

export interface TourStep {
  titleKey: I18nKey;
  bodyKey: I18nKey;
  targetTab: 'control' | 'workflows' | 'security';
  docUrl?: string;
  docLabelKey?: I18nKey;
}

export const SIDE_PANEL_TOUR_STEPS: TourStep[] = [
  { titleKey: 'tour.step1.title', bodyKey: 'tour.step1.body', targetTab: 'control' },
  { titleKey: 'tour.step2.title', bodyKey: 'tour.step2.body', targetTab: 'control' },
  {
    titleKey: 'tour.step3.title',
    bodyKey: 'tour.step3.body',
    targetTab: 'workflows',
    docUrl: 'https://playwright.dev/docs/intro',
    docLabelKey: 'tour.playwrightDocs',
  },
  { titleKey: 'tour.step4.title', bodyKey: 'tour.step4.body', targetTab: 'security' },
];

export function OnboardingTour({
  stepIndex,
  locale,
  onStepChange,
  onClose,
}: {
  stepIndex: number;
  locale: SupportedLocale;
  onStepChange: (nextIndex: number) => void;
  onClose: () => void;
}) {
  const step = SIDE_PANEL_TOUR_STEPS[stepIndex];

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!step) return null;

  const isLast = stepIndex >= SIDE_PANEL_TOUR_STEPS.length - 1;
  const t = (key: I18nKey, vars?: Record<string, string | number>) => translate(locale, key, vars);
  const pauseShortcut = getPauseShortcut();

  return (
    <div className="tour-overlay" role="presentation">
      <div className="tour-backdrop" aria-hidden="true" />
      <div className="tour-banner" role="dialog" aria-modal="true" aria-label="Interactive walkthrough">
        <div className="tour-header">
          <strong>{t(step.titleKey)}</strong>
          <span className="pill accent">
            {stepIndex + 1} / {SIDE_PANEL_TOUR_STEPS.length}
          </span>
        </div>
        <div className="tour-body">{t(step.bodyKey, { shortcut: pauseShortcut })}</div>
        {step.docUrl && step.docLabelKey && (
          <a className="tour-link" href={step.docUrl} target="_blank" rel="noopener noreferrer">
            {t(step.docLabelKey)}
          </a>
        )}
        <div className="tour-actions">
          <button type="button" className="btn small" onClick={onClose}>
            {t('btn.skip')}
          </button>
          <div className="row">
            {stepIndex > 0 && (
              <button type="button" className="btn small" onClick={() => onStepChange(stepIndex - 1)}>
                {t('btn.back')}
              </button>
            )}
            <button
              type="button"
              className="btn primary small"
              onClick={() => (isLast ? onClose() : onStepChange(stepIndex + 1))}
            >
              {isLast ? t('btn.finish') : t('btn.next')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
