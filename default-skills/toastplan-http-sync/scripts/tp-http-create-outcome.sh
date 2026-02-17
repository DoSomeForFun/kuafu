#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 6 ]]; then
  echo "Usage: $0 <week_id> <title> [project_ids_json_array] [note] [color] [completed:true|false]" >&2
  echo "Example: $0 2026-W07 \"Ship MVP\" '[\"project-id-1\"]' \"Weekly win\" \"yellow\" false" >&2
  exit 1
fi

WEEK_ID="$1"
TITLE="$2"
PROJECT_IDS_JSON="${3:-[]}"
NOTE="${4:-}"
COLOR="${5:-}"
COMPLETED="${6:-false}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_toastplan_http_common.sh
source "${SCRIPT_DIR}/_toastplan_http_common.sh"

ARGS_JSON="$(node -e '
const [weekId, title, projectIdsRaw, note, color, completedRaw] = process.argv.slice(1);
let projectIds = [];
try {
  projectIds = JSON.parse(projectIdsRaw);
  if (!Array.isArray(projectIds)) throw new Error("project_ids_json_array must be an array");
} catch (error) {
  console.error(error.message || "project_ids_json_array must be valid JSON array");
  process.exit(2);
}
const payload = {
  weekId,
  title,
  projectIds,
  completed: String(completedRaw).toLowerCase() === "true"
};
if (note) payload.note = note;
if (color) payload.color = color;
process.stdout.write(JSON.stringify(payload));
' "${WEEK_ID}" "${TITLE}" "${PROJECT_IDS_JSON}" "${NOTE}" "${COLOR}" "${COMPLETED}")"

tp_http_call_tool "create_outcome" "${ARGS_JSON}"
