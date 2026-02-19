import { normalizeContextScope } from "./protocol/context-scope.js";
import { buildSessionScopeKey } from "./protocol/session-scope.js";
import { normalizeProgressEvent, normalizeProgressSink, validateProgressEvent } from "./progress-events.js";

type Maybe<T> = T | null | undefined;

export type AdapterIdentityInput = {
  channel?: string;
  conversationId?: string | number;
  chatId?: string | number;
  senderId?: string | number;
  threadId?: string | number;
  sessionId?: string;
};

export type AdapterContext = {
  channel: string;
  conversationId: string;
  senderId: string;
  threadId: string;
  sessionId: string;
  defaultTaskId: string;
};

export type HostRunInput = AdapterIdentityInput & {
  prompt: string;
  taskId?: string;
  contextScope?: string;
  agentName?: string;
  retrievedContext?: unknown[];
  maxSteps?: number;
  maxHistory?: number;
  progressSink?: { emit(event: unknown): void | Promise<void> } | ((event: unknown) => void | Promise<void>);
  taskIdResolver?: (context: AdapterContext, input: HostRunInput) => string;
};

function normalizePart(value: Maybe<unknown>, fallback: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function hasValue(value: Maybe<unknown>): boolean {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function toPositiveInt(value: Maybe<unknown>): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function toOptionalString(value: Maybe<unknown>): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeIdentityInput(input: AdapterIdentityInput = {}): Omit<AdapterContext, "sessionId" | "defaultTaskId"> {
  const channel = normalizePart(input.channel, "unknown-channel");
  const conversationId = normalizePart(input.conversationId ?? input.chatId, "unknown-conversation");
  const senderId = normalizePart(input.senderId, "unknown-sender");
  const threadId = hasValue(input.threadId)
    ? normalizePart(input.threadId, "main")
    : "main";
  return { channel, conversationId, senderId, threadId };
}

export function buildDefaultTaskId(input: AdapterIdentityInput = {}): string {
  const id = normalizeIdentityInput(input);
  return `${id.channel}-conv-${id.conversationId}-sender-${id.senderId}-thread-${id.threadId}`;
}

export function buildAdapterContext(input: AdapterIdentityInput = {}): AdapterContext {
  const identity = normalizeIdentityInput(input);
  const sessionId = toOptionalString(input.sessionId) || buildSessionScopeKey(identity);
  const defaultTaskId = buildDefaultTaskId(identity);
  return {
    ...identity,
    sessionId,
    defaultTaskId
  };
}

export function buildHostRunOptions(input: HostRunInput, options: { taskIdResolver?: HostRunInput["taskIdResolver"] } = {}) {
  const prompt = String(input.prompt ?? "").trim();
  if (!prompt) throw new Error("buildHostRunOptions requires non-empty prompt");

  const context = buildAdapterContext(input);
  const resolver = options.taskIdResolver || input.taskIdResolver;
  const resolvedTaskId = toOptionalString(input.taskId)
    || (typeof resolver === "function" ? toOptionalString(resolver(context, input)) : "")
    || context.defaultTaskId;

  const runOptions: Record<string, unknown> = {
    taskId: resolvedTaskId,
    prompt,
    sessionId: context.sessionId,
    contextScope: normalizeContextScope(input.contextScope),
    agentName: toOptionalString(input.agentName),
    retrievedContext: toArray(input.retrievedContext)
  };

  const maxSteps = toPositiveInt(input.maxSteps);
  const maxHistory = toPositiveInt(input.maxHistory);
  if (maxSteps) runOptions.maxSteps = maxSteps;
  if (maxHistory) runOptions.maxHistory = maxHistory;
  if (input.progressSink) runOptions.progressSink = input.progressSink;

  return runOptions;
}

export function createValidatedProgressSink(options: {
  progressSink?: HostRunInput["progressSink"];
  emit?: HostRunInput["progressSink"];
  strict?: boolean;
  onInvalidEvent?: (payload: { event: unknown; errors: string[] }) => void;
} = {}) {
  const downstream = normalizeProgressSink(options.progressSink || options.emit);
  const strict = options.strict !== false;
  const onInvalidEvent = typeof options.onInvalidEvent === "function"
    ? options.onInvalidEvent
    : () => {};

  return {
    emit(event: unknown) {
      const normalized = normalizeProgressEvent(event);
      const validation = validateProgressEvent(normalized, { strict });
      if (!validation.ok) {
        onInvalidEvent({ event: normalized, errors: validation.errors });
        return;
      }
      return downstream.emit(normalized);
    }
  };
}

export function createHostAdapterRuntime(options: {
  kernel: { run(input: unknown): Promise<unknown> };
  taskIdResolver?: HostRunInput["taskIdResolver"];
  progressSink?: HostRunInput["progressSink"];
  strictProgress?: boolean;
  onProgressInvalid?: (payload: { event: unknown; errors: string[] }) => void;
}) {
  const kernel = options.kernel;
  if (!kernel || typeof kernel.run !== "function") {
    throw new Error("createHostAdapterRuntime requires options.kernel.run");
  }

  const taskIdResolver = typeof options.taskIdResolver === "function" ? options.taskIdResolver : null;
  const strictProgress = options.strictProgress !== false;
  const sharedProgressSink = options.progressSink
    ? createValidatedProgressSink({
      progressSink: options.progressSink,
      strict: strictProgress,
      onInvalidEvent: options.onProgressInvalid
    })
    : null;

  return {
    buildContext(input: AdapterIdentityInput = {}) {
      return buildAdapterContext(input);
    },
    buildRunOptions(input: HostRunInput) {
      const runInput = buildHostRunOptions(input, { taskIdResolver: taskIdResolver || undefined });
      if (runInput.progressSink) {
        runInput.progressSink = createValidatedProgressSink({
          progressSink: runInput.progressSink as HostRunInput["progressSink"],
          strict: strictProgress,
          onInvalidEvent: options.onProgressInvalid
        });
      } else if (sharedProgressSink) {
        runInput.progressSink = sharedProgressSink;
      }
      return runInput;
    },
    async run(input: HostRunInput) {
      const runInput = this.buildRunOptions(input);
      return kernel.run(runInput);
    }
  };
}
