import type { ToolCall as ActionToolCall, ToolResult, ToolSpec } from './action.js';

/**
 * Task interface
 */
export interface Task {
  id: string;
  title: string;
  date: string;
  status: TaskStatus;
  notes?: string;
  current_branch_id?: string;
  updated_at?: number;
}

export type TaskStatus = 'todo' | 'doing' | 'done' | 'archived';

/**
 * Message interface
 */
export interface Message {
  id: string;
  task_id: string;
  branch_id: string;
  execution_id?: string;
  sender_id: string;
  content: string;
  payload?: string;
  is_archived?: number;
  created_at: number;
}

/**
 * Agent turn interface
 */
export interface AgentTurn {
  id: string;
  task_id: string;
  branch_id: string;
  execution_id?: string;
  sender_id: string;
  content: string;
  tool_calls?: string;
  created_at: number;
}

/**
 * LLM execution result
 */
export interface LLMExecution {
  id: string;
  task_id: string;
  agent_name?: string;
  prompt: string;
  thinking?: string;
  status: string;
  usage_prompt_tokens?: number;
  usage_completion_tokens?: number;
  latency_ms?: number;
  created_at: number;
}

/**
 * Public tool call type aligned with Action layer.
 */
export type ToolCall = ActionToolCall;

/**
 * Store/Action contracts
 */
export type StoreTaskLike = Task;
export type StoreMessageLike = Message;

export interface SaveTaskMessageInput {
  id: string;
  task_id: string;
  branch_id: string;
  sender_id: string;
  content: string;
  payload?: unknown;
  execution_id?: string;
}

export interface IStore {
  getTaskById(taskId: string): Promise<Task | null>;
  pivotBranch(taskId: string): Promise<string>;
  getActiveMessages(taskId: string, branchId: string): Promise<Message[]>;
  saveTaskMessage(message: SaveTaskMessageInput): Promise<void>;
}

export interface IAction {
  invokeTool(toolCall: ActionToolCall): Promise<ToolResult>;
  getSpecs?(): ToolSpec[];
}

/**
 * Progress event and sink contracts
 */
export interface ProgressEventLike {
  type: string;
  taskId: string;
  sessionId: string;
  step?: number;
  toolName?: string;
  toolIndex?: number;
  toolTotal?: number;
  heartbeatCount?: number;
  durationMs?: number;
  ok?: boolean;
  error?: string;
  status?: string;
  steps?: number;
}

export interface ProgressEvent extends ProgressEventLike {}

export interface IProgressSink {
  emit(event: ProgressEvent): Promise<void> | void;
}

export interface ProgressSink extends IProgressSink {}

/**
 * Perception/Decision contracts used by Kernel context
 */
export interface IPerceptionInput {
  prompt: string;
  task: Task;
  retrievedContext: unknown[];
  sessionId: string;
  taskId: string;
  isSimpleChat?: boolean;
}

export interface IPerceptionState {
  contextBlock?: string;
  [key: string]: unknown;
}

export type ContextBlockType =
  | 'task_goal'
  | 'skill'
  | 'memory'
  | 'prior_result'
  | 'failure'
  | 'system'
  | 'retrieved'
  | 'custom';

export interface ContextBlock {
  type: ContextBlockType;
  content: string;
  source?: string;
  weight?: number;
  label?: string;
}

export interface IPerceptionOutput {
  skills: unknown[];
  state: IPerceptionState;
  workspace: unknown;
  lessons: unknown[];
  retrievedContext: unknown[];
  blocks?: ContextBlock[];
  /**
   * Structured conversation history for multi-turn LLM calls.
   * Populated by MemoryProvider-aware bridge/perception implementations.
   * Format: [{role: 'user'|'assistant'|'system', content: string}, ...]
   * Does NOT include the current user turn (prompt); that's appended by the LLM implementation.
   */
  conversationHistory?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
}

export interface IPerception {
  gather(input: IPerceptionInput): Promise<IPerceptionOutput>;
}

export interface IDecisionTurn {
  sender_id: string;
  content: string;
  tool_calls?: ActionToolCall[];
  [key: string]: unknown;
}

export interface IDecisionResult {
  shouldContinue: boolean;
  stopReason?: string;
  intercept?: boolean;
  interceptMessage?: string;
}

export interface IDecision {
  shouldContinue(history: IDecisionTurn[], currentStep: number, lastToolCalls?: ActionToolCall[]): IDecisionResult;
}

/**
 * Outcome sink — framework-level contract for "task done → notify outside".
 * Implementations registered at runtime (bridge, IM adapters, memox, etc.)
 * Kernel calls this once after every run(), success or failure.
 */
export interface OutcomeSink {
  onOutcome(payload: OutcomePayload): void | Promise<void>;
}

/**
 * Outcome payload — emitted by Kernel when a task completes or fails.
 * Consumed by any OutcomeSink implementation (bridge, adapters, etc.)
 */
export interface OutcomePayload {
  taskId: string;
  sessionId: string;
  status: 'completed' | 'failed';
  content: string;
  trigger: 'user' | 'autonomous' | 'unknown';
  durationMs?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

// Re-export kernel types for convenience
export type { LLMCallOptions, LLMCallResult, LLMFunction, ToolEvidence, KernelRunOptions, KernelRunResult, MemoryItem, MemoryProvider } from './kernel/types.js';
