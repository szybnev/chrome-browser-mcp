#!/usr/bin/env bash
set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [[ -L "${SOURCE}" ]]; do
  DIR="$(cd -P "$(dirname "${SOURCE}")" >/dev/null 2>&1 && pwd)"
  SOURCE="$(readlink "${SOURCE}")"
  [[ "${SOURCE}" != /* ]] && SOURCE="${DIR}/${SOURCE}"
done
SCRIPT_DIR="$(cd -P "$(dirname "${SOURCE}")" >/dev/null 2>&1 && pwd)"
PLUGIN_ROOT="$(cd -P "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd -P "${SCRIPT_DIR}/../../.." >/dev/null 2>&1 && pwd)"

BUNDLED_CLI="${PLUGIN_ROOT}/server/cli.js"
LOCAL_CLI="${REPO_ROOT}/packages/server/dist/cli.js"

resolve_node() {
  if [[ -n "${CLAUDE_MCP_NODE_PATH:-}" && -x "${CLAUDE_MCP_NODE_PATH}" ]]; then
    printf '%s\n' "${CLAUDE_MCP_NODE_PATH}"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node "${HOME}/.volta/bin/node"; do
    if [[ -x "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  if [[ -d "${HOME}/.nvm/versions/node" ]]; then
    local nvm_node=""
    nvm_node="$(find "${HOME}/.nvm/versions/node" -maxdepth 3 -type f -path '*/bin/node' 2>/dev/null | sort -V | tail -n 1 || true)"
    if [[ -n "${nvm_node}" && -x "${nvm_node}" ]]; then
      printf '%s\n' "${nvm_node}"
      return 0
    fi
  fi
  return 1
}

NODE_BIN="$(resolve_node || true)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "[chrome-browser-mcp] Error: Node.js (>=22) not found on PATH, CLAUDE_MCP_NODE_PATH, Homebrew, or nvm." >&2
  exit 1
fi

if [[ -n "${CHROME_BROWSER_MCP_CLI:-}" && -f "${CHROME_BROWSER_MCP_CLI}" ]]; then
  exec "${NODE_BIN}" "${CHROME_BROWSER_MCP_CLI}" stdio "$@"
elif [[ -f "${LOCAL_CLI}" ]]; then
  exec "${NODE_BIN}" "${LOCAL_CLI}" stdio "$@"
elif [[ -f "${BUNDLED_CLI}" ]]; then
  exec "${NODE_BIN}" "${BUNDLED_CLI}" stdio "$@"
else
  echo "[chrome-browser-mcp] Error: bundled server CLI not found at ${BUNDLED_CLI} (or repo build ${LOCAL_CLI})." >&2
  echo "[chrome-browser-mcp] Rebuild with 'pnpm build' (or set CHROME_BROWSER_MCP_CLI)." >&2
  exit 1
fi
