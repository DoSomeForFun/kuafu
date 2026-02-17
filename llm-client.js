/**
 * LLM Client Adapter Layer
 * Supports HTTP (OpenAI-compatible) and iFlow SDK backends
 */
import { telemetry } from "./telemetry.js";

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
      throw new Error(`LLM endpoint is missing. Please check your .env configuration (OPENAI_COMPAT_BASE_URL or AGENT_ROUTER_BASE_URL).`);
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
      throw new Error(`HTTP request failed (${response.status}): ${text}`);
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
 * CLI Adapter
 * Uses subprocess to call CLI tools (iflow/qwen) directly with positional prompt
 */
export class CLIAdapter extends LLMClient {
  constructor(config) {
    super(config);
    this.cliCommand = config.cliCommand || "iflow"; // Default to iflow
  }

  getType() {
    return this.cliCommand;
  }

  /**
   * @param {LLMMessage[]} messages
   * @param {object} options
   * @returns {Promise<LLMResponse>}
   */
  async chatCompletion(messages, options = {}) {
    const { spawn } = await import("node:child_process");

    // Extract the last user message for the prompt
    const lastUserMessage = messages.filter(m => m.role === "user").pop();
    if (!lastUserMessage) {
      throw new Error("No user message found");
    }

    // Build conversation context from history
    const historyMessages = messages.slice(0, -1);
    let context = "";
    if (historyMessages.length > 0) {
      context = historyMessages.map(m => {
        const role = m.role === "assistant" ? "Assistant" : "User";
        return `${role}: ${m.content}`;
      }).join("\n\n");
    }

    // Build the final prompt
    const prompt = context ? `${context}\n\nUser: ${lastUserMessage.content}` : lastUserMessage.content;

    return new Promise((resolve, reject) => {
      const chunks = [];
      const errors = [];

      // Spawn CLI with positional prompt (iflow and qwen both support this)
      const args = [prompt];

      // Add model option if specified
      if (this.config.model) {
        args.unshift("-m", this.config.model);
      }

      const child = spawn(this.cliCommand, args, {
        cwd: process.cwd(),
        env: {
          ...process.env
        }
      });

      // Collect stdout
      child.stdout?.on("data", (chunk) => {
        chunks.push(chunk);
      });

      // Collect stderr (CLI may output progress there)
      child.stderr?.on("data", (chunk) => {
        errors.push(chunk);
      });

      child.on("close", (code) => {
        const content = Buffer.concat(chunks).toString("utf-8").trim();
        const errorOutput = Buffer.concat(errors).toString("utf-8");

        if (code === 0) {
          resolve({
            content,
            thinking: "",
            tool_calls: [],
            raw: { content, exitCode: code }
          });
        } else {
          telemetry.error(`[${this.cliCommand.toUpperCase()}Adapter] CLI failed`, new Error(errorOutput || content));
          reject(new Error(`${this.cliCommand} CLI exited with code ${code}: ${errorOutput || content}`));
        }
      });

      child.on("error", (error) => {
        reject(new Error(`Failed to spawn ${this.cliCommand} CLI: ${error.message}`));
      });
    });
  }
}

/**
 * iFlow SDK Adapter
 * Wraps @iflow-ai/iflow-cli-sdk using WebSocket ACP protocol
 */
export class IFlowSDKClient extends LLMClient {
  /**
   * @param {LLMClientConfig} config
   */
  constructor(config) {
    super(config);
    // iFlow SDK uses IFlowClient class, not HTTP-style API
    this.client = null;
    this._initialized = false;
    this._isReceiving = false; // Track if currently receiving messages
    this._pendingMessages = []; // Queue for pending messages
  }

  getType() {
    return "iflow-sdk";
  }

  async _ensureInitialized() {
    // Always create a fresh connection for each request
    // Clean up existing connection if any
    if (this.client) {
      try {
        await this.client.disconnect();
      } catch (e) {
        // Ignore disconnect errors
      }
      this.client = null;
    }

    try {
      // Dynamically import the SDK
      const { IFlowClient } = await import("@iflow-ai/iflow-cli-sdk");

      // Use default configuration - SDK will handle everything
      // authMethodInfo is read from ~/.iflow/settings.json automatically
      this.client = new IFlowClient();
      await this.client.connect();
      this._initialized = true;
      this._isReceiving = false;
    } catch (error) {
      throw new Error(`Failed to initialize iFlow SDK: ${error.message}`);
    }
  }

  _buildSystemPrompt() {
    if (this.config.toolsEnabled) {
      return "You are an autonomous engineering agent. You may call local tools when needed.";
    }
    return "You are an autonomous engineering agent.";
  }

