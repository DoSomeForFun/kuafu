#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <outcome_id> <updates_json>" >&2
  echo "Example: $0 outcome-123 '{\"note\":\"Updated\",\"completed\":true}'" >&2
  exit 1
fi

OUTCOME_ID="$1"
UPDATES_JSON="$2"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_toastplan_http_common.sh
source "${SCRIPT_DIR}/_toastplan_http_common.sh"

ARGS_JSON="$(node -e '
const [id, updatesRaw] = process.argv.slice(1);
let updates = {};
try {
  updates = JSON.parse(updatesRaw);
} catch {
  console.error("updates_json must be valid JSON");
  process.exit(2);
}
process.stdout.write(JSON.stringify({ id, updates }));
' "${OUTCOME_ID}" "${UPDATES_JSON}")"

tp_http_call_tool "update_outcome" "${ARGS_JSON}"
