#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 <tool_name> [arguments_json]" >&2
  echo "Example: $0 create_task '{\"title\":\"Test\",\"date\":\"2026-02-11\",\"notes\":\"demo\",\"isAiActive\":true}'" >&2
  exit 1
fi

TOOL_NAME="$1"
ARGS_JSON="${2:-{}}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_toastplan_http_common.sh
source "${SCRIPT_DIR}/_toastplan_http_common.sh"

tp_http_call_tool "${TOOL_NAME}" "${ARGS_JSON}"
