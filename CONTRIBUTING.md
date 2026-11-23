# Contributing to Chrome Browser MCP

Thank you for your interest in contributing! This project is a TypeScript + pnpm monorepo built on **Node 24/26**, **TypeScript 7**, and **Vite 8 (Rolldown)**.

## Local Setup

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm security:check
```

To test the Chrome Extension locally:
1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select `packages/extension/dist`.
3. Run `node packages/server/dist/cli.js token` and paste the token into the extension's **Pair** tab.

## Workspace Layout

- `packages/protocol` — Shared Zod v4 schemas, RPC envelope, Prompt-Injection Shield (`shield.ts`), Snapshot Diff engine (`diff.ts`), and version SSOT.
- `packages/server` — Local Broker Daemon (Streamable HTTP `/mcp`, `stdio` shim, WebSocket Hub `/ws`, 15 model tools + 7 app-only tools).
- `packages/extension` — Chrome MV3 Extension (Service Worker, Content Script, On-Demand CDP Manager, Control HUD Side Panel).
- `packages/mcp-app` — Antigravity Browser Control Deck MCP App (`ui://chrome-browser/deck.html`).
- `plugins/antigravity` — Antigravity plugin manifest and skill.

## Versioning & Releases

Root `package.json` is the **single source of truth** for the version across all packages, `manifest.json`, `plugin.json`, and `packages/protocol/src/version.ts`. Never edit version numbers manually — use:

```bash
pnpm version:set <next-version>
```

## Quality & Security Guardrails

Git hooks (`.githooks/pre-commit`, `.githooks/pre-push`) run automatically after `pnpm install`:
- Secret & static security scan (`scripts/security-check.mjs`)
- Single-source version sync verification (`pnpm version:check`)
- Lockfile SHA-512 & npm registry supply-chain audit + `pnpm audit --audit-level=moderate`
- Full TypeScript 7 typecheck, Vite 8 build, and Vitest test suite

If your PR changes Chrome Extension permissions, host permissions, privacy behavior, or major UI features, please also update `CHROMEWEBSTORE.md` (and `PRIVACY.md` if applicable).
