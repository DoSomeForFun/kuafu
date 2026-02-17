#!/usr/bin/env bash
set -euo pipefail

LIMIT="${1:-30}"
PROJECT_ID="${2:-}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_toastplan_http_common.sh
source "${SCRIPT_DIR}/_toastplan_http_common.sh"

if [[ -z "${PROJECT_ID}" ]]; then
  PROJECT_ID="${TP_DEFAULT_PROJECT_ID}"
fi

ARGS_JSON="$(node -e '
const [limit, projectId] = process.argv.slice(1);
process.stdout.write(JSON.stringify({
  statuses: ["todo", "doing"],
  requireAssignedAgent: false,
  linkedProjectId: projectId,
  limit: Number(limit)
}));
' "${LIMIT}" "${PROJECT_ID}")"

tp_http_call_tool "list_runnable_tasks" "${ARGS_JSON}"
