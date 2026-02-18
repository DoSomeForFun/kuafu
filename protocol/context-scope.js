export const CONTEXT_SCOPES = Object.freeze({
  ISOLATED: "isolated",
  LINKED: "linked",
  CONVERSATION: "conversation"
});

const CONTEXT_SCOPE_SET = new Set(Object.values(CONTEXT_SCOPES));

export function normalizeContextScope(value, fallback = CONTEXT_SCOPES.ISOLATED) {
  const raw = String(value || "").trim().toLowerCase();
  if (CONTEXT_SCOPE_SET.has(raw)) return raw;
  return fallback;
}

export function isConversationScope(scope) {
  return normalizeContextScope(scope) === CONTEXT_SCOPES.CONVERSATION;
}
