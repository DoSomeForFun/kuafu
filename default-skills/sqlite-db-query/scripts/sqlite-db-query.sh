#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
sqlite-db-query helper

Usage:
  sqlite-db-query.sh --mode <info|tables|schema|recent-messages|vector-recent|query> [options]

Options:
  --mode <mode>           Execution mode.
  --target <task|vector|test|path>
                          Which logical DB to use. Default: task.
  --db <path>             Explicit DB path (overrides --target).
  --sql <query>           SQL for --mode query.
  --limit <n>             LIMIT for built-in queries (default: 20).
  --load-vec <auto|true|false>
                          Whether to load vec0 extension (default: auto).
  --help                  Show this help.

Examples:
  sqlite-db-query.sh --mode info --target task
  sqlite-db-query.sh --mode recent-messages --limit 5
  sqlite-db-query.sh --mode vector-recent --limit 20
  sqlite-db-query.sh --mode query --target task --sql "SELECT id, sender_id, created_at FROM messages ORDER BY created_at DESC LIMIT 10;"
EOF
}

to_lower() {
  printf "%s" "$1" | tr '[:upper:]' '[:lower:]'
}

default_vector_db() {
  if [[ -n "${TELEGRAM_CONTEXT_VECTOR_DB_PATH:-}" ]]; then
    printf "%s" "$TELEGRAM_CONTEXT_VECTOR_DB_PATH"
    return
  fi
  if [[ -f "data/agent-context.sqlite" ]]; then
    printf "%s" "data/agent-context.sqlite"
    return
  fi
  printf "%s" "data/.agent-context.sqlite"
}

default_local_backend() {
  if [[ -n "${TELEGRAM_LOCAL_BACKEND_PATH:-}" ]]; then
    printf "%s" "$TELEGRAM_LOCAL_BACKEND_PATH"
    return
  fi
  if [[ -f "data/agent-core-local-backend.json" ]]; then
    printf "%s" "data/agent-core-local-backend.json"
    return
  fi
  printf "%s" "data/.agent-core-local-backend.json"
}

resolve_db_path() {
  local target="$1"
  case "$target" in
    task) printf "%s" "${TELEGRAM_TASKS_DB_PATH:-data/agent-tasks.sqlite}" ;;
    vector) default_vector_db ;;
    test) printf "%s" ".bdd-test.sqlite" ;;
    path)
      echo "target=path requires --db <path>" >&2
      exit 2
      ;;
    *)
      echo "unsupported target: $target" >&2
      exit 2
      ;;
  esac
}

is_positive_int() {
  [[ "$1" =~ ^[0-9]+$ ]] && [[ "$1" -gt 0 ]]
}

is_destructive_sql() {
  local lowered
  lowered="$(to_lower "$1")"
  [[ "$lowered" =~ (^|[^a-z])(insert|update|delete|replace|alter|drop|create|attach|detach|vacuum|reindex|truncate)([^a-z]|$) ]]
}

enforce_limit_if_needed() {
  local sql="$1"
  local limit="$2"
  local lowered
  lowered="$(to_lower "$sql")"
  if [[ "$lowered" =~ ^[[:space:]]*(select|with)[[:space:]] ]] && [[ ! "$lowered" =~ [[:space:]]limit[[:space:]][0-9]+ ]]; then
    sql="${sql%;}"
    sql="${sql} LIMIT ${limit};"
  fi
  printf "%s" "$sql"
}

MODE="info"
TARGET="task"
DB_PATH=""
SQL_QUERY=""
LIMIT="${SQLITE_QUERY_DEFAULT_LIMIT:-20}"
LOAD_VEC="auto"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      MODE="${2:-}"
      shift 2
      ;;
    --target)
      TARGET="${2:-}"
      shift 2
      ;;
    --db)
      DB_PATH="${2:-}"
      shift 2
      ;;
    --sql)
      SQL_QUERY="${2:-}"
      shift 2
      ;;
    --limit)
      LIMIT="${2:-}"
      shift 2
      ;;
    --load-vec)
      LOAD_VEC="$(to_lower "${2:-}")"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 is not available in PATH" >&2
  exit 127
fi

if ! is_positive_int "$LIMIT"; then
  echo "--limit must be a positive integer, got: $LIMIT" >&2
  exit 2