  /**
   * @param {LLMMessage[]} messages
   * @param {object} options
   * @returns {Promise<LLMResponse>}
   */
  async chatCompletion(messages, options = {}) {
    await this._ensureInitialized();

    // Extract the last user message for the prompt
    const lastUserMessage = messages.filter(m => m.role === "user").pop();
    if (!lastUserMessage) {
      throw new Error("No user message found");
    }

    // Build conversation context from history
    const historyMessages = messages.slice(0, -1);
    let context = "";
    if (historyMessages.length > 0) {
      context = historyMessages.map(m => {
        const role = m.role === "assistant" ? "Assistant" : "User";
        return `${role}: ${m.content}`;
      }).join("\n\n");
    }

    // Build the final prompt
    const prompt = context ? `${context}\n\nUser: ${lastUserMessage.content}` : lastUserMessage.content;

    try {
      // Send message to iFlow and collect response
      await this.client.sendMessage(prompt);

      const responseParts = [];
      const thoughtParts = [];
      const toolCalls = [];

      // Prevent concurrent receive operations
      if (this._isReceiving) {
        throw new Error("iFlow SDK client is already receiving messages");
      }
      this._isReceiving = true;

      try {
        // Receive messages until task finishes with timeout
        const startTime = Date.now();
        const maxWaitTime = this.config.timeoutMs || 120000;

        // Track plan entries
        const planEntries = [];

        for await (const message of this.client.receiveMessages()) {
          if (Date.now() - startTime > maxWaitTime) {
            telemetry.warn("[IFlowSDKClient] Timeout waiting for response");
            break;
          }

          telemetry.debug("[IFlowSDKClient] Received message type", { type: message.type });

          if (message.type === "plan") {
            // Handle plan messages
            if (message.entries) {
              planEntries.push(...message.entries);
              telemetry.debug("[IFlowSDKClient] Plan received", { count: message.entries.length });
            }
          } else if (message.type === "assistant") {
            if (message.chunk?.text) {
              responseParts.push(message.chunk.text);
              telemetry.debug("[IFlowSDKClient] Text chunk received", { totalLength: responseParts.join("").length });
            }
            if (message.chunk?.thought) {
              thoughtParts.push(message.chunk.thought);
            }
          } else if (message.type === "tool_call") {
            // Track tool calls
            toolCalls.push({
              id: message.id,
              name: message.toolName || "unknown",
              arguments: message.args || {},
              raw: message
            });
            telemetry.debug("[IFlowSDKClient] Tool call", { name: message.toolName });
          } else if (message.type === "task_finish") {
            telemetry.info("[IFlowSDKClient] Task finished");
            break;
          } else if (message.type === "error") {
            telemetry.error("[IFlowSDKClient] Error message", new Error(message.message));
            throw new Error(message.message);
          }
        }

        // Format plan entries as text if present
        let planText = "";
        if (planEntries.length > 0) {
          planText = "\n\n执行计划：\n" + planEntries.map(entry => {
            const statusIcon = entry.status === "completed" ? "✅" :
              entry.status === "in_progress" ? "⏳" : "📋";
            return `${statusIcon} [${entry.priority || 'medium'}] ${entry.content}`;
          }).join("\n");
        }

        // Convert tool calls to OpenAI-compatible format
        const toolCallsOpenAI = toolCalls.map(tc => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          raw: {
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments)
            }
          }
        }));

        return {
          content: responseParts.join("") + planText,
          thinking: thoughtParts.join(""),
          tool_calls: toolCallsOpenAI,
          raw: {
            messages: responseParts,
            thoughts: thoughtParts,
            tools: toolCalls,
            plan: planEntries
          }
        };
      } finally {
        this._isReceiving = false;
      }
    } catch (error) {
      throw new Error(`iFlow SDK chat completion failed: ${error.message}`);
    }
  }
  /**
   * Cleanup resources
   */
  async cleanup() {
    if (this.client) {
      try {
        await this.client.disconnect();
      } catch (error) {
        telemetry.warn("Failed to disconnect iFlow client", { error: error?.message || String(error) });
      }
      this.client = null;
      this._initialized = false;
    }
  }
}

/**
 * Factory function to create LLM client based on configuration
 * @param {string} adapterType - "http" or "iflow-sdk"
 * @param {LLMClientConfig} config
 * @returns {LLMClient}
 */
export function createLLMClient(adapterType, config) {
  const type = String(adapterType || "http").toLowerCase().trim();

  switch (type) {
    case "http":
      return new HttpLLMClient(config);
    case "cli":
      return new CLIAdapter({ ...config, cliCommand: config.cliCommand || "iflow" });
    case "iflow":
      return new CLIAdapter({ ...config, cliCommand: "iflow" });
    case "qwen":
      return new CLIAdapter({ ...config, cliCommand: "qwen" });
    case "iflow-sdk":
      return new IFlowSDKClient(config);
    default:
      throw new Error(`Unknown LLM adapter type: ${type}`);
  }
}
