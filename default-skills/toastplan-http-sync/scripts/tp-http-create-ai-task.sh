#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 || $# -gt 5 ]]; then
  echo "Usage: $0 <title> <date:YYYY-MM-DD> <notes> [linked_project_id] [linked_outcome_id]" >&2
  exit 1
fi

TITLE="$1"
DATE_VALUE="$2"
NOTES="$3"
PROJECT_ID="${4:-}"
OUTCOME_ID="${5:-}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_toastplan_http_common.sh
source "${SCRIPT_DIR}/_toastplan_http_common.sh"

if [[ -z "${PROJECT_ID}" ]]; then
  PROJECT_ID="${TP_DEFAULT_PROJECT_ID}"
fi

ARGS_JSON="$(node -e '
const [title, dateValue, notes, projectId, outcomeId] = process.argv.slice(1);
const payload = {
  title,
  date: dateValue,
  notes,
  linkedProjectId: projectId,
  isAiActive: true
};
if (outcomeId) payload.linkedOutcomeId = outcomeId;
process.stdout.write(JSON.stringify(payload));
' "${TITLE}" "${DATE_VALUE}" "${NOTES}" "${PROJECT_ID}" "${OUTCOME_ID}")"

tp_http_call_tool "create_task" "${ARGS_JSON}"
