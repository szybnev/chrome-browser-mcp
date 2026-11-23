#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
LOCAL_CLI="${REPO_ROOT}/packages/server/dist/cli.js"

if [[ -f "${LOCAL_CLI}" ]]; then
  exec node "${LOCAL_CLI}" stdio "$@"
else
  exec npx -y chrome-browser-mcp stdio "$@"
fi
