#!/usr/bin/env bash
set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [[ -L "${SOURCE}" ]]; do
  DIR="$(cd -P "$(dirname "${SOURCE}")" >/dev/null 2>&1 && pwd)"
  SOURCE="$(readlink "${SOURCE}")"
  [[ "${SOURCE}" != /* ]] && SOURCE="${DIR}/${SOURCE}"
done
SCRIPT_DIR="$(cd -P "$(dirname "${SOURCE}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd -P "${SCRIPT_DIR}/../../.." >/dev/null 2>&1 && pwd)"
LOCAL_CLI="${REPO_ROOT}/packages/server/dist/cli.js"

if [[ -n "${CHROME_BROWSER_MCP_CLI:-}" && -f "${CHROME_BROWSER_MCP_CLI}" ]]; then
  exec node "${CHROME_BROWSER_MCP_CLI}" stdio "$@"
elif [[ -f "${LOCAL_CLI}" ]]; then
  exec node "${LOCAL_CLI}" stdio "$@"
else
  echo '[chrome-browser-mcp] Server build not found. Run pnpm build in the source checkout or set CHROME_BROWSER_MCP_CLI.' >&2
  exit 1
fi
