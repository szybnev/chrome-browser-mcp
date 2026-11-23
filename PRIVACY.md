# Privacy Policy — Chrome Browser MCP

Last Updated: 2026-11-23

Chrome Browser MCP is a **100% local-first** browser extension and companion MCP server.

## 1. Data Collection & Telemetry
- Chrome Browser MCP collects **zero analytics, zero telemetry, and zero tracking data**.
- No browsing history, page content, cookies, credentials, or screenshots are ever sent to the authors of this extension or any remote servers operated by us.

## 2. Local Communication Only
- The extension communicates exclusively with your own locally running companion daemon on `127.0.0.1` (loopback interface), protected by a locally generated pairing token.
- Any page content, accessibility snapshots, console/network diagnostics, or screenshots requested by your local AI agent stay strictly on your machine and are governed by the privacy policy of the AI client you explicitly connect.

## 3. Permissions & User Control
- By default, connected AI agents can only access tabs inside the dedicated **AI Agent** tab group (or tabs you explicitly attach).
- Sensitive domains (such as banking portals and password managers) are blocked by default via an editable domain blocklist.
- Sensitive actions (such as password entry, payment submission, or script evaluation) can require explicit confirmation before execution.
- Workflow recordings mask password inputs automatically and are stored locally in `chrome.storage.local`.

## 4. Local Storage
- Extension settings, pairing token, domain rules, and recorded workflows are stored locally on your device using `chrome.storage.local` and `chrome.storage.session`. You can clear them at any time by resetting or removing the extension.

## 5. Contact
Questions or security reports: https://github.com/szybnev/chrome-browser-mcp/issues
