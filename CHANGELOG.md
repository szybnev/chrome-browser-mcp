# Changelog

All notable changes to **Chrome Browser MCP** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [2.0.0] - 2026-11-24

### Added
- **Multi-Frame (`iframe`) & Shadow DOM Traversal**: `browser_snapshot` automatically indexes cross-origin and nested iframes (`f<frameId>:e1` refs) + open Shadow DOM, with optional CDP closed Shadow DOM fallback (`includeClosedShadow: true`).
- **File Uploads (`upload` step) & Optional Downloads (`browser_downloads`)**: approval-gated local file upload via on-demand CDP `DOM.setFileInputFiles` (with canonical path & optional directory allowlist checks) and opt-in Chrome `downloads` tracking.
- **Native JavaScript Dialog Handling (`browser_dialog`)**: non-blocking CDP interception for `alert`, `confirm`, `prompt`, and `beforeunload` dialogs, plus Accept/Dismiss controls in Side Panel and Control Deck.
- **Structured Tables & PDF Extraction (`browser_read`)**: new `format: "tables_json" | "tables_csv"` modes and automatic in-tab PDF text extraction.
- **Parameterized Workflows (`{{var}}`) & Playwright Export**: variable interpolation on `browser_workflows(action="replay", variables={...})` and clean Playwright `.spec.ts` export from MCP, Side Panel, and Control Deck.
- **Opt-In Local CDP Proxy**: `--enable-cdp-proxy` / Advanced Settings toggle exposing `/json/version`, `/json/list`, and `/cdp/:tabId` over `127.0.0.1` while enforcing AI Agent Tab Group, `blockedDomains`, `readOnlyDomains`, and Emergency Pause.
- **Network Response Body Inspection**: `browser_network(includeBodyForRequestId=...)` with automatic JWT, Bearer, and JSON secret redaction + Prompt-Injection Shield framing.
- **Device, Viewport, Color Scheme & Network Emulation (`browser_emulate`)**: one-call mobile/desktop presets (`iphone-15`, `pixel-9`, `ipad`, `desktop`, `reset`), `light`/`dark`, `fast-3g`/`slow-3g`/`offline`, and geolocation.
- **Per-Domain Read-Only Mode (`readOnlyDomains`)**: allows reading tools while escalating mutations to explicit Human-in-the-Loop approval, with 1-click presets (`mail.google.com`, `github.com`, `linear.app`, `notion.so`).
- **Zero-Secret Autofill (`secretRef`)**: broker-local resolution for `env:VAR` (`secrets.env` / `CBMCP_SECRET_*`) and macOS `keychain:ACCOUNT` so credentials never enter LLM context or logs.
- **Session Audit & HTML/JSON Replay Export (`browser_audit_export`)**: export self-contained dark/light HTML reports and structured JSON logs from MCP, Side Panel, or Control Deck.
- **1-Click 6-Digit PIN Pairing & Optional Native Messaging Host**: `chrome-browser-mcp pair` (2-minute single-use PIN) and `chrome-browser-mcp install-host --extension-id=<ID>`.
- **Optional Visual Agent Cursor & In-Page HUD**: smooth animated cursor, element spotlight, and clickable in-page `Pause` pill — enabled by default with a clean toggle in Side Panel settings and onboarding.
- **Full UI Localization (`EN` / `RU` / `中文`)**: zero-dependency typed i18n across Side Panel, Welcome Wizard, and Antigravity Control Deck.
- **Interactive First-Install Onboarding Tour**: automatic 4-step `welcome.html` setup wizard on fresh install + in-SidePanel guided spotlight tour (`OnboardingTour.tsx`) and a "Replay Interactive Tour" button.
- **Progressive Disclosure UI**: power-user controls folded cleanly under collapsible **Advanced Settings** / **Advanced Connection** panels.

## [1.0.0] - 2026-11-24

### Added
- **Unified Google Antigravity UI (Dark & Light)** across both Chrome Side Panel and Antigravity Browser Control Deck MCP App, with WCAG 2.1 AA/AAA verified contrast and a persistent, zero-FOUC theme toggle.
- **Bridge Aperture brand icons** (`16/48/128px` 4×4 SSAA PNG + SVG) and Chrome Web Store submission readiness (`CHROMEWEBSTORE.md`, automated Chrome Web Store API v2 publisher in `scripts/publish-cws.mjs`).
- **Automated GitHub Releases & GitHub Packages** publishing on version bumps to `main`, alongside Chrome Web Store API v2 auto-publish.
- **Repository governance & templates**: structured Issue Forms (`bug`, `feat`, `vuln`/hardening, general issue), Pull Request template, `SECURITY.md`, `CONTRIBUTING.md`, `CODEOWNERS`, and Dependabot config.
- **In-browser screenshot downscaling** (`maxWidth` via `OffscreenCanvas`) for faster vision inference.

### Changed
- **Modernized toolchain**: upgraded to **Node 26 LTS** (`engines.node >= 24.0.0`), **TypeScript 7.0** (`tsgo`), and **Vite 8.3** (Rolldown) with single-process 3× parallel extension builds (~100ms).
- **End-to-end runtime performance**:
  - Native `el.checkVisibility()` fast-path and `MutationObserver`-driven `wait` steps in Content Script.
  - Optimistic single-hop Content Script IPC (`injectedTabs` cache), write-through `chrome.storage` caching, and tab-snapshot fingerprint deduplication.
  - Persistent `chrome.runtime.connect` push port in Chrome Side Panel (replacing 3s polling) and visibility-aware adaptive cadence in Browser Control Deck.
  - Single-pass Prompt-Injection Shield pre-filter, cached wildcard `RegExp`s, zero-allocation snapshot diffing, and `perMessageDeflate: false` on loopback WebSocket.

### Fixed
- Removed double accent border on attached tabs inside `AI Agent Tabs`.
- Cleaned stale ZIP entries before packing Chrome Web Store releases (`scripts/pack-cws.mjs`).

## [0.2.0] - 2026-11-23

### Added
- Auto-discovery of manually created `"AI Agent"` Chrome tab groups across browser reloads.
- Dedicated `AI Agent Tabs` card, adaptive full-height virtualized searchable list for 100+ tabs, and top-level `Timeline` tab.
- Paginated `browser_read` (`offset`, `maxChars` up to 200k, `scope: "main" | "body"`, `[TABS: ...]` hints), Shadow DOM / same-origin iframe / rich Markdown tables, and redirect reporting.
- Background `Focus` switching by default (`Shift+Click` to bring browser window to front) and accessible Security `InfoTip` toggletips.
- Single-source-of-truth versioning (`scripts/sync-version.mjs`).

### Fixed
- Replaced deprecated `performance.getEntriesByType` LCP/CLS calls with `PerformanceObserver({ buffered: true })`.

## [0.1.0] - 2026-11-23

### Added
- Initial Chrome MV3 Extension + MCP v2 Local Broker Daemon (Streamable HTTP + auto-spawn `stdio` shim) + Antigravity Browser Control Deck MCP App.
- Hybrid Content Script + On-Demand `chrome.debugger` CDP engine, WebMCP (`navigator.modelContext`) bridge, Prompt-Injection Shield, Workflow Recorder with password masking, and local security/supply-chain git hooks.
