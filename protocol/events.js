const EVENT_TYPES = {
  RUN_STARTED: "run_started",
  STEP_STARTED: "step_started",
  TOOL_STARTED: "tool_started",
  TOOL_HEARTBEAT: "tool_heartbeat",
  TOOL_FINISHED: "tool_finished",
  RUN_FINISHED: "run_finished",
  RUN_FAILED: "run_failed"
};

const PROGRESS_PROTOCOL_VERSION = "v1";
const PROGRESS_PROTOCOL_CAPABILITIES = Object.freeze([
  "event.run_started",
  "event.step_started",
  "event.tool_started",
  "event.tool_heartbeat",
  "event.tool_finished",
  "event.run_finished",
  "event.run_failed",
  "payload.tool_retry_info",
  "payload.tool_indexing"
]);

const EVENT_TYPE_VALUES = new Set(Object.values(EVENT_TYPES));

const PROGRESS_EVENT_SCHEMA = {
  version: PROGRESS_PROTOCOL_VERSION,
  common: {
    required: ["type", "taskId", "sessionId", "ts", "version", "capabilities"],
    properties: {
      type: "string",
      taskId: "string",
      sessionId: "string",
      ts: "string",
      version: "string",
      capabilities: "array_string"
    }
  },
  byType: {
    [EVENT_TYPES.RUN_STARTED]: {
      required: ["status"],
      properties: { status: "string", maxSteps: "number" }
    },
    [EVENT_TYPES.STEP_STARTED]: {
      required: ["step"],
      properties: { step: "number" }
    },
    [EVENT_TYPES.TOOL_STARTED]: {
      required: ["step", "toolName", "toolIndex", "toolTotal"],
      properties: { step: "number", toolName: "string", toolIndex: "number", toolTotal: "number" }
    },
    [EVENT_TYPES.TOOL_HEARTBEAT]: {
      required: ["step", "toolName", "toolIndex", "toolTotal", "heartbeatCount", "durationMs"],
      properties: {
        step: "number",
        toolName: "string",
        toolIndex: "number",
        toolTotal: "number",
        heartbeatCount: "number",
        durationMs: "number"
      }
    },
    [EVENT_TYPES.TOOL_FINISHED]: {
      required: ["step", "toolName", "toolIndex", "toolTotal", "ok", "durationMs"],
      properties: {
        step: "number",
        toolName: "string",
        toolIndex: "number",
        toolTotal: "number",
        ok: "boolean",
        durationMs: "number",
        error: "string",
        retryInfo: "object"
      }
    },
    [EVENT_TYPES.RUN_FINISHED]: {
      required: ["status", "steps", "durationMs"],
      properties: { status: "string", steps: "number", durationMs: "number" }
    },
    [EVENT_TYPES.RUN_FAILED]: {
      required: ["status", "error", "steps", "durationMs"],
      properties: { status: "string", error: "string", steps: "number", durationMs: "number" }
    }
  }
};

function toJsonTypeSchema(expectedType) {
  if (expectedType === "number") return { type: "number" };
  if (expectedType === "boolean") return { type: "boolean" };
  if (expectedType === "string") return { type: "string" };
  if (expectedType === "object") return { type: "object" };
  if (expectedType === "array_string") return { type: "array", items: { type: "string" } };
  return {};
}

function buildTypeJsonSchema(eventType, typeSchema) {
  const properties = {
    type: { type: "string", const: eventType },
    taskId: { type: "string" },
    sessionId: { type: "string" },
    ts: { type: "string", format: "date-time" },
    version: { type: "string" },
    capabilities: { type: "array", items: { type: "string" } }
  };

  for (const [field, expectedType] of Object.entries(typeSchema.properties || {})) {
    properties[field] = toJsonTypeSchema(expectedType);
  }

  return {
    type: "object",
    additionalProperties: true,
    required: [...PROGRESS_EVENT_SCHEMA.common.required, ...(typeSchema.required || [])],
    properties
  };
}

const PROGRESS_EVENT_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://kuafu.dev/schemas/progress-event-v1.json",
  title: "Kuafu ProgressEvent v1",
  description: "Transport-agnostic runtime progress event protocol.",
  oneOf: Object.entries(PROGRESS_EVENT_SCHEMA.byType).map(([eventType, typeSchema]) => (
    buildTypeJsonSchema(eventType, typeSchema)
  ))
};

function toSafeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toType(value, expectedType) {
  if (expectedType === "number") return toSafeNumber(value, 0);
  if (expectedType === "boolean") return Boolean(value);
  if (expectedType === "string") return String(value ?? "");
  if (expectedType === "array_string") {
    if (Array.isArray(value)) return value.map((item) => String(item ?? ""));
    if (typeof value === "string" && value.trim()) {
      return value.split(",").map((item) => item.trim()).filter(Boolean);
    }
    return [];
  }
  if (expectedType === "object") {
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    return {};
  }
  return value;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasRequiredValue(value, expectedType) {
  if (expectedType === "string") return nonEmptyString(value);
  if (expectedType === "number") return typeof value === "number" && Number.isFinite(value);
  if (expectedType === "boolean") return typeof value === "boolean";
  if (expectedType === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (expectedType === "array_string") return Array.isArray(value) && value.every((item) => typeof item === "string");
  return value !== undefined && value !== null;
}

export function normalizeProgressEvent(event) {
  const source = event && typeof event === "object" ? event : {};
  const type = String(source.type || "");
  const schema = PROGRESS_EVENT_SCHEMA.byType[type] || { required: [], properties: {} };

  const normalized = {
    ...source,
    type,
    taskId: String(source.taskId ?? ""),
    sessionId: String(source.sessionId ?? ""),
    ts: nonEmptyString(source.ts) ? source.ts : new Date().toISOString(),
    version: nonEmptyString(source.version) ? source.version : PROGRESS_PROTOCOL_VERSION,
    capabilities: Array.isArray(source.capabilities) && source.capabilities.length > 0
      ? source.capabilities.map((item) => String(item ?? ""))
      : [...PROGRESS_PROTOCOL_CAPABILITIES]
  };

  for (const [field, expectedType] of Object.entries(schema.properties || {})) {
    if (source[field] === undefined || source[field] === null) {
      if (expectedType === "number") normalized[field] = 0;
      else if (expectedType === "boolean") normalized[field] = false;
      else if (expectedType === "string") normalized[field] = "";
      else if (expectedType === "object") normalized[field] = {};
      continue;
    }
    normalized[field] = toType(source[field], expectedType);
  }

  if (type === EVENT_TYPES.RUN_STARTED && !nonEmptyString(normalized.status)) normalized.status = "RUNNING";
  if (type === EVENT_TYPES.RUN_FINISHED && !nonEmptyString(normalized.status)) normalized.status = "DONE";
  if (type === EVENT_TYPES.RUN_FAILED && !nonEmptyString(normalized.status)) normalized.status = "FAILED";

  return normalized;
}

export function validateProgressEvent(event, options = {}) {
  const strict = options.strict !== false;
  const errors = [];

  if (!event || typeof event !== "object") {
    return { ok: false, errors: ["event must be an object"] };
  }

  const type = String(event.type || "");
  if (!EVENT_TYPE_VALUES.has(type)) {
    errors.push(`unknown event type: ${type || "<empty>"}`);
    return { ok: false, errors };
  }

  for (const key of PROGRESS_EVENT_SCHEMA.common.required) {
    const value = event[key];
    const expectedType = PROGRESS_EVENT_SCHEMA.common.properties[key];
    if (!hasRequiredValue(value, expectedType)) errors.push(`missing or invalid common field: ${key}`);
  }

  const typeSchema = PROGRESS_EVENT_SCHEMA.byType[type] || { required: [], properties: {} };
  for (const key of typeSchema.required || []) {
    const value = event[key];
    const expectedType = typeSchema.properties?.[key];
    if (!hasRequiredValue(value, expectedType)) {
      errors.push(`missing field for ${type}: ${key}`);
    }
  }

  if (strict) {
    for (const [key, expectedType] of Object.entries(typeSchema.properties || {})) {
      const value = event[key];
      if (value === undefined || value === null) continue;
      if (expectedType === "number" && typeof value !== "number") errors.push(`field ${key} should be number`);
      if (expectedType === "string" && typeof value !== "string") errors.push(`field ${key} should be string`);
      if (expectedType === "boolean" && typeof value !== "boolean") errors.push(`field ${key} should be boolean`);
      if (expectedType === "array_string" && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) {
        errors.push(`field ${key} should be string[]`);
      }
      if (expectedType === "object" && (typeof value !== "object" || Array.isArray(value))) errors.push(`field ${key} should be object`);
    }
  }

  return { ok: errors.length === 0, errors };
}

const PROGRESS_PROTOCOL = Object.freeze({
  version: PROGRESS_PROTOCOL_VERSION,
  capabilities: [...PROGRESS_PROTOCOL_CAPABILITIES]
});

export {
  EVENT_TYPES,
  PROGRESS_PROTOCOL,
  PROGRESS_PROTOCOL_VERSION,
  PROGRESS_PROTOCOL_CAPABILITIES,
  PROGRESS_EVENT_SCHEMA,
  PROGRESS_EVENT_JSON_SCHEMA
};
