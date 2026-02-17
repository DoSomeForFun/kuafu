#!/bin/bash
set -e

# Default values
PARSE_MODE="MarkdownV2"
REPLY_TO=""
STICKER_ID=""
TEXT=""
REACTION=""
CHAT_ID="${TELEGRAM_CHAT_ID:-}"
BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"

# Parse arguments
while [[ $# -gt 0 ]]; do
  key="$1"
  case $key in
    --bot-token)
      BOT_TOKEN="$2"
      shift;shift;;
    --chat-id)
      CHAT_ID="$2"
      shift;shift;;
    --text)
      TEXT="$2"
      shift;shift;;
    --sticker)
      STICKER_ID="$2"
      shift;shift;;
    --reaction)
      REACTION="$2"
      shift;shift;;
    --reply-to)
      REPLY_TO="$2"
      shift;shift;;
    --parse-mode)
      PARSE_MODE="$2"
      shift;shift;;
    *)
      shift;;
  esac
done

if [[ -z "$BOT_TOKEN" || -z "$CHAT_ID" ]]; then
  echo "Error: Missing BOT_TOKEN or CHAT_ID"
  exit 1
fi

if [[ -z "$TEXT" && -z "$STICKER_ID" && -z "$REACTION" ]]; then
  echo "Error: Must provide at least --text, --sticker or --reaction"
  exit 1
fi

# Function to set reaction
send_reaction() {
  local emoji="$1"
  local message_id="$2"
  
  # Default to last message if reply_to is not set? No, reaction needs target.
  if [[ -z "$message_id" ]]; then
    echo "Warning: Reaction requires --reply-to message_id. Skipping reaction."
    return
  fi

  REACTION_JSON="[{\"type\": \"emoji\", \"emoji\": \"$emoji\"}]"
  
  curl -s -X POST "https://api.telegram.org/bot$BOT_TOKEN/setMessageReaction" \
    -H "Content-Type: application/json" \
    -d "{\"chat_id\": \"$CHAT_ID\", \"message_id\": $message_id, \"reaction\": $REACTION_JSON}" > /dev/null
}

# Function to send sticker
send_sticker() {
  local sticker="$1"
  local reply="$2"
  
  DATA="chat_id=$CHAT_ID&sticker=$sticker"
  if [[ -n "$reply" ]]; then
    DATA+="&reply_to_message_id=$reply"
  fi
  
  curl -s -X POST "https://api.telegram.org/bot$BOT_TOKEN/sendSticker" \
    -d "$DATA" > /dev/null
}

# Function to send text
send_text() {
  local text="$1"
  local reply="$2"
  local mode="$3"
  
  DATA="chat_id=$CHAT_ID&text=$(echo -n "$text" | jq -s -R -r @uri)"
  if [[ -n "$reply" ]]; then
    DATA+="&reply_to_message_id=$reply"
  fi
  if [[ -n "$mode" ]]; then
    DATA+="&parse_mode=$(echo -n "$mode" | jq -s -R -r @uri)"
  fi
  
  curl -s -X POST "https://api.telegram.org/bot$BOT_TOKEN/sendMessage" \
    -d "$DATA" > /dev/null
}

# Execution Logic: Reaction -> Sticker -> Text (Multi-Bubble)

if [[ -n "$REACTION" ]]; then
  send_reaction "$REACTION" "$REPLY_TO"
  # Small delay
  if [[ -n "$STICKER_ID" || -n "$TEXT" ]]; then
    sleep 0.3
  fi
fi

if [[ -n "$STICKER_ID" ]]; then
  send_sticker "$STICKER_ID" "$REPLY_TO"
  # Small delay for natural feel if text follows
  if [[ -n "$TEXT" ]]; then
    sleep 0.5
  fi
fi

if [[ -n "$TEXT" ]]; then
  send_text "$TEXT" "$REPLY_TO" "$PARSE_MODE"
fi

echo "Message sent successfully."
