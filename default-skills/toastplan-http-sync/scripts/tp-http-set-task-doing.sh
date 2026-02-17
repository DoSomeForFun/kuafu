#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <task_id>" >&2
  exit 1
fi

TASK_ID="$1"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_toastplan_http_common.sh
source "${SCRIPT_DIR}/_toastplan_http_common.sh"

ARGS_JSON="$(node -e '
const [taskId] = process.argv.slice(1);
process.stdout.write(JSON.stringify({ id: taskId, status: "doing" }));
' "${TASK_ID}")"

tp_http_call_tool "update_task" "${ARGS_JSON}"
