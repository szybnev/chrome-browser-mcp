import { useEffect } from 'react';

export type ThemeOverride = 'light' | 'dark' | null;

const STORAGE_KEY = 'color-scheme';

function getSystemScheme(): 'light' | 'dark' {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function readStoredOverride(): ThemeOverride {
  try {
    const val = localStorage.getItem(STORAGE_KEY);
    return val === 'light' || val === 'dark' ? val : null;
  } catch {
    return null;
  }
}

function applyColorScheme(override: ThemeOverride, targetEl?: HTMLElement | null): void {
  const root = targetEl ?? (typeof document !== 'undefined' ? document.documentElement : null);
  if (!targetEl && typeof document !== 'undefined') {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
    if (meta) {
      meta.content = override ?? 'light dark';
    }
  }
  if (!root) return;
  if (override) {
    root.dataset.theme = override;
    root.style.colorScheme = override;
  } else {
    delete root.dataset.theme;
    root.style.removeProperty('color-scheme');
  }
}

function writeStoredOverride(override: ThemeOverride): void {
  try {
    if (override) {
      localStorage.setItem(STORAGE_KEY, override);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Theme still applies via DOM attribute even if localStorage is blocked in a sandbox
  }
}

export interface ThemeToggleProps {
  themeRoot?: HTMLElement | null;
  hostTheme?: 'light' | 'dark' | null;
}

export function ThemeToggle({ themeRoot, hostTheme }: ThemeToggleProps = {}) {
  useEffect(() => {
    const stored = readStoredOverride();
    if (stored) {
      applyColorScheme(stored, themeRoot);
    } else if (hostTheme) {
      applyColorScheme(hostTheme, themeRoot);
    }

    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      const next: ThemeOverride = e.newValue === 'light' || e.newValue === 'dark' ? e.newValue : null;
      applyColorScheme(next ?? hostTheme ?? null, themeRoot);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [themeRoot, hostTheme]);

  const handleToggle = () => {
    const root = themeRoot ?? document.documentElement;
    const dataTheme = root.dataset.theme;
    const metaVal = !themeRoot
      ? document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')?.content
      : undefined;
    const currentOverride: ThemeOverride =
      dataTheme === 'light' || dataTheme === 'dark'
        ? dataTheme
        : metaVal === 'light' || metaVal === 'dark'
          ? metaVal
          : readStoredOverride();
    const inlineScheme = root.style.colorScheme;
    const effectiveCurrent: 'light' | 'dark' =
      currentOverride ??
      (inlineScheme === 'light' || inlineScheme === 'dark' ? inlineScheme : (hostTheme ?? getSystemScheme()));
    const target: 'light' | 'dark' = effectiveCurrent === 'dark' ? 'light' : 'dark';

    applyColorScheme(target, themeRoot);
    writeStoredOverride(target);
  };

  return (
    <button
      type="button"
      className="btn icon-btn theme-toggle"
      onClick={handleToggle}
      title="Toggle light / dark theme"
    >
      <span className="theme-opt theme-opt-to-light">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2" />
          <path d="M12 20v2" />
          <path d="m4.93 4.93 1.41 1.41" />
          <path d="m17.66 17.66 1.41 1.41" />
          <path d="M2 12h2" />
          <path d="M20 12h2" />
          <path d="m6.34 17.66-1.41 1.41" />
          <path d="m19.07 4.93-1.41 1.41" />
        </svg>
        <span className="sr-only">Switch to light theme</span>
      </span>
      <span className="theme-opt theme-opt-to-dark">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
        </svg>
        <span className="sr-only">Switch to dark theme</span>
      </span>
    </button>
  );
}
