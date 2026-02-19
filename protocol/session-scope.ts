function normalizePart(value: unknown, fallback: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

export type SessionScopeInput = {
  channel?: string;
  conversationId?: string;
  senderId?: string;
  threadId?: string;
};

/**
 * Transport-agnostic session isolation key.
 * Semantic: channel + conversationId + senderId + threadId
 */
export function buildSessionScopeKey(input: SessionScopeInput = {}): string {
  const channel = normalizePart(input.channel, "unknown-channel");
  const conversationId = normalizePart(input.conversationId, "unknown-conversation");
  const senderId = normalizePart(input.senderId, "unknown-sender");
  const threadId = hasValue(input.threadId)
    ? normalizePart(input.threadId, "main")
    : "main";
  return `${channel}:conv:${conversationId}:sender:${senderId}:thread:${threadId}`;
}
