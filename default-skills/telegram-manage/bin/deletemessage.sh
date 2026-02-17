#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 --bot-token <token> --chat-id <chat_id> --message-id <message_id>" >&2
}

BOT_TOKEN=""
CHAT_ID=""
MESSAGE_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bot-token) BOT_TOKEN="${2:-}"; shift 2 ;;
    --chat-id) CHAT_ID="${2:-}"; shift 2 ;;
    --message-id) MESSAGE_ID="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "$BOT_TOKEN" || -z "$CHAT_ID" || -z "$MESSAGE_ID" ]]; then
  usage
  exit 2
fi

curl -sS -X POST "https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage" \
  -H 'Content-Type: application/json' \
  -d "{\"chat_id\":\"${CHAT_ID}\",\"message_id\":${MESSAGE_ID}}"
