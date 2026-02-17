import pino from 'pino';
import { AsyncLocalStorage } from 'async_hooks';

// Async Context for Trace ID
const asyncLocalStorage = new AsyncLocalStorage();

// Structured Logger
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  },
});

/**
 * Run a function within a trace context
 * @param {string} traceId - Unique ID for the request/task
 * @param {Function} callback - Function to execute
 */
export function runWithTrace(traceId, callback) {
  const store = { traceId: traceId || `trace-${Date.now()}` };
  return asyncLocalStorage.run(store, callback);
}

/**
 * Get current trace ID
 */
export function getTraceId() {
  const store = asyncLocalStorage.getStore();
  return store?.traceId || 'no-trace';
}

/**
 * Telemetry Interface
 */
export const telemetry = {
  info: (msg, data = {}) => {
    logger.info({ traceId: getTraceId(), ...data }, msg);
  },
  warn: (msg, data = {}) => {
    logger.warn({ traceId: getTraceId(), ...data }, msg);
  },
  error: (msg, error) => {
    logger.error({ traceId: getTraceId(), err: error }, msg);
  },
  debug: (msg, data = {}) => {
    logger.debug({ traceId: getTraceId(), ...data }, msg);
  },
  
  // Span Tracking (Simple)
  startSpan: (name) => {
    const start = Date.now();
    telemetry.debug(`[Span Start] ${name}`);
    return {
      end: (attributes = {}) => {
        const duration = Date.now() - start;
        telemetry.info(`[Span End] ${name}`, { durationMs: duration, ...attributes });
      }
    };
  }
};
