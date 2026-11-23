import { useState } from 'react';
import { translate, type SupportedLocale } from '@chrome-browser-mcp/protocol';

export function CopyableCode({
  code,
  locale,
}: {
  code: string;
  locale: SupportedLocale;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard fallback ignored if blocked
    }
  };

  return (
    <button
      type="button"
      className={`code-chip ${copied ? 'copied' : ''}`}
      onClick={() => void handleCopy()}
      title={copied ? translate(locale, 'status.copied') : translate(locale, 'status.clickToCopy')}
    >
      <code>{code}</code>
      <span className="code-chip-status" aria-live="polite">
        {copied ? (
          translate(locale, 'status.copied')
        ) : (
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </span>
    </button>
  );
}