fi

if [[ -z "$DB_PATH" ]]; then
  if [[ "$MODE" == "vector-recent" ]]; then
    TARGET="vector"
  fi
  DB_PATH="$(resolve_db_path "$TARGET")"
fi

if [[ ! -f "$DB_PATH" ]]; then
  echo "database file not found: $DB_PATH" >&2
  echo "hint: set TELEGRAM_TASKS_DB_PATH / TELEGRAM_CONTEXT_VECTOR_DB_PATH, or pass --db <path>" >&2
  exit 3
fi

NEED_VEC="false"
if [[ "$LOAD_VEC" == "true" ]]; then
  NEED_VEC="true"
elif [[ "$LOAD_VEC" == "false" ]]; then
  NEED_VEC="false"
elif [[ "$LOAD_VEC" == "auto" ]]; then
  lowered_sql="$(to_lower "$SQL_QUERY")"
  if [[ "$TARGET" == "vector" ]] || [[ "$MODE" == "vector-recent" ]] || [[ "$lowered_sql" == *"context_vectors"* ]]; then
    NEED_VEC="true"
  fi
else
  echo "--load-vec must be one of: auto|true|false" >&2
  exit 2
fi

VEC_SO_PATH="${SQLITE_VEC_SO_PATH:-${SQLITE_EXTENSION_DIR:-/usr/lib/sqlite3}/vec0.so}"

run_query() {
  local sql="$1"
  if [[ "$NEED_VEC" == "true" ]]; then
    if [[ ! -f "$VEC_SO_PATH" ]]; then
      echo "vec extension not found: $VEC_SO_PATH" >&2
      echo "hint: set SQLITE_VEC_SO_PATH or SQLITE_EXTENSION_DIR" >&2
      exit 4
    fi
    sqlite3 -header -column "$DB_PATH" ".load $VEC_SO_PATH" "$sql"
    return
  fi
  sqlite3 -header -column "$DB_PATH" "$sql"
}

run_meta() {
  local cmd="$1"
  if [[ "$NEED_VEC" == "true" ]]; then
    if [[ ! -f "$VEC_SO_PATH" ]]; then
      echo "vec extension not found: $VEC_SO_PATH" >&2
      echo "hint: set SQLITE_VEC_SO_PATH or SQLITE_EXTENSION_DIR" >&2
      exit 4
    fi
    sqlite3 "$DB_PATH" ".load $VEC_SO_PATH" "$cmd"
    return
  fi
  sqlite3 "$DB_PATH" "$cmd"
}

echo "[sqlite-db-query] mode=$MODE target=$TARGET db=$DB_PATH" >&2

case "$MODE" in
  info)
    file "$DB_PATH" || true
    run_meta ".tables"
    ;;
  tables)
    run_meta ".tables"
    ;;
  schema)
    run_meta ".schema"
    ;;
  recent-messages)
    run_query "SELECT id, task_id, sender_id, created_at, substr(content, 1, 160) AS content_preview FROM messages ORDER BY created_at DESC LIMIT $LIMIT;"
    ;;
  vector-recent)
    run_query "SELECT cv.message_id, cv.task_id, cv.sender_id, COALESCE(m.created_at, 0) AS created_at, substr(cv.content, 1, 160) AS content_preview FROM context_vectors cv LEFT JOIN messages m ON m.id = cv.message_id ORDER BY created_at DESC LIMIT $LIMIT;"
    ;;
  query)
    if [[ -z "$SQL_QUERY" ]]; then
      echo "--mode query requires --sql" >&2
      exit 2
    fi
    if is_destructive_sql "$SQL_QUERY"; then
      echo "destructive SQL is blocked in this helper; run explicit sqlite3 manually if really needed." >&2
      exit 5
    fi
    SQL_QUERY="$(enforce_limit_if_needed "$SQL_QUERY" "$LIMIT")"
    run_query "$SQL_QUERY"
    ;;
  *)
    echo "unsupported mode: $MODE" >&2
    usage >&2
    exit 2
    ;;
esac

if [[ "$MODE" == "vector-recent" ]] && [[ -f "$(default_local_backend)" ]]; then
  echo "[sqlite-db-query] fallback json file available: $(default_local_backend)" >&2
fi
