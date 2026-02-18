export const CONTEXT_SCOPES = {
  ISOLATED: "isolated",
  LINKED: "linked",
  CONVERSATION: "conversation"
} as const;

export type ContextScope = typeof CONTEXT_SCOPES[keyof typeof CONTEXT_SCOPES];

const CONTEXT_SCOPE_SET = new Set<string>(Object.values(CONTEXT_SCOPES));

export function normalizeContextScope(value: unknown, fallback: ContextScope = CONTEXT_SCOPES.ISOLATED): ContextScope {
  const raw = String(value || "").trim().toLowerCase();
  if (CONTEXT_SCOPE_SET.has(raw)) return raw as ContextScope;
  return fallback;
}

export function isConversationScope(scope: unknown): boolean {
  return normalizeContextScope(scope) === CONTEXT_SCOPES.CONVERSATION;
}
