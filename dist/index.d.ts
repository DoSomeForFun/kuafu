/**
 * Task interface
 */
interface Task {
    id: string;
    title: string;
    date: string;
    status: TaskStatus;
    notes?: string;
    current_branch_id?: string;
    updated_at?: number;
}
type TaskStatus = 'todo' | 'doing' | 'done' | 'archived';
/**
 * Message interface
 */
interface Message {
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
interface AgentTurn {
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
interface LLMExecution {
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
interface ToolCall {
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
interface KernelRunOptions {
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
interface KernelRunResult {
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
interface ProgressEvent {
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
interface ProgressSink {
    emit(event: ProgressEvent): Promise<void> | void;
}

/**
 * @kuafu/framework - Channel-agnostic Agent Runtime Framework
 *
 * This is a simplified TypeScript migration stub.
 * Full implementation will be migrated from kuafu/ directory.
 */

declare const VERSION = "1.2.0-ts";
declare function placeholder(): string;
declare const _default: {
    VERSION: string;
    placeholder: typeof placeholder;
};

export { type AgentTurn, type KernelRunOptions, type KernelRunResult, type LLMExecution, type Message, type ProgressEvent, type ProgressSink, type Task, type TaskStatus, type ToolCall, VERSION, _default as default, placeholder };
