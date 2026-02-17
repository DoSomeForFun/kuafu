#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 --bot-token <token> --chat-id <chat_id> --reply-to-message-id <message_id> --text <text> [--parse-mode MarkdownV2|Markdown|HTML]" >&2
}

BOT_TOKEN=""
CHAT_ID=""
REPLY_TO_MESSAGE_ID=""
TEXT=""
PARSE_MODE="MarkdownV2"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bot-token) BOT_TOKEN="${2:-}"; shift 2 ;;
    --chat-id) CHAT_ID="${2:-}"; shift 2 ;;
    --reply-to-message-id) REPLY_TO_MESSAGE_ID="${2:-}"; shift 2 ;;
    --text) TEXT="${2:-}"; shift 2 ;;
    --parse-mode) PARSE_MODE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "$BOT_TOKEN" || -z "$CHAT_ID" || -z "$REPLY_TO_MESSAGE_ID" || -z "$TEXT" ]]; then
  usage
  exit 2
fi

curl -sS -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${CHAT_ID}" \
  --data-urlencode "text=${TEXT}" \
  --data-urlencode "parse_mode=${PARSE_MODE}" \
  --data-urlencode "reply_to_message_id=${REPLY_TO_MESSAGE_ID}" \
  --data-urlencode "allow_sending_without_reply=true" \
  --data-urlencode "disable_web_page_preview=true"
