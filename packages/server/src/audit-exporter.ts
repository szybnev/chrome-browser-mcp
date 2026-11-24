import type { ActivityEvent, BrowserProfileInfo, SecurityPolicy } from '@chrome-browser-mcp/protocol';

export interface AuditExportPayload {
  exportedAt: string;
  brokerVersion: string;
  profiles: BrowserProfileInfo[];
  policySummary: {
    scopeMode: SecurityPolicy['scopeMode'];
    promptInjectionShield: boolean;
    blockedDomainsCount: number;
    readOnlyDomainsCount: number;
    cdpProxyEnabled: boolean;
  };
  events: ActivityEvent[];
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderAuditJson(payload: AuditExportPayload): string {
  return JSON.stringify(payload, null, 2);
}

export function renderAuditHtml(payload: AuditExportPayload): string {
  const rows = payload.events
    .map((ev) => {
      const time = new Date(ev.timestamp).toISOString().replace('T', ' ').slice(0, 19);
      const badgeClass =
        ev.status === 'ok' ? 'ok' : ev.status === 'blocked' ? 'warn' : ev.status === 'error' ? 'err' : 'info';
      const thumb = ev.thumbnailDataUrl
        ? `<div class="thumb"><img src="${escapeHtml(ev.thumbnailDataUrl)}" alt="Step screenshot" loading="lazy" /></div>`
        : '';
      return `<article class="event">
        <header>
          <span class="badge ${badgeClass}">${escapeHtml(ev.status.toUpperCase())}</span>
          <strong>${escapeHtml(ev.tool)}</strong>
          <span class="meta">${escapeHtml(time)} UTC${ev.durationMs !== undefined ? ` · ${ev.durationMs}ms` : ''}${ev.engine ? ` · ${escapeHtml(ev.engine)}` : ''}${ev.tabId !== undefined ? ` · tab ${ev.tabId}` : ''}</span>
        </header>
        <p class="summary">${escapeHtml(ev.summary)}</p>
        ${ev.url ? `<p class="url">${escapeHtml(ev.url)}</p>` : ''}
        ${thumb}
      </article>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="color-scheme" content="dark light" />
  <title>Chrome Browser MCP — Session Audit Report</title>
  <style>
    :root {
      --bg: #111317; --surface: #181b21; --border: #2a2f3a;
      --text: #e6e9ef; --muted: #9aa3b2; --accent: #38e4d4;
      --ok: #10b981; --warn: #f59e0b; --err: #ef4444;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f6f7f9; --surface: #ffffff; --border: #dce1ea;
        --text: #161922; --muted: #5a6475; --accent: #0d9488;
      }
    }
    body { margin: 0; padding: 28px; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, -apple-system, sans-serif; }
    main { max-width: 920px; margin: 0 auto; }
    h1 { margin: 0 0 6px; font-size: 22px; }
    .sub { color: var(--muted); margin: 0 0 20px; font-size: 13px; }
    .stats { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 22px; }
    .stat { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 8px 14px; font-size: 12px; }
    .event { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; margin-bottom: 12px; }
    .event header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 6px; }
    .meta { color: var(--muted); font-size: 12px; margin-left: auto; }
    .summary { margin: 0; font-size: 13px; }
    .url { margin: 4px 0 0; font-size: 12px; color: var(--muted); word-break: break-all; }
    .badge { font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 999px; letter-spacing: 0.04em; }
    .badge.ok { background: rgba(16,185,129,0.16); color: var(--ok); }
    .badge.warn { background: rgba(245,158,11,0.16); color: var(--warn); }
    .badge.err { background: rgba(239,68,68,0.16); color: var(--err); }
    .badge.info { background: rgba(56,228,212,0.16); color: var(--accent); }
    .thumb { margin-top: 10px; }
    .thumb img { max-width: 100%; max-height: 260px; border-radius: 8px; border: 1px solid var(--border); }
  </style>
</head>
<body>
  <main>
    <h1>Chrome Browser MCP — Session Audit Report</h1>
    <p class="sub">Exported ${escapeHtml(payload.exportedAt)} · Broker v${escapeHtml(payload.brokerVersion)} · ${payload.events.length} event(s)</p>
    <section class="stats">
      <div class="stat">Profiles: <strong>${payload.profiles.length}</strong></div>
      <div class="stat">Scope: <strong>${escapeHtml(payload.policySummary.scopeMode)}</strong></div>
      <div class="stat">Shield: <strong>${payload.policySummary.promptInjectionShield ? 'ON' : 'OFF'}</strong></div>
      <div class="stat">Blocked rules: <strong>${payload.policySummary.blockedDomainsCount}</strong></div>
      <div class="stat">Read-only rules: <strong>${payload.policySummary.readOnlyDomainsCount}</strong></div>
    </section>
    ${rows || '<p class="sub">No events recorded in this session.</p>'}
  </main>
</body>
</html>`;
}
