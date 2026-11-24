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

if [[ -f "${LOCAL_CLI}" ]]; then
  exec node "${LOCAL_CLI}" stdio "$@"
else
  exec npx -y chrome-browser-mcp@2.1.0 stdio "$@"
fi
