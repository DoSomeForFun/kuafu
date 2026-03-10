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
