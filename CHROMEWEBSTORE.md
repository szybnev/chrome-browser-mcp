# Chrome Web Store Listing — Chrome Browser MCP

> Last Updated: 2026-11-23

## Store Listing

**Extension Name** [REQUIRED]
Chrome Browser MCP — AI Agent Bridge

**Short Description** [REQUIRED]
Connect local AI coding assistants to your real browser tabs with one-click tab grouping, workflow recording, and instant pause.

**Detailed Description** [REQUIRED]
Chrome Browser MCP lets your local AI assistants safely view, navigate, test, and automate your real browser sessions without launching separate logged-out windows.

Key features:
Work in a dedicated AI Agent tab group so assistants only touch tabs you share
Attach or detach any tab in one click, or pause all automation instantly
Review live action logs, approve sensitive steps, and protect private domains with an editable blocklist
Record step-by-step browser flows by hand and reuse them with your assistant
Inspect console errors, network failures, and accessibility checks directly from your assistant
Switch smoothly between Dark and Light themes with persistent preferences
Connect multiple browser profiles at the same time on your local machine

How to use it:

1. Install Chrome Browser MCP and start the local companion server with `npx chrome-browser-mcp`.
2. Open the extension side panel and confirm the local pairing token.
3. Add tabs to the AI Agent group and connect Antigravity, Claude Code, Cursor, or any MCP-compatible client.

Privacy and control:
All communication stays strictly on your local computer (`127.0.0.1`). No browsing data, page content, or telemetry is ever sent to our servers. Banking and password-manager domains are blocked by default, and password inputs are automatically masked when recording workflows.

Support and source code:
https://github.com/szybnev/chrome-browser-mcp

**Category** [REQUIRED]
Developer Tools

**Single Purpose** [REQUIRED]
Bridge user-selected browser tabs to a locally running Model Context Protocol (MCP) companion server for AI-assisted testing and automation.

**Primary Language** [REQUIRED]
English

## Graphics & Assets

| Asset                            | Dimensions                      | Status   | Filename                                                |
| -------------------------------- | ------------------------------- | -------- | ------------------------------------------------------- |
| Store Icon [REQUIRED]            | 128×128 PNG                     | ✅ Ready | `packages/extension/public/icons/icon-128.png`          |
| Screenshot 1 [REQUIRED]          | 1280×800 PNG (24-bit, no alpha) | ✅ Ready | `release/store-assets/screenshot-1-control-hud.png`     |
| Screenshot 2 [RECOMMENDED]       | 1280×800 PNG (24-bit, no alpha) | ✅ Ready | `release/store-assets/screenshot-2-security-themes.png` |
| Small Promo Tile [RECOMMENDED]   | 440×280 PNG (24-bit, no alpha)  | ✅ Ready | `release/store-assets/promo-tile-440x280.png`           |
| Extension Package ZIP [REQUIRED] | Clean MV3 build                 | ✅ Ready | `release/chrome-browser-mcp-extension.zip`              |

## Permissions Justification

