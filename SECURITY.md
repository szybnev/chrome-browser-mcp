# Security Policy

## Supported Versions

| Version | Supported              |
| ------- | ---------------------- |
| `1.x`   | ✅ Yes                 |
| `< 1.0` | ❌ Upgrade to `1.0.0+` |

## Architecture & Trust Boundaries

Chrome Browser MCP is designed as a **100% local-first** bridge:

- The companion broker binds strictly to loopback (`127.0.0.1`) with Host/Origin validation and a per-machine pairing token.
- Agents are scoped by default to the dedicated cyan **AI Agent** tab group; sensitive domains (banking, password managers, `chrome://*`) are hard-blocked by default.
- Untrusted web content is filtered for hidden/zero-opacity/offscreen traps, stripped of invisible Unicode/bidi-override characters, scanned for prompt-injection phrases, and wrapped in `<<<UNTRUSTED_PAGE_CONTENT>>>` boundaries.
- Password inputs are masked (`{{PASSWORD}}`) in recorded workflows and gated behind explicit user approval.

## Reporting a Vulnerability

**Please DO NOT open a public GitHub issue for security vulnerabilities.**

Instead, report vulnerabilities privately via **GitHub Security Advisories**:

- https://github.com/szybnev/chrome-browser-mcp/security/advisories/new

Please include:

1. Affected component (`packages/extension`, `packages/server`, `packages/protocol`, or `packages/mcp-app`) and version.
2. Clear reproduction steps or proof-of-concept.
3. Potential impact (e.g., loopback auth bypass, domain blocklist bypass, prompt-injection shield bypass, XSS/CSP escape, credential leak).

### Response Timeline

- **Acknowledgement**: within 48 hours.
- **Triage & fix plan**: within 5 business days.
- **Coordinated disclosure**: once a patched release is published to GitHub Releases and Chrome Web Store.
