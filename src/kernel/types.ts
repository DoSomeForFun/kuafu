import type { ToolCall, ToolResult, ToolSpec } from '../action.js';
import type {
  IAction,
  ContextBlock,
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
 * A single item retrieved from memory.
 */
export interface MemoryItem {
  id: string;
  content: string;
  /** Relevance score 0–1; higher = more relevant */
  score?: number;
  /** Where this memory came from, e.g. 'sqlite', 'memox', 'im-history', 'sop' */
  source?: string;
  /**
   * How the Kernel should use this item:
   * - 'chat_history': inject as multi-turn messages into the LLM (conversationHistory[])
   * - 'knowledge': inject as a context block in the system prompt (<retrieved_memory>)
   * Defaults to 'knowledge' if omitted.
   */
  purpose?: 'chat_history' | 'knowledge';
  metadata?: Record<string, unknown>;
}

/**
 * Protocol for pluggable memory backends.
 * kuafu-framework defines this interface; implementations live outside the framework
 * (bridge, memox adapter, vector store, etc.).
 *
 * [Context Anchor]
 * - Intent: Decouple long-term / semantic memory from the FSM core.
 * - Constraints: Must not hard-depend on any specific storage system (memox, sqlite, etc.).
 * - Invariants: retrieve() is always read-only and non-blocking from the FSM perspective.
 * - Failure Modes: If retrieve() throws, PERCEIVING logs a warning and continues with empty memory.
 */
export interface MemoryProvider {
  /**
   * Retrieve relevant memory items for the given query/prompt.
   */
  retrieve(query: string, options?: {
    limit?: number;
    sessionId?: string;
    taskId?: string;
    scope?: 'session' | 'global';
  }): Promise<MemoryItem[]>;

  /**
   * Optionally persist a memory item after a run completes.
   * Called with the final assistant response so implementations can update long-term memory.
   */
  store?(item: MemoryItem): Promise<void>;
}

/**
 * Kernel constructor dependencies
 */
export interface KernelDependencies {
  store?: IStore;
  /** @deprecated Use `store` instead. */
  backend?: IStore;
  action?: IAction;
  perception?: IPerception;
  decision?: IDecision;
  memory?: MemoryProvider;
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
  /** Memory items fetched during PERCEIVING via MemoryProvider.retrieve() */
  retrievedMemory: MemoryItem[];
  /**
   * Structured conversation history built from retrievedMemory (source='sqlite-history').
   * Injected as multi-turn messages into the LLM in THINKING state.
   */
  conversationHistory: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  sensoryData: IPerceptionOutput | null;
  contextBlock: string;
  contextBlocks: ContextBlock[] | null;
  turnResult: LLMCallResult | null;
  advice: IDecisionResult | null;
  finalResult: KernelFinalResult | null;
  /** Structured evidence from the last ACTING step's failed tool calls.
   *  Fed back into the next THINKING prompt so the LLM knows what failed and why. */
  lastToolEvidence: ToolEvidence[] | null;

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
    /**
     * Memory items that were retrieved and injected into the LLM context during PERCEIVING.
     * Enables context provenance tracing (Verifiable Tape pattern).
     */
    retrievedMemory?: MemoryItem[];
  };
}

/**
 * LLM call options
 */
export interface LLMCallOptions {
  prompt: string;
  systemPrompt?: string;
  history?: unknown[];
  /**
   * Structured multi-turn conversation history for LLMs that support it.
   * When provided, the LLM implementation should use this as the messages array
   * instead of building one from prompt alone.
   * Format: [{role: 'user'|'assistant'|'system', content: string}, ...]
   * The current user turn (prompt) is appended automatically by the LLM implementation.
   */
  conversationHistory?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  tools?: ToolSpec[];
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

/**
 * Structured evidence of a single failed tool call.
 * Carried through KernelContext.lastToolEvidence into the next THINKING step,
 * so the LLM knows what it tried, what failed, and why.
 */
export interface ToolEvidence {
  toolName: string;
  /** Note: arguments intentionally excluded to prevent sensitive data leakage into LLM prompts. */
  error: string;
  stdout?: string;
  stderr?: string;
}
