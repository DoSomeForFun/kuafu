/**
 * LLM Client Adapter Layer
 * Supports HTTP (OpenAI-compatible) backend
 */
import { telemetry } from "./telemetry.js";
import { ErrorType, classifyError, getErrorDescription, createClassifiedError } from "./errors.js";

/**
 * @typedef {Object} LLMMessage
 * @property {string} role - "system", "user", "assistant"
 * @property {string} content - Message content
 * @property {Array<{type: string, function?: {name: string, arguments: string}}>} [tool_calls] - Optional tool calls
 */

/**
 * @typedef {Object} LLMResponse
 * @property {string} content - Response content
 * @property {string} [thinking] - Optional thinking/reasoning content
 * @property {Array<{id: string, name: string, arguments: object, raw: object}>} [tool_calls] - Optional tool calls
 * @property {object} raw - Raw response from the backend
 * @property {number} [promptTokens] - Optional prompt token count
 * @property {number} [completionTokens] - Optional completion token count
 */

/**
 * @typedef {Object} LLMClientConfig
 * @property {string} endpoint - API endpoint URL
 * @property {string} apiKey - API key
 * @property {string} model - Model name
 * @property {number} timeoutMs - Request timeout in milliseconds
 * @property {number|null} temperature - Optional temperature parameter
 * @property {boolean} toolsEnabled - Whether tools are enabled
 * @property {Array<object>} [tools] - Tool definitions
 * @property {string} [toolProtocol] - "native" or "xml"
 */

/**
 * Base LLM Client Interface
 */
export class LLMClient {
  /**
   * @param {LLMClientConfig} config
   */
  constructor(config) {
    this.config = config;
  }

  /**
   * Create a chat completion
   * @param {LLMMessage[]} messages - Array of messages
   * @param {object} options - Additional options
   * @returns {Promise<LLMResponse>}
   */
  async chatCompletion(messages, options = {}) {
    throw new Error("chatCompletion must be implemented by subclass");
  }

  /**
   * Get client type identifier
   * @returns {string}
   */
  getType() {
    throw new Error("getType must be implemented by subclass");
  }
}

/**
 * HTTP/OpenAI-compatible Adapter
 */
export class HttpLLMClient extends LLMClient {
  /**
   * @param {LLMClientConfig} config
   */
  constructor(config) {
    super(config);
    this.endpoint = this._resolveEndpoint(config.endpoint);
  }

  _resolveEndpoint(baseUrl) {
    const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
    if (!trimmed) return "";
    if (trimmed.endsWith("/chat/completions")) return trimmed;
    return `${trimmed}/chat/completions`;
  }

  getType() {
    return "http";
  }

  /**
   * @param {LLMMessage[]} messages
   * @param {object} options
   * @returns {Promise<LLMResponse>}
   */
  async chatCompletion(messages, options = {}) {
    if (!this.endpoint) {
      const errorType = classifyError(new Error("LLM endpoint is missing"));
      const description = getErrorDescription(errorType);
      throw new Error(`${description}. Please check your .env configuration (KUAFU_ROUTER_BASE_URL or OPENAI_COMPAT_BASE_URL).`);
    }

    const allowTools = options.allowTools !== false;
    const body = {
      model: this.config.model,
      messages
    };

    // 优先使用结构化输出 (Structured Outputs)
    if (options.jsonSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: options.jsonSchemaName || "toastplan_response",
          strict: true,
          schema: options.jsonSchema
        }
      };
    } else if (options.jsonMode) {
      body.response_format = { type: "json_object" };
    }

    if (allowTools && this.config.toolsEnabled && this.config.toolProtocol === "native") {
      // 如果开启了严格模式，为工具增加 strict: true
      body.tools = (this.config.tools || []).map(t => {
        if (options.strictTools) {
          return {
            ...t,
            function: { ...t.function, strict: true }
          };
        }
        return t;
      });
      body.tool_choice = "auto";
    }

    if (Number.isFinite(this.config.temperature)) {
      body.temperature = this.config.temperature;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), this.config.timeoutMs);
    let response;

    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text();
      const errorType = classifyError(new Error(text), { status: response.status });
      const description = getErrorDescription(errorType);
      throw new Error(`${description} (${response.status}): ${text}`);
    }

    const json = await response.json();
    return this._parseResponse(json);
  }

  _parseResponse(json) {
    const content = this._extractText(json);
    const thinking = this._extractThinking(json);
    const toolCalls = this._extractNativeToolCalls(json);

    return {
      content,
      thinking,
      tool_calls: toolCalls,
      raw: json,
      promptTokens: json?.usage?.prompt_tokens,
      completionTokens: json?.usage?.completion_tokens
    };
  }

  _extractText(responseJson) {
    const content = responseJson?.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (!item) return "";
          if (typeof item === "string") return item;
          if (typeof item.text === "string") return item.text;
          return "";
        })
        .join("");
    }
    return "";
  }

  _extractThinking(responseJson) {
    const message = responseJson?.choices?.[0]?.message || {};
    const reasoning =
      message.reasoning ||
      responseJson?.choices?.[0]?.reasoning ||
      responseJson?.usage?.reasoning_tokens || "";
    return String(reasoning || "");
  }

  _extractNativeToolCalls(responseJson) {
    const rawCalls = responseJson?.choices?.[0]?.message?.tool_calls;
    if (!Array.isArray(rawCalls)) return [];
    return rawCalls
      .map((row) => {
        const id = String(row?.id || "").trim();
        const rawName = String(row?.function?.name || "").trim().toLowerCase();
        if (!id || !rawName) return null;
        const args = this._parseJsonObject(row?.function?.arguments);
        return {
          id,
          name: rawName,
          arguments: args,
          raw: {
            id,
            type: "function",
            function: {
              name: rawName,
              arguments: JSON.stringify(args)
            }
          }
        };
      })
      .filter(Boolean);
  }

  _parseJsonObject(rawValue) {
    if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
      return rawValue;
    }
    const raw = this._stripCodeFence(String(rawValue || "").trim());
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch { }
    return {};
  }

  _stripCodeFence(rawText) {
    const text = String(rawText || "").trim();
    const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return fenced ? fenced[1].trim() : text;
  }
}

/**
 * Factory function to create LLM client based on configuration
 * @param {string} adapterType - "http"
 * @param {LLMClientConfig} config
 * @returns {LLMClient}
 */
export function createLLMClient(adapterType, config) {
  const type = String(adapterType || "http").toLowerCase().trim();

  switch (type) {
    case "http":
      return new HttpLLMClient(config);
    default:
      throw new Error(`Unknown LLM adapter type: ${type}`);
  }
}
