/**
 * Lightweight LLM HTTP client (OpenAI-compatible)
 */

export interface LLMClientOptions {
  endpoint: string;
  model: string;
  apiKey: string;
  timeoutMs?: number;
}

export interface LLMCompletionOptions {
  jsonSchema?: Record<string, unknown>;
  jsonSchemaName?: string;
}

export interface LLMCompletionResult {
  content: string;
  finishReason?: string;
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
  return body;
}

function createHttpClient(opts: LLMClientOptions): LLMClient {
  return {
    async chatCompletion(messages, completionOpts) {
      const url = opts.endpoint.replace(/\/$/, '') + '/chat/completions';
      const body = buildRequestBody(messages, opts.model, completionOpts);
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
          throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        const json = await res.json() as any;
        const choice = json.choices?.[0];
        return {
          content: choice?.message?.content ?? '',
          finishReason: choice?.finish_reason,
        };
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
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
