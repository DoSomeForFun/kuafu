/**
 * Lightweight LLM HTTP client (OpenAI-compatible)
 */

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

class LLMHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = 'LLMHttpError';
  }
  get isRetryable(): boolean {
    return RETRYABLE_STATUS.has(this.status);
  }
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      if ((err as any)?.name === 'AbortError') throw err;
      const httpErr = err instanceof LLMHttpError ? err : null;
      if (httpErr && !httpErr.isRetryable) throw err;
      if (attempt >= MAX_RETRIES) break;
      const retryAfter = httpErr?.retryAfterMs ?? 0;
      const jitter = Math.random() * 200;
      const delay = Math.max(retryAfter, BASE_DELAY_MS * Math.pow(2, attempt)) + jitter;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

export interface LLMClientOptions {
  endpoint: string;
  model: string;
  apiKey: string;
  timeoutMs?: number;
}

export interface LLMCompletionOptions {
  jsonSchema?: Record<string, unknown>;
  jsonSchemaName?: string;
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    };
  }>;
  toolChoice?: 'auto' | 'none' | 'required';
}

export interface LLMToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface LLMCompletionResult {
  content: string;
  finishReason?: string;
  toolCalls?: LLMToolCall[];
}

export interface LLMClient {
  chatCompletion(
    messages: Array<{ role: string; content: string }>,
    opts?: LLMCompletionOptions
  ): Promise<LLMCompletionResult>;
}

function buildRequestBody(
  messages: Array<{ role: string; content: string }>,
  model: string,
  opts?: LLMCompletionOptions
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: 256,
  };
  if (opts?.jsonSchema) {
    body['response_format'] = {
      type: 'json_schema',
      json_schema: {
        name: opts.jsonSchemaName || 'output',
        schema: opts.jsonSchema,
        strict: true,
      },
    };
  }
  if (opts?.tools && opts.tools.length > 0) {
    body['tools'] = opts.tools;
    body['tool_choice'] = opts.toolChoice ?? 'auto';
  }
  return body;
}

function createHttpClient(opts: LLMClientOptions): LLMClient {
  return {
    async chatCompletion(messages, completionOpts) {
      const url = opts.endpoint.replace(/\/$/, '') + '/chat/completions';
      const body = buildRequestBody(messages, opts.model, completionOpts);

      return withRetry(async () => {
        const controller = new AbortController();
        const timeoutId = opts.timeoutMs
          ? setTimeout(() => controller.abort(), opts.timeoutMs)
          : null;
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${opts.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            const retryAfter = res.headers.get('retry-after');
            const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : undefined;
            throw new LLMHttpError(
              res.status,
              `LLM HTTP ${res.status}: ${text.slice(0, 200)}`,
              retryAfterMs
            );
          }
          const json = await res.json() as any;
          const choice = json.choices?.[0];
          const rawToolCalls: LLMToolCall[] | undefined =
            Array.isArray(choice?.message?.tool_calls) && choice.message.tool_calls.length > 0
              ? choice.message.tool_calls
              : undefined;
          return {
            content: choice?.message?.content ?? '',
            finishReason: choice?.finish_reason,
            toolCalls: rawToolCalls,
          };
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
        }
      });
    },
  };
}

export function createLLMClient(
  transport: 'http',
  opts: LLMClientOptions
): LLMClient {
  if (transport !== 'http') {
    throw new Error(`Unsupported LLM transport: ${transport}`);
  }
  return createHttpClient(opts);
}
