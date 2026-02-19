import { normalizeContextScope } from "./protocol/context-scope.js";
import { buildSessionScopeKey } from "./protocol/session-scope.js";
import { normalizeProgressEvent, normalizeProgressSink, validateProgressEvent } from "./progress-events.js";

function normalizePart(value, fallback) {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function toOptionalString(value) {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeIdentityInput(input = {}) {
  const channel = normalizePart(input.channel, "unknown-channel");
  const conversationId = normalizePart(input.conversationId ?? input.chatId, "unknown-conversation");
  const senderId = normalizePart(input.senderId, "unknown-sender");
  const threadId = hasValue(input.threadId)
    ? normalizePart(input.threadId, "main")
    : "main";
  return { channel, conversationId, senderId, threadId };
}

/**
 * Deterministic default task id for host adapters.
 */
export function buildDefaultTaskId(input = {}) {
  const id = normalizeIdentityInput(input);
  return `${id.channel}-conv-${id.conversationId}-sender-${id.senderId}-thread-${id.threadId}`;
}

/**
 * Build canonical adapter context from host-native fields.
 */
export function buildAdapterContext(input = {}) {
  const identity = normalizeIdentityInput(input);
  const sessionId = toOptionalString(input.sessionId) || buildSessionScopeKey(identity);
  const defaultTaskId = buildDefaultTaskId(identity);
  return {
    ...identity,
    sessionId,
    defaultTaskId
  };
}

/**
 * Build kernel.run input from transport-agnostic host input.
 */
export function buildHostRunOptions(input = {}, options = {}) {
  const prompt = String(input.prompt ?? "").trim();
  if (!prompt) throw new Error("buildHostRunOptions requires non-empty prompt");

  const context = buildAdapterContext(input);
  const resolver = options.taskIdResolver || input.taskIdResolver;
  const resolvedTaskId = toOptionalString(input.taskId)
    || (typeof resolver === "function" ? toOptionalString(resolver(context, input)) : "")
    || context.defaultTaskId;

  const runOptions = {
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

/**
 * Wrap and enforce protocol-safe progress events before emitting to host sink.
 */
export function createValidatedProgressSink(options = {}) {
  const downstream = normalizeProgressSink(options.progressSink || options.emit);
  const strict = options.strict !== false;
  const onInvalidEvent = typeof options.onInvalidEvent === "function"
    ? options.onInvalidEvent
    : () => {};

  return {
    emit(event) {
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

/**
 * Create a reusable host adapter runtime wrapper over kernel.run.
 */
export function createHostAdapterRuntime(options = {}) {
  const kernel = options.kernel;
  if (!kernel || typeof kernel.run !== "function") {
    throw new Error("createHostAdapterRuntime requires options.kernel.run");
  }

  const taskIdResolver = typeof options.taskIdResolver === "function"
    ? options.taskIdResolver
    : null;
  const strictProgress = options.strictProgress !== false;
  const sharedProgressSink = options.progressSink
    ? createValidatedProgressSink({
      progressSink: options.progressSink,
      strict: strictProgress,
      onInvalidEvent: options.onProgressInvalid
    })
    : null;

  return {
    buildContext(input = {}) {
      return buildAdapterContext(input);
    },
    buildRunOptions(input = {}) {
      const runInput = buildHostRunOptions(input, { taskIdResolver });
      if (runInput.progressSink) {
        runInput.progressSink = createValidatedProgressSink({
          progressSink: runInput.progressSink,
          strict: strictProgress,
          onInvalidEvent: options.onProgressInvalid
        });
      } else if (sharedProgressSink) {
        runInput.progressSink = sharedProgressSink;
      }
      return runInput;
    },
    async run(input = {}) {
      const runInput = this.buildRunOptions(input);
      return kernel.run(runInput);
    }
  };
}
