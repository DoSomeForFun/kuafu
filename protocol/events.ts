export const EVENT_TYPES = {
  RUN_STARTED: "run_started",
  STEP_STARTED: "step_started",
  TOOL_STARTED: "tool_started",
  TOOL_HEARTBEAT: "tool_heartbeat",
  TOOL_FINISHED: "tool_finished",
  RUN_FINISHED: "run_finished",
  RUN_FAILED: "run_failed"
} as const;

export type ProgressEventType = typeof EVENT_TYPES[keyof typeof EVENT_TYPES];

export const PROGRESS_PROTOCOL_VERSION = "v1" as const;

export const PROGRESS_PROTOCOL_CAPABILITIES = [
  "event.run_started",
  "event.step_started",
  "event.tool_started",
  "event.tool_heartbeat",
  "event.tool_finished",
  "event.run_finished",
  "event.run_failed",
  "payload.tool_retry_info",
  "payload.tool_indexing"
] as const;

export type ProgressEventBase = {
  type: ProgressEventType;
  taskId: string;
  sessionId: string;
  ts: string;
  version: string;
  capabilities: string[];
};

export type RunStartedEvent = ProgressEventBase & {
  type: typeof EVENT_TYPES.RUN_STARTED;
  status: string;
  maxSteps?: number;
};

export type StepStartedEvent = ProgressEventBase & {
  type: typeof EVENT_TYPES.STEP_STARTED;
  step: number;
};

export type ToolStartedEvent = ProgressEventBase & {
  type: typeof EVENT_TYPES.TOOL_STARTED;
  step: number;
  toolName: string;
  toolIndex: number;
  toolTotal: number;
};

export type ToolHeartbeatEvent = ProgressEventBase & {
  type: typeof EVENT_TYPES.TOOL_HEARTBEAT;
  step: number;
  toolName: string;
  toolIndex: number;
  toolTotal: number;
  heartbeatCount: number;
  durationMs: number;
};

export type ToolFinishedEvent = ProgressEventBase & {
  type: typeof EVENT_TYPES.TOOL_FINISHED;
  step: number;
  toolName: string;
  toolIndex: number;
  toolTotal: number;
  ok: boolean;
  durationMs: number;
  retryInfo?: Record<string, unknown>;
  error?: string;
};

export type RunFinishedEvent = ProgressEventBase & {
  type: typeof EVENT_TYPES.RUN_FINISHED;
  status: string;
  steps: number;
  durationMs: number;
};

export type RunFailedEvent = ProgressEventBase & {
  type: typeof EVENT_TYPES.RUN_FAILED;
  status: string;
  error: string;
  steps: number;
  durationMs: number;
};

export type ProgressEvent =
  | RunStartedEvent
  | StepStartedEvent
  | ToolStartedEvent
  | ToolHeartbeatEvent
  | ToolFinishedEvent
  | RunFinishedEvent
  | RunFailedEvent;
