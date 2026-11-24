import { useEffect, useId, useRef, useState } from 'react';

interface InfoTipProps {
  label: string;
  text: string;
}

let beforeToggleInstalled = false;

function ensureHintFallback(): void {
  if (beforeToggleInstalled || typeof document === 'undefined') return;
  beforeToggleInstalled = true;
  const probe = document.createElement('div');
  probe.setAttribute('popover', 'hint');
  if ((probe as HTMLElement & { popover?: string }).popover !== 'hint') {
    document.addEventListener(
      'beforetoggle',
      (ev) => {
        const target = ev.target as HTMLElement | null;
        const newState = (ev as Event & { newState?: string }).newState;
        if (!target || newState !== 'open') return;
        const isToggletip =
          target.getAttribute('popover') === 'hint' &&
          Boolean(target.id) &&
          Boolean(document.querySelector(`[popovertarget="${CSS.escape(target.id)}"]`));
        if (isToggletip) {
          target.setAttribute('popover', 'auto');
        }
      },
      true,
    );
  }
}

export function InfoTip({ label, text }: InfoTipProps) {
  const rawId = useId();
  const id = `tip-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [expanded, setExpanded] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    ensureHintFallback();
    const el = popRef.current;
    if (!el) return;
    const onToggle = (ev: Event) => {
      const state = (ev as Event & { newState?: string }).newState;
      setExpanded(state === 'open');
    };
    el.addEventListener('toggle', onToggle);
    return () => {
      el.removeEventListener('toggle', onToggle);
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  const supportsNativeInterest =
    typeof HTMLButtonElement !== 'undefined' && 'interestForElement' in HTMLButtonElement.prototype;

  const cancelClose = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const openFallback = () => {
    if (supportsNativeInterest) return;
    cancelClose();
    try {
      const el = popRef.current as (HTMLDivElement & { showPopover?: () => void }) | null;
      if (el && !el.matches(':popover-open')) el.showPopover?.();
    } catch {
      // ignore
    }
  };

  const scheduleCloseFallback = () => {
    if (supportsNativeInterest) return;
    cancelClose();
    closeTimerRef.current = setTimeout(() => {
      try {
        const el = popRef.current as (HTMLDivElement & { hidePopover?: () => void }) | null;
        if (el?.matches(':popover-open')) el.hidePopover?.();
      } catch {
        // ignore
      }
    }, 140);
  };

  return (
    <span className="infotip-wrap">
      <button
        type="button"
        className="infotip-btn"
        aria-label={`More about ${label}`}
        aria-expanded={expanded}
        onMouseEnter={openFallback}
        onMouseLeave={scheduleCloseFallback}
        onFocus={openFallback}
        onBlur={scheduleCloseFallback}
        {...({
          interestfor: id,
          popovertarget: id,
          popovertargetaction: 'show',
        } as Record<string, string>)}
      >
        ?
      </button>
      <div
        ref={popRef}
        id={id}
        role="tooltip"
        className="infotip-popover"
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleCloseFallback}
        {...({ popover: 'hint' } as Record<string, string>)}
      >
        {text}
      </div>
    </span>
  );
}
