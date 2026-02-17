#!/usr/bin/env bash
set -euo pipefail

TP_DEFAULT_PROJECT_ID="d8c64249-4a7a-41ae-9913-9843c4fcd90a"
TP_FALLBACK_BASE_URL="http://localhost:42857"

tp_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tp_repo_root="$(cd "${tp_script_dir}/../../../.." && pwd)"

tp_find_upwards() {
  local file_name="$1"
  local start_dir="$2"
  local current_dir="$start_dir"
  while true; do
    if [[ -f "${current_dir}/${file_name}" ]]; then
      echo "${current_dir}/${file_name}"
      return 0
    fi
    if [[ "${current_dir}" == "/" ]]; then
      return 1
    fi
    current_dir="$(dirname "${current_dir}")"
  done
}

tp_extract_json_string_field() {
  local file_path="$1"
  local key="$2"
  grep -Eo "\"${key}\"[[:space:]]*:[[:space:]]*\"[^\"]+\"" "${file_path}" \
    | head -n1 \
    | sed -E 's/.*"([^"]+)"/\1/'
}

tp_is_service_ready() {
  local base_url="$1"
  curl -sS "${base_url}/api/tools" >/dev/null 2>&1
}

tp_resolve_base_url() {
  if [[ -n "${TOASTPLAN_BASE_URL:-}" ]]; then
    echo "${TOASTPLAN_BASE_URL}"
    return 0
  fi

  local discovery_dir="${TOASTPLAN_DISCOVERY_DIR:-$PWD}"
  local candidate_file=""
  local value=""

  if candidate_file="$(tp_find_upwards "http-service-connection.json" "${discovery_dir}" 2>/dev/null)"; then
    value="$(tp_extract_json_string_field "${candidate_file}" "baseUrl" || true)"
    if [[ -n "${value}" ]] && tp_is_service_ready "${value}"; then
      echo "${value}"
      return 0
    fi
  fi

  if candidate_file="$(tp_find_upwards "mcp-connection.json" "${discovery_dir}" 2>/dev/null)"; then
    value="$(tp_extract_json_string_field "${candidate_file}" "url" || true)"
    if [[ -n "${value}" ]]; then
      value="${value%/sse}"
    fi
    if [[ -n "${value}" ]] && tp_is_service_ready "${value}"; then
      echo "${value}"
      return 0
    fi
  fi

  if [[ -f "${tp_repo_root}/http-service-connection.json" ]]; then
    value="$(tp_extract_json_string_field "${tp_repo_root}/http-service-connection.json" "baseUrl" || true)"
    if [[ -n "${value}" ]] && tp_is_service_ready "${value}"; then
      echo "${value}"
      return 0
    fi
  fi

  if [[ -f "${tp_repo_root}/mcp-connection.json" ]]; then
    value="$(tp_extract_json_string_field "${tp_repo_root}/mcp-connection.json" "url" || true)"
    if [[ -n "${value}" ]]; then
      value="${value%/sse}"
    fi
    if [[ -n "${value}" ]] && tp_is_service_ready "${value}"; then
      echo "${value}"
      return 0
    fi
  fi

  if tp_is_service_ready "${TP_FALLBACK_BASE_URL}"; then
    echo "${TP_FALLBACK_BASE_URL}"
    return 0
  fi

  echo "${TP_FALLBACK_BASE_URL}"
}

tp_http_call_tool() {
  local tool_name="$1"
  local args_json="${2:-{}}"
  local base_url
  base_url="$(tp_resolve_base_url)"
  local payload
  payload="$(printf '{"name":"%s","arguments":%s}' "${tool_name}" "${args_json}")"
  curl -sS -X POST "${base_url}/api/call" \
    -H "Content-Type: application/json" \
    -d "${payload}"
}

tp_now_ms() {
  echo "$(( $(date +%s) * 1000 ))"
}
