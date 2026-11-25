# Changelog

All notable changes to **Chrome Browser MCP** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [2.3.0] - 2026-11-25

### Added

- **Collapsible & Clearable Latest Viewport Capture in Browser Control Deck**: fold the viewport screenshot card into a compact single-line header (`<details>` disclosure persisted in `localStorage`) or clear it immediately across all connected Decks (`deck_clear_diagnostics` with `target: "screenshot"`). Supported in Google Antigravity, Codex Desktop, OpenChamber Desktop, OpenCode Desktop, and Claude Desktop Mod.

## [2.2.0] - 2026-11-25

### Added

- **Browser Control Deck for Codex Desktop, OpenCode Desktop, and OpenChamber Desktop**: view connected Chrome profiles and AI Agent tabs in each application's side panel. Codex and OpenChamber also provide a standalone Deck view.

### Fixed

- Desktop plugins load their bundled server from installed copies. OpenCode and OpenChamber report an incompatible running broker when it lacks the Deck endpoint.

## [2.1.1] - 2026-11-25

### Fixed

- **Prevent duplicate context menu ID error on startup/update**: serialized `initializeExtension()` and context menu registration (`createContextMenuRegistrar`) with single-flight deduplication, explicit `chrome.runtime.lastError` handling on `removeAll`/`create`/`update`, and a duplicate-ID fallback to `chrome.contextMenus.update`, eliminating `Unchecked runtime.lastError: Cannot create item with duplicate id chrome-browser-mcp-toggle-tab` when `onInstalled` and `onStartup` race.
- **Consume `chrome.runtime.lastError` on Native Messaging disconnect**: read `chrome.runtime.lastError?.message` in `port.onDisconnect` so failed native host disconnects surface cleanly without logging an unchecked error.

## [2.1.0] - 2026-11-24

### Security

- **Authenticated Streamable HTTP `/mcp` & Capability-Gated Control Deck (`F-01`, `R-04`)**: `POST /mcp` now requires `Authorization: Bearer <token>` or `x-broker-token`; all privileged mutating `deck_*` tools validate a per-server / per-broker `deckSecret` via `timingSafeEqual` so LLM agents cannot mutate policies, approvals, or pause state.
- **Authenticated 6-Digit PIN Minting (`F-02`)**: removed unauthenticated PIN generation from `GET /pair` and `POST /pair/request-pin`; PINs are now minted exclusively via the 1-click **Generate PIN** button in Browser Control Deck (`deck_create_pin`) or CLI (`node packages/server/dist/cli.js pair`), with `X-Frame-Options: DENY`, strict `CSP`, `CORP: same-origin`, and `415` enforcement on non-JSON `/pair/exchange`.
- **Tab-Group & MV3 Isolation Hardening (`F-03`, `F-10`, `R-02`, `R-05`)**: removed `attach` from agent-callable `browser_tabs`, enforced `userInitiated === true` + `isUrlBlocked` in `tabs.attach`, restricted `tabs.detach` to AI Agent group tabs, switched the in-page HUD to a closed Shadow DOM with `ev.isTrusted` on the Pause pill, and enforced extension-origin sender verification on all `sp.*` and `recorder.step` messages (preserving `welcome.html` onboarding).
- **Zero-Secret & Filesystem Upload Protection (`F-04`, `F-08`, `F-09`)**: removed `/internal/resolve-secret` and resolved/scrubbed secrets strictly inside `BrowserBrokerHub`; restricted Zero-Secret autofill to `<input type="password">` targets; defaulted `uploadAllowedDirs` fail-closed to `[~/Downloads]` with an unremovable sensitive path denylist and pre/post-approval `realpathSync` verification.
- **CDP Proxy Allowlist & Scoped Token (`F-05`, `F-17`)**: replaced the narrow CDP denylist with strict `SAFE_CDP_READ_METHODS` / `SAFE_CDP_MUTATE_METHODS` allowlists, domain checks on `Page.navigate` and `/cdp/browser`, and a separate scoped `cdpToken` (never exposing the master broker token).
- **Live Policies, Origin-Bound Approvals & Complete Gate Coverage (`F-06`, `F-16`, `R-01`, `R-03`)**: routed stdio clients to live broker policy and tab URLs (`/internal/policy`, `/internal/tab-url`), split public `ActionStepSchema` from internal `ExtensionActionStepSchema` (stripping caller-supplied `preApproved`/`isSecret`), added fail-closed `expectedOrigin` checks, DOM-level password/payment challenges (including `selector`, `(x, y)`, `Enter`, `Space`, and `forceCdp`), approval gates on `browser_workflows(replay)`, `browser_webmcp_call`, and `dialogPolicy: "approval"`.
- **URL Normalization, Prompt-Injection Shield & ReDoS Hardening (`F-07`, `F-11`–`F-15`, `F-18`–`F-20`)**: expanded default blocked schemes (`file://*`, `javascript:*`, `data:*`, `blob:*`, `view-source:*`), normalized trailing DNS dots, collapsed `//`, `%XX`, and `:port`, enforced post-redirect and iframe domain/read-only checks, added per-call random nonces to `<<<UNTRUSTED_PAGE_CONTENT>>>` across all page-derived tools, stripped Unicode Tag characters & hidden `<pre>`/table/CSS traps, timed out `discoverWebMcp` at 300ms, fixed polynomial ReDoS in `redactSensitiveBody` and wildcard matching, hardened Playwright export escaping, enforced `0o700`/`0o600` file permissions, POSIX-quoted `native-host.sh`, and validated loopback `wsUrl` & `data:image/*` thumbnails.

### Added

- **1-Click Generate PIN & Reliable Sandbox Copy in Browser Control Deck**: generates a 2-minute single-use PIN directly from Antigravity with automatic clipboard copy (`navigator.clipboard` → `execCommand('copy')` → safe 6-digit OS clipboard fallback).
- **Separate Clear Buttons in DevTools Tab**: clear **Console Errors & Warnings** and **Failed Network Requests** independently in Browser Control Deck.
- **Strict Biome 2.6 Checker & Linter**: `pnpm check` (`biome check --error-on-warnings .`) enforced across `package.json`, `.githooks/pre-commit`, `.githooks/pre-push`, and GitHub Actions CI.

### Changed & Fixed

- Moved the Side Panel language selector into the top header next to the theme toggle (matching Browser Control Deck).
- Fixed Browser Control Deck Light/Dark theme toggle overriding host inline `color-scheme` styles.
- Guarded workflow recording against `chrome://` and Chrome Web Store URLs and upgraded `buildSelectorHint` to produce unique Playwright-safe selectors (avoiding ephemeral React `_R_...` IDs).
- Kept file exports (`.spec.ts` / JSON audit reports) in Chrome Side Panel only.

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
