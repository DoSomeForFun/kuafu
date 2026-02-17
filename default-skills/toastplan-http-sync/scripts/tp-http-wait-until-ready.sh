#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_toastplan_http_common.sh
source "${SCRIPT_DIR}/_toastplan_http_common.sh"

TIMEOUT_SECONDS="${1:-20}"
INTERVAL_SECONDS="${2:-1}"
BASE_URL="$(tp_resolve_base_url)"

DEADLINE=$((SECONDS + TIMEOUT_SECONDS))

while (( SECONDS < DEADLINE )); do
  if curl -sS "${BASE_URL}/api/tools" >/dev/null 2>&1; then
    echo "ready: ${BASE_URL}"
    exit 0
  fi
  sleep "${INTERVAL_SECONDS}"
done

echo "timeout: HTTP service not ready at ${BASE_URL}" >&2
exit 1
