import Database from 'better-sqlite3';

/**
 * Telemetry interface
 */
interface Telemetry {
    info(message: string, data?: any): void;
    warn(message: string, data?: any): void;
    error(message: string, data?: any): void;
    debug(message: string, data?: any): void;
    startSpan(name: string): Span;
}
/**
 * Span interface for tracing
 */
interface Span {
    name: string;
    startTime: number;
    endTime?: number;
    attributes: Record<string, any>;
    end(attributes?: Record<string, any>): void;
}
/**
 * Default telemetry instance
 */
declare const telemetry: Telemetry;
/**
 * Run function with trace context
 */
declare function runWithTrace<T>(traceId: string, fn: () => Promise<T>): Promise<T>;

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
 * Unified Store (SQLite + Vector)
 */
declare class Store {
    db: Database.Database;
    constructor(dbPath?: string);
    private _initSchema;
    /**
     * Create a new task
     */
    createTask(task: {
        id: string;
        title: string;
        date: string;
        status?: TaskStatus;
        notes?: string;
    }): Promise<void>;
    /**
     * Get task by ID
     */
    getTaskById(taskId: string): Promise<Task | null>;
    /**
     * Update task status
     */
    updateTaskStatus(taskId: string, status: TaskStatus): Promise<void>;
    /**
     * Save task message
     */
    saveTaskMessage(message: {
        id: string;
        task_id: string;
        branch_id: string;
        sender_id: string;
        content: string;
        payload?: any;
        execution_id?: string;
    }): Promise<void>;
    /**
     * Get messages for task
     */
    getMessagesForTask(taskId: string, branchId?: string): Promise<Message[]>;
    /**
     * Save lesson learned
     */
    saveLesson(lesson: {
        id: string;
        task_id: string;
        branch_id: string;
        root_cause: string;
        what_not_to_do: string;
        suggested_alternatives?: string;
        trajectory?: string;
    }): Promise<void>;
    /**
     * Save LLM execution record
     */
    saveLLMExecution(execution: {
        id: string;
        task_id: string;
        agent_name?: string;
        prompt: string;
        thinking?: string;
        status: string;
        usage_prompt_tokens?: number;
        usage_completion_tokens?: number;
        latency_ms?: number;
    }): Promise<void>;
    /**
     * Close the database connection
     */
    close(): void;
}

declare const VERSION = "1.2.0-ts";
declare const kuafuFramework: {
    VERSION: string;
    Store: typeof Store;
    telemetry: Telemetry;
    runWithTrace: typeof runWithTrace;
};

export { type AgentTurn, type KernelRunOptions, type KernelRunResult, type LLMExecution, type Message, type ProgressEvent, type ProgressSink, Store, type Task, type TaskStatus, type ToolCall, VERSION, kuafuFramework as default, runWithTrace, telemetry };
