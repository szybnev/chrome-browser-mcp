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

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | `packages/extension/public/icons/icon-128.png` |
| Screenshot 1 [REQUIRED] | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 2 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 3 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Not created | |
| Small Promo Tile [RECOMMENDED] | 440×280 | ⬜ Not created | |

### Screenshot Notes
- Screenshot 1: Chrome Side Panel showing the AI Agent tab group, live action timeline, and Pause/Stop control.
- Screenshot 2: In-page highlight border and workflow recorder capturing a multi-step form flow.
- Screenshot 3: Antigravity Browser Control Deck MCP App synced with live Chrome tabs and DevTools errors.

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `tabs` | permissions | Required to list tab titles and URLs in the user's AI Agent tab group, focus or open tabs requested by the local assistant, and enforce the domain blocklist. |
| `tabGroups` | permissions | Required to create and manage the dedicated colored "AI Agent" tab group so users can clearly see and isolate which tabs an assistant is allowed to access. |
| `sidePanel` | permissions | Required to display the Control HUD side panel where users attach tabs, approve sensitive actions, record workflows, and pause automation. |
| `storage` | permissions | Required to persist local pairing settings, domain allow/block lists, security preferences, and locally recorded workflows. |
| `alarms` | permissions | Required to periodically verify and restore the local connection to the user's companion server after browser idle or system sleep. |
| `scripting` | permissions | Required to inspect page structure, extract readable text, render the visual highlight border on active agent tabs, and record user-initiated workflows on tabs the user shares. |
| `debugger` | permissions | Required on demand for tabs the user shares with the assistant in order to send reliable clicks and keystrokes, capture screenshots, read accessibility trees across iframes, and inspect console and network errors for debugging. Automatically detaches after idle timeout. |
| `contextMenus` | permissions | Required to provide a right-click menu action to attach or detach the current tab to the AI Agent group with immediate feedback. |
| `<all_urls>` | host_permissions | Required because users can choose to attach any website they are developing or automating into the AI Agent tab group. Sensitive domains are blocked by default via the built-in domain blocklist. |

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

**Contact Email** [REQUIRED]
_(fill before CWS submission)_

**Support URL / Email** [RECOMMENDED]
https://github.com/szybnev/chrome-browser-mcp/issues

**Homepage URL** [RECOMMENDED]
https://github.com/szybnev/chrome-browser-mcp

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 0.2.0 | 2026-11-23 | Auto-discover manual "AI Agent" Chrome tab groups across reloads, dedicated AI Agent Tabs card, virtualized searchable list for 100+ tabs, top-level Timeline tab, paginated `browser_read` (offset up to 200k), Shadow DOM / same-origin iframe / rich Markdown tables, and PerformanceObserver LCP/CLS audits. | Draft |
| 0.1.0 | 2026-11-23 | Initial MV3 release: Hybrid engine, Agent Tab Group, Workflow Recorder, Control HUD Side Panel, WebMCP bridge, and local MCP companion server. | Draft |

## Review Notes

### Known Issues / Limitations
- Uses `chrome.debugger` strictly on demand for user-shared tabs and detaches automatically when idle; requires a clear reviewer demo video showing the local companion server (`npx chrome-browser-mcp`) and side panel controls.
