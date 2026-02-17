#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 5 ]]; then
  echo "Usage: $0 <title> <year> [description] [color] [priority]" >&2
  exit 1
fi

TITLE="$1"
YEAR="$2"
DESCRIPTION="${3:-}"
COLOR="${4:-}"
PRIORITY="${5:-0}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_toastplan_http_common.sh
source "${SCRIPT_DIR}/_toastplan_http_common.sh"

ARGS_JSON="$(node -e '
const [title, year, description, color, priority] = process.argv.slice(1);
const payload = { title, year: Number(year) };
if (description) payload.description = description;
if (color) payload.color = color;
if (priority !== "") payload.priority = Number(priority);
process.stdout.write(JSON.stringify(payload));
' "${TITLE}" "${YEAR}" "${DESCRIPTION}" "${COLOR}" "${PRIORITY}")"

tp_http_call_tool "create_goal" "${ARGS_JSON}"
