function normalizePart(value, fallback) {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

/**
 * Transport-agnostic session isolation key.
 * Semantic: channel + conversationId + senderId + threadId
 */
export function buildSessionScopeKey(input = {}) {
  const channel = normalizePart(input.channel, "unknown-channel");
  const conversationId = normalizePart(input.conversationId, "unknown-conversation");
  const senderId = normalizePart(input.senderId, "unknown-sender");
  const threadId = hasValue(input.threadId)
    ? normalizePart(input.threadId, "main")
    : "main";
  return `${channel}:conv:${conversationId}:sender:${senderId}:thread:${threadId}`;
}
