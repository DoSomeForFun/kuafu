export type ContextScope =
  | 'local'
  | 'conversation'
  | 'global';

export type RuntimeEventType =
  | 'user_message'
  | 'assistant_message'
  | 'channel_delivery'
  | 'tool_call'
  | 'tool_result'
  | 'system_notice';

export interface RuntimeEvent {
  type: RuntimeEventType;
  scope: ContextScope;
  actorId: string;
  content?: string;
  taskId?: string;
  sessionId?: string;
  messageId?: string;
  parentMessageId?: string;
  createdAt?: number;
  meta?: Record<string, unknown>;
}

export type RuntimeHookDecision =
  | { action: 'allow' }
  | { action: 'capture'; reason?: string }
  | { action: 'silence'; reason?: string }
  | { action: 'rewrite'; prompt?: string; content?: string; reason?: string };

export interface BeforeRunHookInput {
  event: RuntimeEvent;
  prompt: string;
  taskId: string;
  sessionId: string;
  scope: ContextScope;
  meta?: Record<string, unknown>;
}

export interface AfterRunHookInput {
  event: RuntimeEvent;
  prompt: string;
  content: string;
  success: boolean;
  taskId: string;
  sessionId: string;
  scope: ContextScope;
  meta?: Record<string, unknown>;
}

export type BeforeRunHook = (input: BeforeRunHookInput) => Promise<RuntimeHookDecision> | RuntimeHookDecision;
export type AfterRunHook = (input: AfterRunHookInput) => Promise<RuntimeHookDecision> | RuntimeHookDecision;
