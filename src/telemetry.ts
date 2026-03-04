import pino from 'pino';

/**
 * Telemetry interface
 */
export interface Telemetry {
  info(message: string, data?: any): void;
  warn(message: string, data?: any): void;
  error(message: string, data?: any): void;
  debug(message: string, data?: any): void;
  startSpan(name: string): Span;
}

/**
 * Span interface for tracing
 */
export interface Span {
  name: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, any>;
  end(attributes?: Record<string, any>): void;
}

/**
 * Simple span implementation
 */
class SimpleSpan implements Span {
  public name: string;
  public startTime: number;
  public endTime?: number;
  public attributes: Record<string, any> = {};

  constructor(name: string) {
    this.name = name;
    this.startTime = Date.now();
  }

  end(attributes?: Record<string, any>): void {
    this.endTime = Date.now();
    if (attributes) {
      this.attributes = { ...this.attributes, ...attributes };
    }
  }
}

/**
 * Logger instance
 */
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'yyyy-mm-dd HH:MM:ss'
    }
  }
});

/**
 * Telemetry implementation
 */
class TelemetryImpl implements Telemetry {
  info(message: string, data?: any): void {
    logger.info({ traceId: 'no-trace', ...data }, message);
  }

  warn(message: string, data?: any): void {
    logger.warn({ traceId: 'no-trace', ...data }, message);
  }

  error(message: string, data?: any): void {
    logger.error({ traceId: 'no-trace', ...data }, message);
  }

  debug(message: string, data?: any): void {
    logger.debug({ traceId: 'no-trace', ...data }, message);
  }

  startSpan(name: string): Span {
    return new SimpleSpan(name);
  }
}

/**
 * Default telemetry instance
 */
export const telemetry: Telemetry = new TelemetryImpl();

/**
 * Run function with trace context
 */
export async function runWithTrace<T>(
  traceId: string,
  fn: () => Promise<T>
): Promise<T> {
  const span = telemetry.startSpan(traceId);
  try {
    const result = await fn();
    span.end({ success: true });
    return result;
  } catch (error) {
    span.end({ success: false, error: (error as Error).message });
    throw error;
  }
}

export default {
  telemetry,
  runWithTrace
};

import type { TraceSink, TracePayload } from './types.js';

/**
 * ConsoleSink — development TraceSink that prints each trace to stdout.
 * Usage: `new Kernel({ store, llm, traceSink: new ConsoleSink() })`
 */
export class ConsoleSink implements TraceSink {
  onTrace(payload: TracePayload): void {
    console.log('[kuafu:trace]', JSON.stringify({
      traceId: payload.traceId,
      taskId: payload.taskId,
      step: payload.stepCount,
      model: payload.model,
      latencyMs: payload.llmResult.latencyMs,
      promptLen: payload.systemPrompt?.length ?? 0,
      responseLen: payload.llmResult.content?.length ?? 0,
    }, null, 2));
  }
}

/**
 * SQLiteSink — production TraceSink that persists traces to a SQLite table.
 *
 * Creates table `kuafu_traces_log` if not exists.
 * Usage: `new Kernel({ store, llm, traceSink: new SQLiteSink(store) })`
 */
export class SQLiteSink implements TraceSink {
  private db: import('better-sqlite3').Database;
  private ready = false;

  constructor(store: { db: import('better-sqlite3').Database }) {
    this.db = store.db;
  }

  private ensureTable(): void {
    if (this.ready) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kuafu_traces_log (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        session_id TEXT,
        step_count INTEGER,
        model TEXT,
        system_prompt TEXT,
        conversation_history TEXT,
        llm_response TEXT,
        latency_ms INTEGER,
        created_at INTEGER
      )
    `);
    this.ready = true;
  }

  onTrace(payload: TracePayload): void {
    this.ensureTable();
    this.db.prepare(`
      INSERT OR IGNORE INTO kuafu_traces_log
        (id, task_id, session_id, step_count, model, system_prompt, conversation_history, llm_response, latency_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      payload.traceId,
      payload.taskId,
      payload.sessionId,
      payload.stepCount,
      payload.model ?? null,
      payload.systemPrompt ?? null,
      JSON.stringify(payload.conversationHistory ?? []),
      payload.llmResult.content ?? null,
      payload.llmResult.latencyMs ?? null,
      Date.now()
    );
  }
}
