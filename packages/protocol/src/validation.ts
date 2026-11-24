export type DomainValidationIssueKind = 'whitespace_or_comma' | 'invalid_domain';

export interface DomainValidationIssue {
  line: number;
  value: string;
  kind: DomainValidationIssueKind;
}

const SCHEME_RULE_RE =
  /^(?:(?:about|javascript|data|blob|view-source):[^\s,]+|(?:chrome|chrome-extension|chrome-untrusted|devtools|edge|brave|https?|file):\/\/[^\s,]+)$/i;
const IPV4_PART = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const HOST_RULE_RE = new RegExp(
  `^(?:\\*\\.)?(?:localhost|(?:${IPV4_PART}\\.){3}${IPV4_PART}|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63})(?::\\d{1,5})?(?:\\/[^\\s,]*)?$`,
  'i',
);

export function validateDomainRules(rawText: string): {
  valid: string[];
  issues: DomainValidationIssue[];
} {
  const lines = rawText.split(/\r?\n/);
  const valid: string[] = [];
  const issues: DomainValidationIssue[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;

    if (/[\s,;]+/.test(trimmed)) {
      issues.push({ line: i + 1, value: trimmed, kind: 'whitespace_or_comma' });
      continue;
    }

    if (SCHEME_RULE_RE.test(trimmed) || HOST_RULE_RE.test(trimmed)) {
      valid.push(trimmed);
    } else {
      issues.push({ line: i + 1, value: trimmed, kind: 'invalid_domain' });
    }
  }

  return { valid, issues };
}

export function validateWsUrl(raw: string): {
  ok: boolean;
  normalized?: string;
  errorCode?: 'empty' | 'protocol' | 'loopback' | 'invalid';
} {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, errorCode: 'empty' };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, errorCode: 'invalid' };
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    return { ok: false, errorCode: 'protocol' };
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]') {
    return { ok: false, errorCode: 'loopback' };
  }
  return { ok: true, normalized: trimmed };
}

export function validateProfileLabel(raw: string): {
  ok: boolean;
  normalized?: string;
  errorCode?: 'empty' | 'length' | 'chars';
} {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, errorCode: 'empty' };
  if (trimmed.length > 32) return { ok: false, errorCode: 'length' };
  if (!/^[\p{L}\p{N}._ -]+$/u.test(trimmed)) {
    return { ok: false, errorCode: 'chars' };
  }
  return { ok: true, normalized: trimmed };
}

export function validatePairingToken(raw: string): {
  ok: boolean;
  normalized?: string;
  errorCode?: 'empty' | 'whitespace' | 'too_short';
} {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, errorCode: 'empty' };
  if (/\s/.test(trimmed)) return { ok: false, errorCode: 'whitespace' };
  if (trimmed.length < 16) return { ok: false, errorCode: 'too_short' };
  return { ok: true, normalized: trimmed };
}

export function validatePairingPin(raw: string): { ok: boolean; normalized?: string } {
  const trimmed = raw.trim();
  if (!/^\d{6}$/.test(trimmed)) return { ok: false };
  return { ok: true, normalized: trimmed };
}

function hasControlChars(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function validateWorkflowName(raw: string): {
  ok: boolean;
  normalized?: string;
  errorCode?: 'length' | 'control';
} {
  const trimmed = raw.trim();
  if (trimmed.length > 80) return { ok: false, errorCode: 'length' };
  if (hasControlChars(trimmed)) return { ok: false, errorCode: 'control' };
  return { ok: true, normalized: trimmed };
}

export function validateCdpIdleSeconds(raw: string | number): { ok: boolean; value?: number } {
  const num = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(num) || num < 10 || num > 600) {
    return { ok: false };
  }
  return { ok: true, value: num };
}
