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
 * Tool call interface
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Kernel run options
 */
export interface KernelRunOptions {
  taskId: string;
  prompt: string;
  sessionId: string;
  contextScope?: 'isolated' | 'linked' | 'conversation';
  agentName?: string;
  maxSteps?: number;
  maxHistory?: number;
  retrievedContext?: any[];
  promptEmbedding?: number[];
}

/**
 * Kernel run result
 */
export interface KernelRunResult {
  success: boolean;
  status: 'DONE' | 'FAILED';
  content: string;
  steps?: number;
  durationMs?: number;
  stopReason?: string;
  error?: string;
  meta?: {
    loop?: {
      stopReason?: string;
      durationMs?: number;
    };
    routing?: {
      executor: string;
      reason: string;
      affinityHit: boolean;
      recipeHit: boolean;
      sessionKey: string;
    };
  };
}

/**
 * Progress event interface
 */
export interface ProgressEvent {
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

/**
 * Progress sink interface
 */
export interface ProgressSink {
  emit(event: ProgressEvent): Promise<void> | void;
}
