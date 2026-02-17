#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 <task_id> [completed_at_ms]" >&2
  exit 1
fi

TASK_ID="$1"
COMPLETED_AT="${2:-}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_toastplan_http_common.sh
source "${SCRIPT_DIR}/_toastplan_http_common.sh"

if [[ -z "${COMPLETED_AT}" ]]; then
  COMPLETED_AT="$(tp_now_ms)"
fi

ARGS_JSON="$(node -e '
const [taskId, completedAt] = process.argv.slice(1);
process.stdout.write(JSON.stringify({
  id: taskId,
  status: "done",
  completedAt: Number(completedAt)
}));
' "${TASK_ID}" "${COMPLETED_AT}")"

tp_http_call_tool "update_task" "${ARGS_JSON}"