| Permission              | Type                 | Justification                                                                                                                                                                                                                                                                  |
| ----------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tabs`                  | permissions          | Required to list tab titles and URLs in the user's AI Agent tab group, focus or open tabs requested by the local assistant, and enforce the domain blocklist.                                                                                                                  |
| `tabGroups`             | permissions          | Required to create and manage the dedicated colored "AI Agent" tab group so users can clearly see and isolate which tabs an assistant is allowed to access.                                                                                                                    |
| `sidePanel`             | permissions          | Required to display the Control HUD side panel where users attach tabs, approve sensitive actions, record workflows, and pause automation.                                                                                                                                     |
| `storage`               | permissions          | Required to persist local pairing settings, theme preferences, domain allow/block lists, security preferences, and locally recorded workflows.                                                                                                                                 |
| `alarms`                | permissions          | Required to periodically verify and restore the local connection to the user's companion server after browser idle or system sleep.                                                                                                                                            |
| `scripting`             | permissions          | Required to inspect page structure, extract readable text, render the visual highlight border on active agent tabs, and record user-initiated workflows on tabs the user shares.                                                                                               |
| `debugger`              | permissions          | Required on demand for tabs the user shares with the assistant in order to send reliable clicks and keystrokes, capture screenshots, read accessibility trees across iframes, and inspect console and network errors for debugging. Automatically detaches after idle timeout. |
| `contextMenus`          | permissions          | Required to provide a right-click menu action to attach or detach the current tab to the AI Agent group with immediate feedback.                                                                                                                                               |
| `downloads`             | optional_permissions | Requested only if the user opts in under Security → Advanced Settings to let local assistants list or wait for completed browser downloads (`browser_downloads`).                                                                                                              |
| `nativeMessaging`       | optional_permissions | Requested only if the user opts in under Security → Advanced Settings to connect via a locally installed Chrome Native Messaging Host instead of loopback WebSocket.                                                                                                           |
| `declarativeNetRequest` | permissions          | Experimental (`exp/content-negotiation` branch only): adds a scoped MV3 session rule modifying the `Accept` header (`text/markdown`) solely on main-frame navigations inside user-shared AI Agent tabs when "Prefer Markdown" is enabled.                                      |
| `<all_urls>`            | host_permissions     | Required because users can choose to attach any website they are developing or automating into the AI Agent tab group. Sensitive domains are blocked by default via the built-in domain blocklist.                                                                             |

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** No

All page content, tabs, and diagnostics are processed strictly locally between the browser extension and the user's own companion server on `127.0.0.1`. No data is collected, transmitted off-device by the extension, or shared with third parties.

### Data Use Certification

- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Privacy Policy

**Privacy Policy URL** [REQUIRED]
https://github.com/szybnev/chrome-browser-mcp/blob/main/PRIVACY.md

## Distribution

**Visibility**: Public
**Regions**: All regions

## Developer Info

**Publisher Name** [REQUIRED]
szybnev

**Publisher ID**
`865bc92f-dbf2-441f-b163-112b5a2c7a26`

**Support URL / Email** [RECOMMENDED]
https://github.com/szybnev/chrome-browser-mcp/issues

**Homepage URL** [RECOMMENDED]
https://github.com/szybnev/chrome-browser-mcp

## Automated Publishing via GitHub Actions (Chrome Web Store API v2)

This repository includes an automated CI/CD release pipeline in [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) powered by our zero-dependency API v2 publisher script [`scripts/publish-cws.mjs`](./scripts/publish-cws.mjs).

### One-Time Prerequisites

1. **First manual upload (required by Google)**: Chrome Web Store API v2 cannot create brand-new items. Upload `release/chrome-browser-mcp-extension.zip` once in the [Developer Dashboard](https://chrome.google.com/webstore/devconsole/865bc92f-dbf2-441f-b163-112b5a2c7a26), complete the Store Listing + Privacy tabs using the sections above, and copy your 32-character **Extension ID**.
2. **Enable Chrome Web Store API in Google Cloud Console**:
   - Create/select a Google Cloud project → **APIs & Services → Library** → enable **Chrome Web Store API**.
   - **OAuth consent screen**: choose External (or Internal), add your developer email as a Test User, and add scope `https://www.googleapis.com/auth/chromewebstore`.
   - **Credentials → Create Credentials → OAuth client ID** (Desktop app or Web app with redirect URI `https://developers.google.com/oauthplayground`).
   - Use [Google OAuth 2.0 Playground](https://developers.google.com/oauthplayground/) (gear icon → **Use your own OAuth credentials**, scope `https://www.googleapis.com/auth/chromewebstore`) to obtain a **Refresh Token**.
3. **Add 5 GitHub Repository Secrets** (`Settings → Secrets and variables → Actions → New repository secret`):
   - `CWS_PUBLISHER_ID`: `865bc92f-dbf2-441f-b163-112b5a2c7a26`
   - `CWS_EXTENSION_ID`: _(32-char ID from Chrome Web Store Dashboard)_
   - `CWS_CLIENT_ID`: _(Google Cloud OAuth Client ID)_
   - `CWS_CLIENT_SECRET`: _(Google Cloud OAuth Client Secret)_
   - `CWS_REFRESH_TOKEN`: _(OAuth Refresh Token)_

### How Releases Work After Setup

- Every push to `main` runs full **Security + Typecheck + Build + Test** and attaches a downloadable `chrome-browser-mcp-extension.zip` artifact.
- When you want to publish a new version to the Chrome Web Store, simply bump the single source of truth version and push to `main`:

  ```bash
  pnpm version:set 0.2.1
  git add -A && git commit -m "release: v0.2.1" && git push origin main
  ```
- After `verify` passes, `publish-cws` queries `:fetchStatus` on Chrome Web Store API v2:
  - If the version in `manifest.json` is **newer** than the published/submitted store version (and no earlier revision is `PENDING_REVIEW`), it automatically uploads the `.zip` via `:upload`, waits for async processing, and submits via `:publish` (`DEFAULT_PUBLISH`).
  - If the version has **not** been bumped (e.g. README/docs updates on `main`), it skips cleanly with exit code 0.

## Version History

| Version | Date       | Changes                                                                                                                                                                                                                                                                                                          | Status    |
| ------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1.0.0   | 2026-11-24 | Production v1.0.0 release: unified Antigravity Dark/Light theme, Bridge Aperture icons, push-port side panel, native `checkVisibility()` + `MutationObserver` runtime speedups, `maxWidth` screenshot downscaling, Node 26 / TS 7 / Vite 8 toolchain, and automated CWS API v2 + GitHub Releases CI/CD.          | Ready     |
| 0.2.0   | 2026-11-23 | Auto-discover manual "AI Agent" Chrome tab groups across reloads, dedicated AI Agent Tabs card, virtualized searchable list for 100+ tabs, top-level Timeline tab, paginated `browser_read` (offset up to 200k), Shadow DOM / same-origin iframe / rich Markdown tables, and PerformanceObserver LCP/CLS audits. | In Review |
| 0.1.0   | 2026-11-23 | Initial MV3 release: Hybrid engine, Agent Tab Group, Workflow Recorder, Control HUD Side Panel, WebMCP bridge, and local MCP companion server.                                                                                                                                                                   | Draft     |

## Review Notes

### Known Issues / Limitations

- Uses `chrome.debugger` strictly on demand for user-shared tabs and detaches automatically when idle; requires a clear reviewer demo video or clear instructions showing the local companion server (`npx chrome-browser-mcp`) and side panel controls.
