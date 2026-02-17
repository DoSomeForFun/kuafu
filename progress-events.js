const EVENT_TYPES = {
  RUN_STARTED: "run_started",
  STEP_STARTED: "step_started",
  TOOL_STARTED: "tool_started",
  TOOL_HEARTBEAT: "tool_heartbeat",
  TOOL_FINISHED: "tool_finished",
  RUN_FINISHED: "run_finished",
  RUN_FAILED: "run_failed"
};

function toSafeInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function getProgressHeartbeatMs() {
  return Math.max(1000, toSafeInt(process.env.AGENT_PROGRESS_HEARTBEAT_MS, 12000));
}

export function createProgressEvent(base, type, payload = {}) {
  return {
    type,
    taskId: base.taskId,
    sessionId: base.sessionId,
    ts: new Date().toISOString(),
    ...payload
  };
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

export { EVENT_TYPES };
