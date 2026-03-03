import type { ToolCall, ToolResult } from '../action.js';
import type {
  IAction,
  IDecision,
  IDecisionResult,
  IPerception,
  IPerceptionOutput,
  IProgressSink,
  IStore,
  OutcomeSink,
  Task
} from '../types.js';

/**
 * Kernel FSM states
 */
export type KernelState =
  | 'PERCEIVING'
  | 'THINKING'
  | 'DECIDING'
  | 'ACTING'
  | 'REFLECTING'
  | 'DONE'
  | 'FAILED';

/**
 * Kernel constructor dependencies
 */
export interface KernelDependencies {
  store?: IStore;
  backend?: IStore;
  action?: IAction;
  perception?: IPerception;
  decision?: IDecision;
  workdir?: string;
  progressSink?: IProgressSink;
  outcomeSink?: OutcomeSink;
  /** Inject a real LLM backend. Called for every THINKING step. */
  llm?: LLMFunction;
  [key: string]: unknown;
}

/** LLM function signature for constructor injection */
export type LLMFunction = (options: LLMCallOptions) => Promise<LLMCallResult>;

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
  retrievedContext?: unknown[];
  promptEmbedding?: number[];
  progressSink?: IProgressSink;
  outcomeSink?: OutcomeSink;
  isSimpleChat?: boolean;
  onStep?: (context: KernelContext) => void;
  /** Hint for OutcomeSink: who triggered this run */
  trigger?: 'user' | 'autonomous' | 'unknown';
  /** Extra metadata passed through to OutcomeSink.onOutcome() */
  outcomeMeta?: Record<string, unknown>;
}

export interface KernelFinalResult {
  content?: string;
  stopReason?: string;
  error?: string;
}

/**
 * Kernel context for FSM loop
 */
export interface KernelContext {
  // Config
  taskId: string;
  sessionId: string;
  originalPrompt: string;
  maxSteps: number;
  maxHistory: number;
  agentName?: string;
  onStep?: (context: KernelContext) => void;
  progressSink: IProgressSink | null;
  progressHeartbeatMs: number;

  // Components
  decision: IDecision;
  perception: IPerception;

  // Runtime State
  state: KernelState;
  stepCount: number;
  turnHint: string | null;
  isWorkspaceReady: boolean;
  forceSimpleChat?: boolean;
  promptEmbedding?: number[];

  // Data
  task: Task;
  currentBranchId: string;
  retrievedContext: unknown[];
  sensoryData: IPerceptionOutput | null;
  contextBlock: string;
  turnResult: LLMCallResult | null;
  advice: IDecisionResult | null;
  finalResult: KernelFinalResult | null;

  // Flags
  isReroute: boolean;

  // Metrics
  journal?: Record<string, unknown>;
  toolsUsed: string[];
  toolFailures: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  runStartTime: number;
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
 * LLM call options
 */
export interface LLMCallOptions {
  prompt: string;
  systemPrompt?: string;
  history?: unknown[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

/**
 * LLM call result
 */
export interface LLMCallResult {
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
  latencyMs?: number;
}

/**
 * Tool execution result
 */
export interface ToolExecutionResult {
  ok: boolean;
  results: ToolResult[];
  error?: string;
  durationMs: number;
}
