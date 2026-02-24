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
  progressSink?: any;
  onStep?: (context: any) => void;
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
  onStep?: (context: any) => void;
  progressSink: any;
  progressHeartbeatMs: number;
  
  // Components
  decision?: any;
  perception?: any;
  
  // Runtime State
  state: KernelState;
  stepCount: number;
  turnHint: string | null;
  isWorkspaceReady: boolean;
  forceSimpleChat?: boolean;
  promptEmbedding?: number[];
  
  // Data
  task: any;
  currentBranchId: string;
  retrievedContext: any[];
  sensoryData: any | null;
  contextBlock: string;
  turnResult: any | null;
  advice: any | null;
  finalResult: any | null;
  
  // Flags
  isReroute: boolean;
  
  // Metrics
  journal?: any;
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
  history?: any[];
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
  toolCalls?: any[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
  latencyMs: number;
}

/**
 * Tool execution result
 */
export interface ToolExecutionResult {
  ok: boolean;
  results: any[];
  error?: string;
  durationMs: number;
}
