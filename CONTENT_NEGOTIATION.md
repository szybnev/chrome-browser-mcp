# Experimental Branch: `exp/content-negotiation` (`Accept: text/markdown`)

> [!WARNING]
> **Maintenance Policy — No Automatic Rebase Against `main`**
>
> This branch (`exp/content-negotiation`) is provided strictly as an **opt-in reference implementation** for users who explicitly want HTTP Content Negotiation (`Accept: text/markdown`).
>
> **The repository author does not use this feature on `main` and will NOT maintain or rebase this branch as `main` evolves.** If you want this feature on top of newer `main` releases, use the ready-to-paste [AI Agent Rebase Prompt](#ai-agent-rebase-prompt) below.

---

## Why This Feature Is Not on `main`

Chrome Browser MCP is designed to operate in your real daily browser session with minimal permissions and minimal attack surface. Sending `Accept: text/markdown` on browser navigations introduces three deliberate tradeoffs that do not fit `main`:

1. **Anti-Bot / WAF Fingerprinting**: Standard desktop browsers never send `Accept: text/markdown` as their top-priority `MAIN_FRAME` header. Sites behind Cloudflare, Akamai, DataDome, or PerimeterX can trivially use it as an automation signal and trigger extra CAPTCHAs or 403 blocks.
2. **Cloaking / Split-View Prompt-Injection Risk**: Because the server can inspect `Accept: text/markdown`, a malicious or compromised site can serve completely different content to the agent than what a human sees in HTML — injecting hidden prompt-override instructions into the Markdown response that are invisible during normal browsing. (Keep **Prompt-Injection Shield** enabled; it still wraps and scans native Markdown responses.)
3. **Extra Chrome Extension Permission & UX Surprises**: Modifying request headers in MV3 requires the `declarativeNetRequest` permission (extra Chrome Web Store review scrutiny), and when a site *does* return `Content-Type: text/markdown`, Chrome displays raw text (`<pre>`) instead of the interactive HTML UI until you navigate with `preferMarkdown: false`.

For the ~99% of websites that serve standard HTML/SPA pages, `main` already delivers high-fidelity DOM/Shadow-DOM/iframe Markdown extraction, paginated `browser_read`, and WebMCP support without altering HTTP headers.

---

## What This Branch Adds

All changes are intentionally small, isolated, and reversible:

| File | Purpose |
| :--- | :--- |
| `packages/protocol/src/schemas.ts` | Adds `preferMarkdown: z.boolean().default(true)` to `SecurityPolicySchema`. |
| `packages/extension/manifest.json` | Adds `"declarativeNetRequest"` permission for MV3 session header rules. |
| `packages/extension/src/background/service-worker.ts` | Registers a single MV3 session rule (`DNR_MARKDOWN_RULE_ID = 43179`) via `chrome.declarativeNetRequest.updateSessionRules` scoped **strictly** to `tabIds` in the AI Agent group and `ResourceType.MAIN_FRAME`. Sets `Accept: text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.9, */*;q=0.8`. Supports per-tab HTML fallback (`htmlOnlyTabOverrides`) and cleans up overrides when tabs close or detach. On `tabs.open`, creates `about:blank` → attaches to agent group → applies DNR rule → navigates so the very first HTTP fetch carries `Accept: text/markdown`. |
| `packages/extension/src/content/content-script.ts` | Detects native `text/markdown`, `text/x-markdown`, and `text/plain` documents (`document.contentType`) in `extractMarkdown()` and extracts raw text cleanly from Chrome's `<pre>` wrapper without double-wrapping in a Markdown code fence. |
| `packages/server/src/mcp-server.ts` | Adds optional `preferMarkdown?: boolean` parameter to `browser_tabs` (`action="open"`) and `browser_navigate` so an agent can request the interactive HTML UI (`preferMarkdown: false`) when needed. |
| `packages/mcp-app/src/App.tsx` & `packages/extension/src/sidepanel/App.tsx` | Adds the **Prefer Markdown (`Accept: text/markdown`)** toggle with a security/tradeoff tooltip in the **Security** tab. |
| `CHROMEWEBSTORE.md` | Documents the `declarativeNetRequest` permission justification for this branch. |

---

## Security & Usage Notes

- **Strictly scoped to agent tabs**: Your normal browsing tabs outside the cyan **AI Agent** tab group never receive modified headers (unless you explicitly enable **Allow all tabs** in Security).
- **Zero persistence of header rules across browser restarts**: Uses `declarativeNetRequest.updateSessionRules` (in-memory session rules only) and removes the rule automatically whenever `preferMarkdown` is toggled off or no agent tabs are open.
- **Keep Prompt-Injection Shield ON**: Even when a site returns native `text/markdown`, the MCP server still applies `UNTRUSTED_PAGE_CONTENT` framing and injection-pattern scanning in `browser_read`.
- **Need interactive HTML on a Markdown-serving site?** Pass `preferMarkdown: false` to `browser_navigate` (or `browser_tabs(action="open")`), or toggle **Prefer Markdown** off in **Security**.

---

## AI Agent Rebase Prompt

If `main` has moved ahead and you want to bring this `Accept: text/markdown` feature up to date on top of the latest `main`, paste the prompt below into your coding agent (Antigravity, Claude Code, Cursor, Codex, etc.) inside a clone of this repository:

```text
You are working in the `chrome-browser-mcp` repository.

Goal: Rebase the experimental `exp/content-negotiation` feature (per-tab `Accept: text/markdown` HTTP Content Negotiation for AI Agent tabs) cleanly onto the latest `origin/main` in a new local branch (e.g. `feat/content-negotiation-rebased`), without modifying `main`.

Steps:
1. Fetch the latest refs (`git fetch origin`) and inspect the diff introduced by `origin/exp/content-negotiation` relative to its merge-base with `origin/main`:
   `git diff $(git merge-base origin/main origin/exp/content-negotiation)..origin/exp/content-negotiation`
2. Create a new branch from `origin/main`:
   `git checkout -b feat/content-negotiation-rebased origin/main`
3. Re-apply or cherry-pick the `exp/content-negotiation` changes onto the new branch. Resolve any conflicts by preserving all newer behavior from `origin/main` while keeping these invariants of the feature:
   - `SecurityPolicySchema` in `packages/protocol/src/schemas.ts` has `preferMarkdown: z.boolean().default(true)`.
   - `packages/extension/manifest.json` includes `"declarativeNetRequest"` in `permissions` (do NOT change the `version` field manually — root `package.json` is the single source of truth via `pnpm version:sync`).
   - `packages/extension/src/background/service-worker.ts` manages a session-only `chrome.declarativeNetRequest.updateSessionRules` rule (`DNR_MARKDOWN_RULE_ID = 43179`) scoped strictly to agent `tabIds` and `ResourceType.MAIN_FRAME`, setting `Accept: text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.9, */*;q=0.8`.
   - `tabs.open` attaches the tab and updates DNR rules before navigating to the target URL so the very first HTTP fetch carries `Accept: text/markdown`.
   - `tabs.open` and `page.navigate` honor an optional `preferMarkdown?: boolean` override (`htmlOnlyTabOverrides` cleaned up on `tabs.onRemoved` and `detachTabFromAgentGroup`).
   - `packages/extension/src/content/content-script.ts` handles native `text/markdown`, `text/x-markdown`, and `text/plain` documents cleanly in `extractMarkdown()` without wrapping them in a fenced code block, while keeping pagination and Prompt-Injection Shield compatibility.
   - `packages/server/src/mcp-server.ts` exposes optional `preferMarkdown?: boolean` on `browser_tabs` and `browser_navigate`.
   - Both Security tabs (`packages/mcp-app/src/App.tsx` and `packages/extension/src/sidepanel/App.tsx`) expose the "Prefer Markdown (Accept: text/markdown)" toggle with a security warning tooltip.
   - Do NOT commit changes to `main`; keep all work on your new branch.
4. Run full verification:
   `pnpm install --frozen-lockfile && pnpm typecheck && pnpm build && pnpm test && pnpm security:check`
5. Summarize any conflicts resolved and confirm all checks pass, then remind me to reload the unpacked Chrome extension from `packages/extension/dist` and restart the local broker daemon if server files changed.
```
