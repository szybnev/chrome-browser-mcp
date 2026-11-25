# AGENTS.md

## Role & Project Goal

Operate as a **Staff TypeScript, Chrome MV3, and MCP Systems Engineer** maintaining **Chrome Browser MCP**: a 100% local-first (`127.0.0.1:43179`, zero telemetry) Chrome MV3 extension, MCP v2 server (`Streamable HTTP`, `stdio` shim, WebSocket Hub), and unified **Browser Control Deck** UI shared across five desktop GUI harnesses — **Google Antigravity**, **Codex Desktop**, **OpenChamber Desktop**, **OpenCode Desktop**, and **Claude Desktop** (Code Mod + `.mcpb`).

Verify runtime, build, test, and CI state directly (`pnpm`, `/health`, `gh`) before reporting done. Preserve unrelated dirty worktree edits, keep broker tokens and unrelated tab contents out of output, and leave the user's open desktop harness windows untouched while the user tests them.

## Architectural & Safety Invariants

- **Fail-closed plugin launchers:** Unscoped `chrome-browser-mcp` on npm belongs to an unrelated third party. Resolve the repo build or each plugin's self-contained bundle (`server/cli.js` + `server/app/deck.html`) and exit with an actionable diagnostic if missing; keep `npx chrome-browser-mcp@*` out of all plugin launchers.
- **Non-destructive live broker handling:** From client or plugin code, report a clear version-mismatch or missing-route diagnostic when connecting to an older broker instead of terminating an active process serving live clients. When the user asks to restart the local broker (`127.0.0.1:43179`), stop only this repository's daemon PID, start the fresh build with `--data-dir=~/.chrome-browser-mcp` to preserve pairing/policy, and verify `/health` shows the new version and reconnected Chrome profile.
- **Loopback-only & MV3 hygiene:** Bind servers strictly to `127.0.0.1`. In the extension Service Worker, probe `/health` (`broker-probe.ts`) before calling `new WebSocket(...)` so an offline broker leaves `chrome://extensions → Errors` clean, consume `chrome.runtime.lastError` in callbacks, and serialize startup/connect paths as single-flight.
- **Cross-harness Deck parity:** Shared Control Deck UI (`packages/mcp-app/src/DeckView.tsx`) and broker actions (`packages/server/src/deck-actions.ts`) power all desktop harnesses; mirror significant Deck controls in `plugins/claude/src/register.ts` as well.

## Commits

- **User-gated:** Commit only when the user explicitly requests it.
- **Format:** Conventional Commits (`feat(scope): ...`, `fix(scope): ...`, `docs(scope): ...`, `ci: ...`, `chore(release): vX.Y.Z`).
- **Hooks & bundles:** Run with repository Git hooks active (keep `.githooks/pre-commit` enforced). Whenever `packages/{protocol,mcp-app,server}` or the version changes, run `pnpm build` and stage the updated tracked plugin bundles (`plugins/{codex,openchamber,opencode,claude}`) alongside source changes.
- **Completion bar before every commit:** `pnpm format`, `pnpm build`, `pnpm check`, `pnpm typecheck`, `pnpm test`, `pnpm version:check`, and `pnpm security:check` all pass green with zero warnings.

## Pushes & CI/CD

- **User-gated:** Push to `origin` only when the user explicitly requests it, with `.githooks/pre-push` active.
- **Post-push verification:** For releases or CI changes, watch the `CI & Security` run (`gh run watch`) and inspect `[release]`, `[publish-gh-packages]`, and `[publish-cws]` logs before reporting completion.
- **Chrome Web Store review gate:** Every version bump triggers a new CWS review. While a prior submission is `PENDING_REVIEW`, `scripts/publish-cws.mjs` skips upload to protect the active review; verify no submission is pending before cutting a new store release.

## Versioning & Releases

- **Single source of truth (SSOT):** Root `package.json` governs all 13 versioned manifests/packages and `packages/protocol/src/version.ts`. Change versions exclusively via:
  ```bash
  pnpm version:set <patch|minor|major|X.Y.Z>
  pnpm format && pnpm build && pnpm version:check
  ```
- **When to bump:** Bump only on explicit user approval for a release, and prepend a Keep a Changelog entry to `CHANGELOG.md`.
- **When to keep version unchanged:** Push README-only, `AGENTS.md`-only, CI-only, or small non-release fixes to `main` without bumping version so they do not queue unnecessary Chrome Web Store reviews.
- **Local sync after a version bump:** Remind the user (or apply when asked) to restart the local broker daemon on `127.0.0.1:43179` so open Browser Control Decks display the new `brokerVersion` and load fresh `deck.html`, and run `pnpm install:local --codex` to refresh Codex's local plugin cache.

## Context Pointers

- **`CHROMEWEBSTORE.md`** — Read and update whenever changing `packages/extension/manifest.json` permissions (`permissions`, `optional_permissions`, `host_permissions`), privacy behavior, or store listing details. Adding new permissions also requires a one-time justification save in the CWS Developer Dashboard before automated `:publish` succeeds.
- **`SECURITY.md` & `PRIVACY.md`** — Consult before altering auth, `/mcp` or `/internal/*` endpoints, domain policies, Zero-Secret handling, or data persistence.
- **`writing-for-agents` skill** — Load before editing `AGENTS.md` or any `SKILL.md` in this repository.
