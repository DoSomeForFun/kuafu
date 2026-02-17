import { Perception } from "./perception.js";
import { Decision } from "./decision.js";
import { Action } from "./action.js";
import { createLLMClient } from "./llm-client.js";
import { telemetry, runWithTrace } from "./telemetry.js";

/**
 * The Unified Kernel (HuluWa 2.0 - Pragmatic & Robust)
 * 核心设计：拦截空谈承诺，强制执行落地。
 */
export class Kernel {
  constructor(options = {}) {
    this.store = options.store || options.backend;
    this.chatCompletionOverride = options.chatCompletion;
    this.action = options.action || new Action({ cwd: options.workdir });
    this._llmClient = null;
    this._llmClientKey = null;
  }

  getOutputSchema() {
    return {
      type: "object",
      properties: {
        thought: { type: "string" },
        message: { type: "string" },
        protocol: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["RUNNING", "DONE", "FAILED"] },
            next_action: { type: "string" },
            call_tool: {
              type: "object",
              properties: {
                name: { type: "string" },
                arguments: { type: "object" }
              },
              required: ["name", "arguments"]
            },
            interaction: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["confirmation", "choice", "input"] },
                title: { type: "string" },
                description: { type: "string" },
                data: { type: "object" },
                options: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string" },
                      value: { type: "string" },
                      style: { type: "string", enum: ["primary", "secondary", "danger"] }
                    },
                    required: ["label", "value"]
                  }
                }
              },
              required: ["type", "description", "options"]
            }
          },
          required: ["status", "next_action"]
        }
      },
      required: ["thought", "message", "protocol"]
    };
  }

  async run(options) {
    const { taskId, prompt: originalPrompt, sessionId, maxSteps = 30, retrievedContext = [], onStep, maxHistory = 10 } = options;
    const traceId = `task-${taskId}-sess-${sessionId}-${Date.now()}`;

    return new Promise((resolve, reject) => {
      runWithTrace(traceId, async () => {
        const span = telemetry.startSpan("Kernel.run");
        try {
          // --- INIT State ---
          const task = await this.store.getTaskById(taskId);
          if (!task) throw new Error(`Task not found: ${taskId}`);

          const decision = new Decision({ maxSteps });
          const perception = new Perception({ skillsDir: process.env.TELEGRAM_SKILLS_DIR });

          let currentBranchId = task.current_branch_id || (await this.store.pivotBranch(taskId));

          // Save User Prompt to History ONCE at the start
          const existingMsgs = await this.store.getActiveMessages(taskId, currentBranchId);
          const lastMsg = existingMsgs[existingMsgs.length - 1];
          if (!lastMsg || lastMsg.senderId !== "user" || lastMsg.content !== originalPrompt) {
            await this.store.saveTaskMessage({
              taskId, branchId: currentBranchId, senderId: "user",
              content: originalPrompt, payload: {}
            });
          }

          // Context Object for FSM
          let context = {
            // Config
            taskId, sessionId, originalPrompt, maxSteps, maxHistory,
            agentName: options.agentName,
            onStep,
            // Components
            decision, perception, 
            // Runtime State
            state: "PERCEIVING",
            stepCount: 0,
            turnHint: null,
            isWorkspaceReady: false,
            // Data
            task,
            currentBranchId,
            retrievedContext,
            sensoryData: null,
            contextBlock: "",
            turnResult: null,
            advice: null,
            finalResult: null,
            // Flags
            isReroute: false
          };

          // --- FSM Loop ---
          while (context.state !== "DONE" && context.state !== "FAILED") {
            telemetry.debug(`[FSM] State: ${context.state}`);
            
            switch (context.state) {
              case "PERCEIVING":
                context = await this._handlePerceiving(context);
                break;
              case "THINKING":
                context = await this._handleThinking(context);
                break;
              case "DECIDING":
                context = await this._handleDeciding(context);
                break;
              case "ACTING":
                context = await this._handleActing(context);
                break;
              case "REFLECTING": // New State
                context = await this._handleReflecting(context);
                break;
              default:
                throw new Error(`Unknown state: ${context.state}`);
            }
          }

          span.end({ status: context.finalResult?.status || "DONE" });
          resolve(context.finalResult || { status: "DONE" });
        } catch (error) {
          telemetry.error(`Kernel run failed`, error);
          span.end({ status: "ERROR", error: error.message });
          reject(error);
        }
      });
    });
  }

  // --- FSM Handlers ---

  async _handlePerceiving(context) {
    const { perception, originalPrompt, task, retrievedContext, sessionId, taskId, isReroute } = context;
    
    // Construct prompt with retry hint if needed
    const promptToUse = isReroute 
      ? originalPrompt + " (RETRY: Ensure all relevant tools are included)"
      : originalPrompt;

    if (isReroute) {
      telemetry.info("[Kernel] Rerouting skills based on runtime signal.");
    }

    const isSimpleChat = this._isLikelyChitchat(promptToUse);
    const sensoryData = await perception.gather({
      prompt: promptToUse, task, retrievedContext, sessionId, taskId,
      isSimpleChat,
      requestChatCompletion: this._chat.bind(this),
      extractText: (json) => json.content || "",
      store: this.store // Pass store to allow lesson retrieval
    });

    if (sensoryData?.state) {
      sensoryData.state.currentTime = new Date().toISOString();
    }

    context.sensoryData = sensoryData;
    context.contextBlock = perception.formatToContext(sensoryData);
    context.state = "THINKING";
    context.isReroute = false; // Reset flag
    
    return context;
  }

  async _handleThinking(context) {
    context.stepCount++;
    const { taskId, currentBranchId, maxHistory, sensoryData, stepCount, turnHint, originalPrompt, agentName, contextBlock } = context;
    
    const stepSpan = telemetry.startSpan(`Step.${stepCount}`);
    const startTime = Date.now();

    // Time-Slicing Context Filter
    // 1. Fetch raw messages (limit is slightly larger than maxHistory to allow filtering)
    const rawMessages = await this.store.getActiveMessages(taskId, currentBranchId, maxHistory + 5);
    
    // 2. Filter by session timeout
    const SESSION_TIMEOUT = 60 * 60 * 1000; // 1 Hour
    const filteredMessages = [];
    
    if (rawMessages.length > 0) {
      // Logic: Iterate backwards. Keep adding messages until we find a gap > TIMEOUT.
      for (let i = rawMessages.length - 1; i >= 0; i--) {
        const currentMsg = rawMessages[i];
        
        // If this is not the last message, check gap with the NEXT one (chronologically later)
        if (i < rawMessages.length - 1) {
          const nextMsg = rawMessages[i + 1];
          const gap = nextMsg.createdAt - currentMsg.createdAt;
          
          if (gap > SESSION_TIMEOUT) {
            telemetry.info("[Kernel] Context time-slice detected. Dropping older history.", { 
              droppedCount: i + 1, 
              breakAt: new Date(currentMsg.createdAt).toISOString(),
              gapMs: gap
            });
            break; // Stop collecting, we hit the session boundary
          }
        }
        
        filteredMessages.unshift(currentMsg);
      }
    }
    
    // 3. Enforce max count limit
    const finalMessages = filteredMessages.slice(-maxHistory);
    
    const history = this._toHistory(finalMessages);
    const baseSystem = this._buildSystemPrompt();
    const system = `${baseSystem}\n\n${contextBlock}`;
    const requestMessages = [{ role: "system", content: system }, ...history];

    // Fast model switch
    let currentModel = null;
    const isSimpleChat = (sensoryData.skills.length === 0 || this._isLikelyChitchat(originalPrompt)) && stepCount <= 1;
    if (isSimpleChat && process.env.AGENT_CHAT_MODEL) {
      telemetry.info(`[Kernel] Switching to fast model (${process.env.AGENT_CHAT_MODEL}) for simple chat.`);
      currentModel = process.env.AGENT_CHAT_MODEL;
    }

    // Inject Hint
    if (turnHint) {
      telemetry.info(`[Kernel] Adding Turn Hint: ${turnHint}`);
      requestMessages.push({ role: "system", content: `[系统提醒]: ${turnHint}\n\n继续目标: ${originalPrompt}` });
    } else {
      telemetry.debug(`[Kernel] FINAL PROMPT (From History): ${originalPrompt}`);
    }
    
    // LLM Call
    const llmSpan = telemetry.startSpan("LLM.chat");
    const llmResponse = await this._chat({ agentName, model: currentModel }, requestMessages, {
      jsonSchema: this.getOutputSchema(),
      jsonSchemaName: "calabash_logic"
    });
    llmSpan.end({ tokens: llmResponse.usage?.total_tokens });

    const latencyMs = Date.now() - startTime;
    const turnResult = this._parseTurnResult(llmResponse, taskId);

    // Save Context
    context.turnResult = turnResult;
    context.llmResponse = llmResponse; // Store for persistence later
    context.latencyMs = latencyMs;     // Store for persistence later
    context.startTime = startTime;     // Store for persistence later
    context.stepSpan = stepSpan;       // Store to end it later

    // Notify Observer
    if (context.onStep) {
      context.onStep({ step: stepCount, thought: turnResult.thinking, message: turnResult.content, tool_calls: turnResult.tool_calls });
    }

    context.state = "DECIDING";
    return context;
  }

  async _handleDeciding(context) {
    const { decision, turnResult, stepCount, sensoryData, stepSpan } = context;
    
    const isSimpleChat = (sensoryData.skills.length === 0 || this._isLikelyChitchat(context.originalPrompt)) && stepCount <= 1;
    const explicitTaskIntent = this._isLikelyTaskIntent(context.originalPrompt);
    const advice = decision.analyze(turnResult, { stepCount, availableSkillsCount: sensoryData.skills.length, isSimpleChat, explicitTaskIntent });

    // Check if status is explicitly FAILED in the protocol
    if (turnResult.loopStatus === "FAILED" && advice.nextAction === "STOP") {
      advice.status = "FAILED";
    }

    telemetry.info(`[Kernel] Step ${stepCount} Advice: ${advice.nextAction}`, { advice });
    context.advice = advice;

    // Persist Agent Response (Atomic with decision?)
    // Actually we should persist before acting, but after deciding (to know if we intercepted)
    // Legacy logic persisted after decision. Let's persist here.
    const executionId = await this._saveExecution(
      context.taskId, context.originalPrompt, turnResult, context.llmResponse, context.latencyMs, context.startTime
    );
    await this.store.saveTaskMessage({
      taskId: context.taskId, branchId: context.currentBranchId, executionId, senderId: "agent",
      content: turnResult.content,
      payload: { 
        thinking: turnResult.thinking, 
        loopStatus: turnResult.loopStatus, 
        loopProtocol: turnResult.loopProtocol, 
        tool_calls: turnResult.tool_calls 
      }
    });

    if (advice.nextAction === "CONTINUE" && advice.promptHint) {
      telemetry.warn(`[Kernel] 🛡️ 拦截到空谈或需要重试。正在打回...`, { hint: advice.promptHint });
      context.turnHint = advice.promptHint;
      stepSpan.end({ status: "INTERCEPTED" });
      context.state = "THINKING"; // Loop back
    } else if (advice.nextAction === "STOP") {
      stepSpan.end({ status: advice.status });
      context.finalResult = { status: advice.status, turnResult, message: advice.message };
      
      // Auto-Reflection Trigger
      // Trigger if status is FAILED, or if configured to always reflect
      // For now, let's trigger on FAILED or if explicit request
      if (advice.status === "FAILED" || process.env.AGENT_ALWAYS_REFLECT === "true") {
        context.state = "REFLECTING";
      } else {
        context.state = "DONE";
      }
    } else {
      // CONTINUE without hint -> ACTING
      // Clear hint if any
      context.turnHint = null;
      context.state = "ACTING";
      // stepSpan is NOT ended yet, it covers the Action phase too in legacy logic?
      // In legacy: stepSpan.end({ status: advice.nextAction }) happened AFTER action loop.
      // So we keep stepSpan open.
    }

    return context;
  }

  _isLikelyChitchat(prompt) {
    const text = String(prompt || "")
      .split("\n")
      .map((line) => String(line || "").trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith("[Context]"))
      .filter((line) => !line.startsWith("[用户信息]"))
      .filter((line) => !/^\[[^\]]+\]$/.test(line))
      .slice(-3)
      .join(" ");

    const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
    if (!normalized) return true;
    if (normalized.length > 30) return false;

    const greet = /^(hi|hello|hey|yo|ping|test|你好|在吗|在么|早上好|上午好|中午好|下午好|晚上好|晚安|[?？!！]+)$/i;
    if (greet.test(normalized)) return true;

    const greet2 = /(你好|在吗|早上好|上午好|中午好|下午好|晚上好|晚安)\s*[!！。\.]?\s*$/i;
    if (greet2.test(normalized) && normalized.length <= 12) return true;

    return false;
  }

  _isLikelyTaskIntent(prompt) {
    const text = String(prompt || "")
      .split("\n")
      .map((line) => String(line || "").trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith("[Context]"))
      .filter((line) => !line.startsWith("[用户信息]"))
      .slice(-6)
      .join(" ");

    const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
    if (!normalized) return false;

    const actionish = /(查|搜索|找|列出|统计|分析|总结|解释|对比|修复|修改|实现|添加|删除|重构|优化|生成|写|跑|运行|执行|测试|构建|部署)/;
    const tooling = /(docker|npm|node|pnpm|yarn|git|sqlite|sql|curl|http|log|logs|报错|error|stack)/i;
    const codeish = /(\.js|\.ts|\.json|\.md|package\.json|dockerfile|compose|readme)/i;

    if (tooling.test(normalized) || codeish.test(normalized)) return true;
    if (actionish.test(text) && normalized.length >= 6) return true;
    return false;
  }

  async _handleActing(context) {
    const { turnResult, taskId, currentBranchId, onStep, stepSpan, advice } = context;
    
    // Check Sandbox
    if (process.env.AGENT_ENABLE_SANDBOX === "true" && !context.isWorkspaceReady) {
      await this.action.setupWorkspace(taskId);
      context.isWorkspaceReady = true;
    }

    let needsReroute = false;

    if (turnResult.tool_calls?.length > 0) {
      for (const tc of turnResult.tool_calls) {
        const toolSpan = telemetry.startSpan(`Tool.${tc.function?.name || tc.name}`);
        const actionResult = await this._executeAction(tc);
        toolSpan.end({ success: actionResult.ok });

        if (!actionResult.ok && typeof actionResult.error === "string" && actionResult.error.toLowerCase().includes("not found")) {
          needsReroute = true;
        }
        
        if (onStep) onStep({ tool_result: actionResult });
        
        await this.store.saveTaskMessage({
          taskId, branchId: currentBranchId, executionId: null, senderId: "system",
          content: JSON.stringify(actionResult),
          payload: { tool_call_id: tc.id }
        });
      }
    }

    stepSpan.end({ status: advice.nextAction });

    if (needsReroute) {
      context.isReroute = true;
      context.state = "PERCEIVING";
    } else {
      context.state = "THINKING";
    }

    return context;
  }

  async _handleReflecting(context) {
    const { taskId, currentBranchId, maxHistory, originalPrompt, finalResult } = context;
    
    telemetry.info("[Kernel] Entering Reflection Phase");
    const span = telemetry.startSpan("Kernel.reflect");
    
    // 1. Fetch recent history to provide context for reflection
    const messages = await this.store.getActiveMessages(taskId, currentBranchId, 20); // More context for reflection
    const history = this._toHistory(messages);
    
    // 2. Build Reflection Prompt
    const reflectionPrompt = `
[SYSTEM: AUTO-REFLECTION]
The task has ended with status: ${finalResult.status}.
Your goal is to analyze the execution history and identify if there are any valuable lessons to be learned.

Criteria for a valid lesson:
1. It must be a specific, actionable rule (e.g., "Do not use tool X for Y", "Always check Z before doing A").
2. It should be reusable for future tasks.
3. If the failure was due to simple network error or temporary issue, IGNORE it.

Output Format:
If you find a lesson, return a JSON object with:
{
  "root_cause": "Brief explanation of why it failed",
  "what_not_to_do": "The bad practice to avoid",
  "suggested_alternatives": "The best practice to follow"
}

If NO lesson is worth recording, return exactly: {"ignore": true}
`;

    const requestMessages = [
      ...history,
      { role: "system", content: reflectionPrompt }
    ];

    try {
      // Use fast model for reflection if available
      const model = process.env.AGENT_CHAT_MODEL || null;
      
      const response = await this._chat({ agentName: "Reflector", model }, requestMessages, {
        jsonSchema: {
            type: "object",
            properties: {
                root_cause: { type: "string" },
                what_not_to_do: { type: "string" },
                suggested_alternatives: { type: "string" },
                ignore: { type: "boolean" }
            }
        },
        jsonSchemaName: "reflection_output"
      });
      
      const content = response.content || response.choices?.[0]?.message?.content || "{}";
      let lesson = {};
      try {
        lesson = JSON.parse(content);
      } catch (e) {
        telemetry.warn("[Kernel] Failed to parse reflection JSON", { content });
      }

      if (lesson && !lesson.ignore && lesson.what_not_to_do) {
        telemetry.info("[Kernel] Lesson identified", lesson);
        
        // Inject Interaction Protocol into final result
        if (!context.finalResult.protocol) context.finalResult.protocol = {};
        context.finalResult.protocol.interaction = {
          type: "confirmation",
          title: "💡 Experience & Lesson",
          description: `I identified a potential lesson from this failure:\n\n❌ **Avoid**: ${lesson.what_not_to_do}\n✅ **Prefer**: ${lesson.suggested_alternatives}\n\nShould I record this?`,
          data: { lesson },
          options: [
            { label: "✅ Record", value: "confirm", style: "primary" },
            { label: "🗑️ Ignore", value: "ignore", style: "secondary" }
          ]
        };
      } else {
        telemetry.info("[Kernel] No lesson identified.");
      }
    } catch (err) {
      telemetry.error("[Kernel] Reflection failed", err);
    }
    
    span.end();
    context.state = "DONE"; // Terminal state
    return context;
  }

  _buildSystemPrompt() {
    return `你必须返回 JSON 格式回复。`;
  }

  async _chat(config, messages, options = {}) {
    if (this.chatCompletionOverride) return this.chatCompletionOverride(config, messages);

    // Allow config to override defaults
    const endpoint = config.endpoint || this._getEnv("BASE_URL");
    const apiKey = config.apiKey || this._getEnv("API_KEY");
    const model = config.model || this._getEnv("MODEL");

    let finalEndpoint = endpoint;
    let finalApiKey = apiKey;

    if (config.model && config.model === process.env.AGENT_CHAT_MODEL) {
      if (process.env.AGENT_CHAT_BASE_URL) finalEndpoint = process.env.AGENT_CHAT_BASE_URL;
      if (process.env.AGENT_CHAT_API_KEY) finalApiKey = process.env.AGENT_CHAT_API_KEY;
    }

    const toolSpecs = this.action.getSpecs();
    const toolsKey = toolSpecs.map(t => t.function?.name).filter(Boolean).join("|");
    const clientKey = JSON.stringify({
      endpoint: finalEndpoint,
      apiKey: finalApiKey,
      model,
      toolsKey
    });

    if (!this._llmClient || this._llmClientKey !== clientKey) {
      this._llmClient = createLLMClient("http", {
        endpoint: finalEndpoint,
        apiKey: finalApiKey,
        model,
        timeoutMs: 120000,
        tools: toolSpecs,
        toolsEnabled: true
      });
      this._llmClientKey = clientKey;
    }
    return this._llmClient.chatCompletion(messages, options);
  }

  _getEnv(field) { return process.env[`OPENAI_COMPAT_${field}`] || process.env[`AGENT_${field}`] || process.env[`TELEGRAM_${field}`] || ""; }

  _parseTurnResult(resp, taskId) {
    try {
      telemetry.debug("[Kernel] Raw LLM Content", { content: resp.content });
      telemetry.debug("[Kernel] Raw LLM ToolCalls", { tool_calls: resp.tool_calls });

      const rawJson = JSON.parse(resp.content.match(/\{[\s\S]*\}/)[0]);
      const tool_calls = resp.tool_calls || [];

      // Spec 1: Standard Protocol (rawJson.protocol.call_tool)
      if (rawJson.protocol?.call_tool && tool_calls.length === 0) {
        tool_calls.push({
          id: `json_call_${Date.now()}`,
          type: "function",
          function: { name: rawJson.protocol.call_tool.name, arguments: JSON.stringify(rawJson.protocol.call_tool.arguments) }
        });
      }
      // Spec 2: Fallback Strict Tool Object (e.g. {"tool": "bash", "command": ...} or {"name": "bash", "arguments": ...})
      else if (!rawJson.protocol && (rawJson.tool || rawJson.name) && (rawJson.command || rawJson.arguments) && tool_calls.length === 0) {
        // This handles the simplified JSON output seen in Turn 2
        const name = rawJson.tool || rawJson.name;
        const args = rawJson.arguments || rawJson;
        // Remove "tool" or "name" from args if they are at top level
        const cleanArgs = { ...args };
        delete cleanArgs.tool;
        delete cleanArgs.name;

        tool_calls.push({
          id: `json_call_fallback_${Date.now()}`,
          type: "function",
          function: { name, arguments: JSON.stringify(cleanArgs) }
        });
      }
      return {
        taskId, content: rawJson.message || "", thinking: rawJson.thought || "", tool_calls,
        loopStatus: rawJson.protocol?.status || "RUNNING", loopProtocol: rawJson.protocol || {}
      };
    } catch (e) {
      return { taskId, content: resp.content, thinking: "Parse Error", tool_calls: resp.tool_calls || [], loopStatus: "RUNNING" };
    }
  }

  async _executeAction(tc) {
    const fnName = tc.function?.name || tc.name;
    const fnArgs = tc.function?.arguments || tc.arguments;

    let args = {};
    try { args = typeof fnArgs === "string" ? JSON.parse(fnArgs) : fnArgs; } catch { }

    return this.action[fnName] ? await this.action[fnName](args) : { ok: false, error: `Tool ${fnName} not found.` };
  }

  async _saveExecution(taskId, prompt, turnResult, response, latencyMs, startTime) {
    const exec = await this.store.saveExecution({
      taskId, prompt, agentName: "toastplan", thinking: turnResult.thinking,
      status: turnResult.loopStatus, usagePromptTokens: response.usage?.prompt_tokens || 0,
      usageCompletionTokens: response.usage?.completion_tokens || 0,
      latencyMs, createdAt: startTime
    });
    return exec.id;
  }

  _toHistory(messages) {
    const history = [];
    let pendingToolIds = new Set();

    for (const m of messages) {
      const payload = m.payload || {};

      // 1. 如果有未完成的工具调用，且当前消息不是工具响应，先填补（补救中断的历史）
      if (pendingToolIds.size > 0 && (m.senderId !== "system" || !payload.tool_call_id)) {
        for (const id of pendingToolIds) {
          history.push({ role: "tool", tool_call_id: id, content: "Error: Tool execution interrupted or not recorded." });
        }
        pendingToolIds.clear();
      }

      if (m.senderId === "agent") {
        const hasTools = Array.isArray(payload.tool_calls) && payload.tool_calls.length > 0;
        let normalizedTools = undefined;

        if (hasTools) {
          normalizedTools = payload.tool_calls.map(tc => {
            // Fix: Ensure tool call has strict OpenAI structure
            if (!tc.function) {
              return {
                id: tc.id,
                type: "function",
                function: {
                  name: tc.name, // "name" from flat structure
                  arguments: typeof tc.arguments === "object" ? JSON.stringify(tc.arguments) : tc.arguments
                }
              };
            }
            return tc;
          });
          // 记录这些 ID 等待响应
          normalizedTools.forEach(t => pendingToolIds.add(t.id));
        }

        const content = typeof m.content === "string" ? m.content.trim() : "";
        if (!content && !hasTools) {
          continue;
        }
        history.push({ role: "assistant", content: content || "[tool call]", tool_calls: normalizedTools });
      } else if (m.senderId === "system" && payload.tool_call_id) {
        if (pendingToolIds.has(payload.tool_call_id)) {
          history.push({ role: "tool", tool_call_id: payload.tool_call_id, content: m.content });
          pendingToolIds.delete(payload.tool_call_id);
        } else {
          // 孤儿工具响应？通常忽略或记录为普通 system info
          // history.push({ role: "system", content: m.content });
        }
      } else {
        // Fix: Prepend senderId (human name) to content so LLM knows WHO is speaking
        let content = m.content || "...";
        if (m.senderId && m.senderId !== "user" && m.senderId !== "human") {
          content = `[${m.senderId}]: ${content}`;
        }
        history.push({ role: "user", content });
      }
    }

    // 2. 循环结束后，如果还有 dangling tools，再次填补
    if (pendingToolIds.size > 0) {
      for (const id of pendingToolIds) {
        history.push({ role: "tool", tool_call_id: id, content: "Error: Tool execution interrupted or not recorded." });
      }
    }

    return history;
  }
}
