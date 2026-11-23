import { useEffect } from 'react';
import { translate, type I18nKey, type SupportedLocale } from '@chrome-browser-mcp/protocol';

export interface TourStep {
  titleKey: I18nKey;
  bodyKey: I18nKey;
  targetTab: 'control' | 'workflows' | 'security';
}

export const SIDE_PANEL_TOUR_STEPS: TourStep[] = [
  { titleKey: 'tour.step1.title', bodyKey: 'tour.step1.body', targetTab: 'control' },
  { titleKey: 'tour.step2.title', bodyKey: 'tour.step2.body', targetTab: 'control' },
  { titleKey: 'tour.step3.title', bodyKey: 'tour.step3.body', targetTab: 'workflows' },
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
  const t = (key: I18nKey) => translate(locale, key);

  return (
    <div className="tour-banner" role="dialog" aria-label="Interactive walkthrough">
      <div className="tour-header">
        <strong>{t(step.titleKey)}</strong>
        <span className="pill accent">
          {stepIndex + 1} / {SIDE_PANEL_TOUR_STEPS.length}
        </span>
      </div>
      <div className="muted">{t(step.bodyKey)}</div>
      <div className="tour-actions">
        <button type="button" className="btn small" onClick={onClose}>
          {t('btn.skip')}
        </button>
        <div className="row">
          {stepIndex > 0 && (
            <button
              type="button"
              className="btn small"
              onClick={() => onStepChange(stepIndex - 1)}
            >
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
  );
}
