import {
  EVENT_TYPES,
  PROGRESS_PROTOCOL,
  PROGRESS_PROTOCOL_VERSION,
  PROGRESS_PROTOCOL_CAPABILITIES,
  PROGRESS_EVENT_SCHEMA,
  PROGRESS_EVENT_JSON_SCHEMA,
  normalizeProgressEvent,
  validateProgressEvent
} from "./protocol/events.js";

function toSafeInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function getProgressHeartbeatMs() {
  return Math.max(1000, toSafeInt(process.env.AGENT_PROGRESS_HEARTBEAT_MS, 12000));
}

export function createProgressEvent(base, type, payload = {}) {
  return normalizeProgressEvent({
    type,
    taskId: base.taskId,
    sessionId: base.sessionId,
    ts: new Date().toISOString(),
    ...payload
  });
}

export function normalizeProgressSink(progressSink) {
  if (!progressSink) return { emit: () => { } };
  if (typeof progressSink === "function") {
    return {
      emit: (event) => progressSink(event)
    };
  }
  if (typeof progressSink.emit === "function") return progressSink;
  return { emit: () => { } };
}

export {
  EVENT_TYPES,
  PROGRESS_PROTOCOL,
  PROGRESS_PROTOCOL_VERSION,
  PROGRESS_PROTOCOL_CAPABILITIES,
  PROGRESS_EVENT_SCHEMA,
  PROGRESS_EVENT_JSON_SCHEMA,
  normalizeProgressEvent,
  validateProgressEvent
};
