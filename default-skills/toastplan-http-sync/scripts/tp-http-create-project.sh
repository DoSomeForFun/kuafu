#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 7 ]]; then
  echo "Usage: $0 <title> <year> [description] [category] [color] [linked_goal_id] [is_ai_autonomous:true|false]" >&2
  exit 1
fi

TITLE="$1"
YEAR="$2"
DESCRIPTION="${3:-}"
CATEGORY="${4:-general}"
COLOR="${5:-}"
LINKED_GOAL_ID="${6:-}"
IS_AI_AUTONOMOUS="${7:-false}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_toastplan_http_common.sh
source "${SCRIPT_DIR}/_toastplan_http_common.sh"

ARGS_JSON="$(node -e '
const [title, year, description, category, color, linkedGoalId, isAiAutonomousRaw] = process.argv.slice(1);
const payload = {
  title,
  year: Number(year),
  category,
  isAiAutonomous: String(isAiAutonomousRaw).toLowerCase() === "true"
};
if (description) payload.description = description;
if (color) payload.color = color;
if (linkedGoalId) payload.linkedGoalId = linkedGoalId;
process.stdout.write(JSON.stringify(payload));
' "${TITLE}" "${YEAR}" "${DESCRIPTION}" "${CATEGORY}" "${COLOR}" "${LINKED_GOAL_ID}" "${IS_AI_AUTONOMOUS}")"

tp_http_call_tool "create_project" "${ARGS_JSON}"
