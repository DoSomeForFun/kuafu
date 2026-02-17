#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 <task_id> <sender_id> <content>" >&2
  exit 1
fi

TASK_ID="$1"
SENDER_ID="$2"
CONTENT="$3"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_toastplan_http_common.sh
source "${SCRIPT_DIR}/_toastplan_http_common.sh"

ARGS_JSON="$(node -e '
const [taskId, senderId, content] = process.argv.slice(1);
process.stdout.write(JSON.stringify({ taskId, senderId, content }));
' "${TASK_ID}" "${SENDER_ID}" "${CONTENT}")"

tp_http_call_tool "save_task_message" "${ARGS_JSON}"
