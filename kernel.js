import { Perception } from "./perception.js";
import { Decision } from "./decision.js";
import { Action } from "./action.js";
import { ExperienceJournal } from "./experience.js";
import { createLLMClient } from "./llm-client.js";
import { telemetry, runWithTrace } from "./telemetry.js";
import { createProgressEvent, EVENT_TYPES, getProgressHeartbeatMs, normalizeProgressSink } from "./progress-events.js";
import { getRoutingModelConfig } from "./routing-config.js";

/**
 * The Unified Kernel (HuluWa 2.0 - Pragmatic & Robust)
 * 核心设计：拦截空谈承诺，强制执行落地。
 */
export class Kernel {
  constructor(options = {}) {
    this.store = options.store || options.backend;
    this.chatCompletionOverride = options.chatCompletion;
    this.action = options.action || new Action({ cwd: options.workdir });
    this.progressSink = normalizeProgressSink(options.progressSink);
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
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  arguments: { type: "object" }
                },
                required: ["name", "arguments"]
              }
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
    const { taskId, prompt: originalPrompt, sessionId, maxSteps = 30, retrievedContext = [], onStep, maxHistory = 10, progressSink } = options;
    const traceId = `task-${taskId}-sess-${sessionId}-${Date.now()}`;
    const resolvedProgressSink = normalizeProgressSink(progressSink || this.progressSink);

    return new Promise((resolve, reject) => {
      runWithTrace(traceId, async () => {
        let context = {
          taskId,
          sessionId,
          stepCount: 0,
          progressSink: resolvedProgressSink,
          progressHeartbeatMs: getProgressHeartbeatMs(),
          runStartTime: Date.now()
        };
        const span = telemetry.startSpan("Kernel.run");
        try {
          // --- INIT State ---
          const task = await this.store.getTaskById(taskId);
          if (!task) throw new Error(`Task not found: ${taskId}`);

          const decision = new Decision({ maxSteps });
          const perception = new Perception({
            skillsDir: process.env.AGENT_SKILLS_DIR || process.env.TELEGRAM_SKILLS_DIR,
            skillsDirs: process.env.AGENT_SKILLS_DIRS
          });

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
          context = {
            // Config
            taskId, sessionId, originalPrompt, maxSteps, maxHistory,
            agentName: options.agentName,
            onStep,
            progressSink: resolvedProgressSink,
            progressHeartbeatMs: context.progressHeartbeatMs,
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
            isReroute: false,
            // Metrics (for ExperienceJournal)
            journal: new ExperienceJournal(),
            toolsUsed: [],
            toolFailures: 0,
            totalPromptTokens: 0,
            totalCompletionTokens: 0,
            runStartTime: Date.now()
          };

          this._emitProgress(context, EVENT_TYPES.RUN_STARTED, {
            status: "RUNNING",
            maxSteps
          });

          // Inject store context into Action for recall tool
          this.action.setContext({ store: this.store, taskId, branchId: currentBranchId });

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

          // Flush ExperienceJournal
          context.journal.append({
            taskId, prompt: originalPrompt, steps: context.stepCount,
            tools_used: context.toolsUsed, tool_failures: context.toolFailures,
            status: context.finalResult?.status || "DONE",
            latency_total_ms: Date.now() - context.runStartTime,
            prompt_tokens_total: context.totalPromptTokens,
            completion_tokens_total: context.totalCompletionTokens
          }).catch(e => telemetry.warn("[Kernel] Journal flush failed", { error: e.message }));

          span.end({ status: context.finalResult?.status || "DONE" });
          this._emitProgress(context, EVENT_TYPES.RUN_FINISHED, {
            status: context.finalResult?.status || "DONE",
            steps: context.stepCount,
            durationMs: Date.now() - context.runStartTime
          });
          resolve(context.finalResult || { status: "DONE" });
        } catch (error) {
          telemetry.error(`Kernel run failed`, error);
          this._emitProgress(context, EVENT_TYPES.RUN_FAILED, {
            status: "FAILED",
            error: error?.message || String(error),
            steps: context.stepCount || 0,
            durationMs: Date.now() - (context.runStartTime || Date.now())
          });
          span.end({ status: "ERROR", error: error.message });
          reject(error);
        }
      });
    });
  }

  // --- FSM Handlers ---

  async _handlePerceiving(context) {
    const { perception, originalPrompt, task, retrievedContext, sessionId, taskId, isReroute, stepCount } = context;
    
    // Construct prompt with retry hint if needed
    const promptToUse = isReroute 
      ? originalPrompt + " (RETRY: Ensure all relevant tools are included)"
      : originalPrompt;

    if (isReroute) {
      telemetry.info("[Kernel] Rerouting skills based on runtime signal.");
    }

    const heuristicSimpleChat = this._isLikelyChitchat(promptToUse);
    let isSimpleChat = heuristicSimpleChat;
    if (stepCount <= 0 && !heuristicSimpleChat) {
      isSimpleChat = await this._classifySimpleChatWithRouter(promptToUse, heuristicSimpleChat);
    }

    if (isSimpleChat !== heuristicSimpleChat) {
      telemetry.info("[Kernel] Intent router override for simple-chat classification", {
        heuristic: heuristicSimpleChat,
        routed: isSimpleChat
      });
    }

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
    context.isSimpleChatIntent = isSimpleChat;
    context.contextBlock = perception.formatToContext(sensoryData);
    context.state = "THINKING";
    context.isReroute = false; // Reset flag
    
    return context;
  }

  async _handleThinking(context) {
    context.stepCount++;
    const { taskId, currentBranchId, maxHistory, sensoryData, stepCount, turnHint, originalPrompt, agentName, contextBlock } = context;
    this._emitProgress(context, EVENT_TYPES.STEP_STARTED, { step: stepCount });
    
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
    const heuristicSimpleChat = sensoryData.skills.length === 0 && this._isLikelyChitchat(originalPrompt) && stepCount <= 1;
    const isSimpleChat = stepCount <= 1
      ? Boolean(context.isSimpleChatIntent ?? heuristicSimpleChat)
      : heuristicSimpleChat;
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

    // Accumulate metrics for ExperienceJournal
    context.totalPromptTokens += llmResponse.promptTokens || 0;
    context.totalCompletionTokens += llmResponse.completionTokens || 0;

    // Notify Observer
    if (context.onStep) {
      context.onStep({ step: stepCount, thought: turnResult.thinking, message: turnResult.content, tool_calls: turnResult.tool_calls });
    }

    context.state = "DECIDING";
    return context;
  }

  async _handleDeciding(context) {
    const { decision, turnResult, stepCount, sensoryData, stepSpan } = context;
    
    const heuristicSimpleChat = (sensoryData.skills.length === 0 || this._isLikelyChitchat(context.originalPrompt)) && stepCount <= 1;
    const isSimpleChat = stepCount <= 1
      ? Boolean(context.isSimpleChatIntent ?? heuristicSimpleChat)
      : heuristicSimpleChat;
    const explicitTaskIntent = this._isLikelyTaskIntent(context.originalPrompt);
    const advice = decision.analyze(turnResult, { stepCount, availableSkillsCount: sensoryData.skills.length, isSimpleChat, explicitTaskIntent });

    // --- 新增：语义自校正逻辑 (Semantic Guard) ---
    // 如果模型没有调用工具，且不是明确的 DONE，且不是纯聊天，则触发语义校验
    const hasTools = turnResult.tool_calls && turnResult.tool_calls.length > 0;
    const explicitlyDone = turnResult.loopStatus === "DONE" || turnResult.content.includes("搞定啦") || turnResult.content.includes("完成");

    if (!hasTools && !explicitlyDone && !isSimpleChat && advice.nextAction !== "STOP") {
      const audit = await decision.semanticVerify(turnResult, {
        originalPrompt: context.originalPrompt,
        availableSkillsCount: sensoryData.skills.length
      }, this._chat.bind(this));

      if (audit && audit.is_valid === false) {
        telemetry.warn(`[Kernel] 🛡️ 语义校验拦截成功: ${audit.issue}`);
        advice.nextAction = "CONTINUE";
        advice.promptHint = `[逻辑校验失败]: ${audit.suggestion}`;
      }
    }
    // ------------------------------------------

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
      // Reflect on both failure and multi-step success to capture positive/negative lessons
      const isNonTrivial = context.stepCount >= 3;
      if (advice.status === "FAILED" || isNonTrivial || process.env.AGENT_ALWAYS_REFLECT === "true") {
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

    const wakePing = /^(葫芦娃|huluwa|爷爷|grandpa|leetao)\s*(在吗|在么|在不在|吗|么|你好|哈喽)?\s*[?？!！。\.]*$/i;
    if (wakePing.test(normalized)) return true;

    if (normalized.length <= 4) {
      const shortTaskLike = /(查|修|改|写|做|跑|测|搜|log|sql|db|git|代码|脚本|bug|报错|error)/i;
      if (!shortTaskLike.test(normalized)) return true;
    }

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

  async _classifySimpleChatWithRouter(prompt, fallbackValue) {
    const enabled = String(process.env.AGENT_INTENT_ROUTER_ENABLED || "true") !== "false";
    if (!enabled) return fallbackValue;

    const text = String(prompt || "")
      .split("\n")
      .map((line) => String(line || "").trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith("[Context]"))
      .filter((line) => !line.startsWith("[用户信息]"))
      .slice(-3)
      .join(" ")
      .trim();

    if (!text) return true;

    const routingConfig = getRoutingModelConfig();
    if (!routingConfig.model) return fallbackValue;

    const timeoutMs = Math.max(200, Number(process.env.AGENT_INTENT_ROUTER_TIMEOUT_MS || 1200));
    const systemPrompt = `You are an intent classifier. Classify the user message as either:
- chitchat: greeting, social ping, small talk, emotional reaction, acknowledgement
- task: request requiring concrete information retrieval, analysis, editing, execution, or tool usage

Output JSON only:
{"intent":"chitchat|task","confidence":0-1}`;

    let timer = null;
    try {
      const classifyPromise = this._chat(routingConfig, [
        { role: "system", content: systemPrompt },
        { role: "user", content: text }
      ], {
        jsonSchema: {
          type: "object",
          properties: {
            intent: { type: "string", enum: ["chitchat", "task"] },
            confidence: { type: "number" }
          },
          required: ["intent", "confidence"],
          additionalProperties: false
        },
        jsonSchemaName: "intent_router"
      });

      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`intent-router-timeout:${timeoutMs}`)), timeoutMs);
      });

      const response = await Promise.race([classifyPromise, timeoutPromise]);
      if (timer) clearTimeout(timer);

      const content = String(response?.content || "");
      const raw = content.match(/\{[\s\S]*\}/)?.[0] || "{}";
      const parsed = JSON.parse(raw);
      const intent = String(parsed.intent || "").toLowerCase();
      if (intent === "chitchat") return true;
      if (intent === "task") return false;
      return fallbackValue;
    } catch (error) {
      if (timer) clearTimeout(timer);
      telemetry.warn("[Kernel] Intent router classification failed; fallback to heuristic", {
        error: error?.message || String(error)
      });
      return fallbackValue;
    }
  }

  async _handleActing(context) {
    const { turnResult, taskId, currentBranchId, onStep, stepSpan, advice } = context;
    
    // Check Sandbox
    if (process.env.AGENT_ENABLE_SANDBOX === "true" && !context.isWorkspaceReady) {
      await this.action.setupWorkspace(taskId);
      context.isWorkspaceReady = true;
    }

    let needsReroute = false;
    // Read-only tools safe for concurrent execution; add new read-only tools here
    const PARALLEL_SAFE = new Set(["read", "recall", "search_and_load_skill"]);

    const _trackTool = (tc, actionResult) => {
      try {
        const name = tc.function?.name || tc.name;
        if (name && !context.toolsUsed.includes(name)) context.toolsUsed.push(name);
        if (!actionResult.ok) context.toolFailures++;
      } catch (e) {
        telemetry.warn("[Kernel] _trackTool failed", { error: e.message });
      }
    };

    if (turnResult.tool_calls?.length > 0) {
      const totalCalls = turnResult.tool_calls.length;
      let toolCursor = 0;
      // Group consecutive parallel-safe calls for concurrent execution
      const groups = [];
      for (const tc of turnResult.tool_calls) {
        const name = tc.function?.name || tc.name;
        const safe = PARALLEL_SAFE.has(name);
        const lastGroup = groups[groups.length - 1];
        if (lastGroup && lastGroup.parallel && safe) {
          lastGroup.calls.push(tc);
        } else {
          groups.push({ parallel: safe, calls: [tc] });
        }
      }

      for (const group of groups) {
        if (group.parallel && group.calls.length > 1) {
          // Concurrent execution for read-only batch
          telemetry.info(`[Kernel] Parallel executing ${group.calls.length} read-only tools`);
          const indexedCalls = group.calls.map(tc => ({ tc, position: ++toolCursor }));
          const results = await Promise.all(indexedCalls.map(async ({ tc, position }) => {
            const toolSpan = telemetry.startSpan(`Tool.${tc.function?.name || tc.name}`);
            const actionResult = await this._executeActionWithProgress(context, tc, position, totalCalls);
            toolSpan.end({ success: actionResult.ok });
            return { tc, actionResult };
          }));
          // Persist results in original order
          for (const { tc, actionResult } of results) {
            _trackTool(tc, actionResult);
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
        } else {
          // Sequential execution for write/bash or single calls
          for (const tc of group.calls) {
            const position = ++toolCursor;
            const toolSpan = telemetry.startSpan(`Tool.${tc.function?.name || tc.name}`);
            const actionResult = await this._executeActionWithProgress(context, tc, position, totalCalls);
            toolSpan.end({ success: actionResult.ok });
            _trackTool(tc, actionResult);
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
    
    // 2. Build Reflection Prompt (supports both success and failure)
    const isSuccess = finalResult.status === "DONE";
    const reflectionPrompt = `
[SYSTEM: AUTO-REFLECTION]
The task has ended with status: ${finalResult.status}.
Your goal is to analyze the execution history and identify if there are any valuable lessons to be learned.

Criteria for a valid lesson:
1. It must be a specific, actionable rule reusable for future tasks.
2. If the issue was a simple network error or temporary glitch, IGNORE it.
3. If the task was routine with no noteworthy pattern, IGNORE it.
${isSuccess
  ? `4. For successful tasks, capture effective patterns worth replicating (e.g., "Reading config before editing avoids errors", "Using tool X for Y is more efficient").`
  : `4. For failed tasks, identify the root cause and what should be done differently.`}

Output Format:
If you find a lesson, return a JSON object with:
{
  "root_cause": "${isSuccess ? "Why this approach worked well" : "Why it failed"}",
  "what_not_to_do": "${isSuccess ? "The less efficient alternative to avoid" : "The bad practice to avoid"}",
  "suggested_alternatives": "${isSuccess ? "The effective pattern to replicate" : "The best practice to follow"}"
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

      if (lesson && !lesson.ignore && (lesson.what_not_to_do || lesson.suggested_alternatives)) {
        telemetry.info("[Kernel] Lesson identified", lesson);
        
        // Inject Interaction Protocol into final result
        if (!context.finalResult.protocol) context.finalResult.protocol = {};
        const desc = isSuccess
          ? `I identified a useful pattern from this task:\n\n💡 **Insight**: ${lesson.root_cause}\n❌ **Avoid**: ${lesson.what_not_to_do}\n✅ **Prefer**: ${lesson.suggested_alternatives}\n\nShould I record this?`
          : `I identified a potential lesson from this failure:\n\n❌ **Avoid**: ${lesson.what_not_to_do}\n✅ **Prefer**: ${lesson.suggested_alternatives}\n\nShould I record this?`;
        context.finalResult.protocol.interaction = {
          type: "confirmation",
          title: isSuccess ? "💡 Effective Pattern" : "💡 Experience & Lesson",
          description: desc,
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
    return `You are an autonomous execution agent. You MUST respond in JSON format.

## Action Policy (STRICT)
1. **Tool First**: When the task requires any query, read, write, or execution, you MUST issue a tool call via protocol.call_tool in the SAME turn. NEVER just describe what you "plan to do" without calling a tool.
2. **No Empty Promises**: If your "thought" mentions verbs like check, read, query, execute, find, or list, your protocol MUST contain the corresponding call_tool. Say it, do it.
3. **One Step at a Time**: Perform one atomic operation per turn. Wait for tool results before deciding the next step. NEVER assume or fabricate results of steps you haven't executed.
4. **Report Facts Only**: Only report real results returned by tools. NEVER hallucinate or invent output.
5. **Drive to Completion**: Once you have sufficient information to answer the user, set protocol.status to "DONE". Do not ask for unnecessary confirmations.
6. **Recall Before Guessing**: If you need context from earlier steps that you can no longer see, use the "recall" tool to search conversation history. If recall returns nothing useful, ask the user directly in your message — never guess or fabricate missing context.
7. **Stop and Wait**: When you ask the user a question or need their input, you MUST set protocol.status to "DONE" in the SAME turn. Do NOT continue executing after asking — stop and wait for their reply.
8. **Progress Reporting**: For complex multi-step tasks (3+ steps), proactively send progress updates to the user using the messaging tool at key milestones (e.g., after completing a major sub-step, encountering a decision point, or finding important results). Keep updates brief. Do NOT wait until the end to report everything at once.`;
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
      if (!config.endpoint && process.env.AGENT_CHAT_BASE_URL) finalEndpoint = process.env.AGENT_CHAT_BASE_URL;
      if (!config.apiKey && process.env.AGENT_CHAT_API_KEY) finalApiKey = process.env.AGENT_CHAT_API_KEY;
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
    telemetry.debug("[Kernel] Raw LLM Content", { content: resp.content });
    telemetry.debug("[Kernel] Raw LLM ToolCalls", { tool_calls: resp.tool_calls });

    let rawJson = null;

    // 1. Direct JSON.parse (expected path with Structured Outputs)
    try {
      rawJson = JSON.parse(resp.content);
    } catch {
      // 2. Regex fallback for models that wrap JSON in markdown or extra text
      try {
        rawJson = JSON.parse(resp.content.match(/\{[\s\S]*\}/)[0]);
        telemetry.warn("[Kernel] JSON.parse failed, regex fallback succeeded. Check model structured output config.");
      } catch {
        telemetry.error("[Kernel] Failed to parse LLM content as JSON", { content: resp.content?.slice(0, 200) });
        return { taskId, content: resp.content, thinking: "Parse Error", tool_calls: resp.tool_calls || [], loopStatus: "RUNNING" };
      }
    }

    const tool_calls = resp.tool_calls || [];

    // Extract tool calls from protocol.call_tool if native tool_calls are empty
    if (rawJson.protocol?.call_tool && tool_calls.length === 0) {
      const calls = Array.isArray(rawJson.protocol.call_tool)
        ? rawJson.protocol.call_tool
        : [rawJson.protocol.call_tool];
      calls.forEach((tc, i) => {
        if (tc.name) {
          tool_calls.push({
            id: `json_call_${Date.now()}_${i}`,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments || {}) }
          });
        }
      });
    }

    return {
      taskId, content: rawJson.message || "", thinking: rawJson.thought || "", tool_calls,
      loopStatus: rawJson.protocol?.status || "RUNNING", loopProtocol: rawJson.protocol || {}
    };
  }

  async _executeAction(tc) {
    const fnName = tc.function?.name || tc.name;
    const fnArgs = tc.function?.arguments || tc.arguments;

    let args = {};
    try { args = typeof fnArgs === "string" ? JSON.parse(fnArgs) : fnArgs; } catch { }

    if (!this.action[fnName]) return { ok: false, error: `Tool ${fnName} not found.` };

    const TRANSIENT = /timeout|timed out|etimedout|econnrefused|econnreset|econnaborted|epipe|network|socket hang up|503|502|504|429|temporar(?:y|ily)|resource busy|text file busy|permission denied|operation not permitted|eacces|eperm/i;
    const MAX_RETRIES = 1;

    let result = await this.action[fnName](args);
    const errorText = `${result.error || ""}\n${result.stderr || ""}`;
    const alreadyRetried = Boolean(result.retryInfo?.exhausted);
    if (!result.ok && !alreadyRetried && TRANSIENT.test(errorText)) {
      for (let i = 0; i < MAX_RETRIES; i++) {
        telemetry.warn(`[Kernel] Transient error detected, auto-retry ${i + 1}/${MAX_RETRIES}`, { tool: fnName, error: result.error });
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        result = await this.action[fnName](args);
        if (result.ok) break;
      }
    }
    return result;
  }

  async _executeActionWithProgress(context, tc, toolIndex, toolTotal) {
    const toolName = tc.function?.name || tc.name || "unknown_tool";
    const startedAt = Date.now();
    let heartbeatCount = 0;
    const heartbeatMs = Math.max(1000, Number(context.progressHeartbeatMs || getProgressHeartbeatMs()));

    this._emitProgress(context, EVENT_TYPES.TOOL_STARTED, {
      step: context.stepCount,
      toolName,
      toolIndex,
      toolTotal
    });

    const timer = setInterval(() => {
      heartbeatCount++;
      this._emitProgress(context, EVENT_TYPES.TOOL_HEARTBEAT, {
        step: context.stepCount,
        toolName,
        toolIndex,
        toolTotal,
        heartbeatCount,
        durationMs: Date.now() - startedAt
      });
    }, heartbeatMs);

    if (typeof timer.unref === "function") timer.unref();

    try {
      const result = await this._executeAction(tc);
      this._emitProgress(context, EVENT_TYPES.TOOL_FINISHED, {
        step: context.stepCount,
        toolName,
        toolIndex,
        toolTotal,
        ok: Boolean(result.ok),
        durationMs: Date.now() - startedAt,
        retryInfo: result.retryInfo,
        error: result.ok ? undefined : String(result.error || "")
      });
      return result;
    } catch (error) {
      this._emitProgress(context, EVENT_TYPES.TOOL_FINISHED, {
        step: context.stepCount,
        toolName,
        toolIndex,
        toolTotal,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: error?.message || String(error)
      });
      throw error;
    } finally {
      clearInterval(timer);
    }
  }

  _emitProgress(context, type, payload = {}) {
    try {
      const sink = normalizeProgressSink(context?.progressSink || this.progressSink);
      const event = createProgressEvent({ taskId: context?.taskId, sessionId: context?.sessionId }, type, payload);
      const maybePromise = sink.emit(event);
      if (maybePromise?.catch) {
        maybePromise.catch((err) => telemetry.warn("[Kernel] progress sink emit failed", { error: err?.message || String(err) }));
      }
    } catch (error) {
      telemetry.warn("[Kernel] progress emit crashed", { error: error?.message || String(error) });
    }
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
