import { telemetry } from "./telemetry.js";

/**
 * Decision Layer
 * 职责：监军。防止模型空谈、偷懒或提前跑路。
 */
export class Decision {
  constructor(options = {}) {
    this.maxSteps = options.maxSteps || 20;
    this.actionHistory = [];
    this.consecutiveInterceptions = 0;
  }

  /**
   * 语义校验：利用轻量级模型检查思考逻辑与实际动作是否对齐
   */
  async semanticVerify(turnResult, state, chatFunc) {
    const { content, thinking, tool_calls } = turnResult;
    const { originalPrompt, availableSkillsCount } = state;

    // 如果是纯聊天模式或没有技能，跳过语义检查
    if (availableSkillsCount === 0 || !originalPrompt) return { is_valid: true };

    const hasTools = tool_calls && tool_calls.length > 0;
    
    const criticModel = process.env.AGENT_CRITIC_MODEL || process.env.AGENT_CHAT_MODEL || "gemini-1.5-flash";
    const criticConfig = { model: criticModel };
    if (process.env.AGENT_CRITIC_BASE_URL) criticConfig.endpoint = process.env.AGENT_CRITIC_BASE_URL;
    if (process.env.AGENT_CRITIC_API_KEY) criticConfig.apiKey = process.env.AGENT_CRITIC_API_KEY;
    const systemPrompt = `你是一个动作审计员。你的任务是检查执行者是否在“空谈”。
检查准则：
1. 如果执行者在“思考”或“回复”中承诺要执行具体操作（如：查、读、写、跑、找、ls、cat等），但 tool_calls 为空，则视为“空谈”。
2. 如果执行者认为任务已完成，但实际目标未达成，则视为“过早结束”。
3. 仅仅是总结已有的信息，不属于空谈。

请返回 JSON 格式：
{
  "is_valid": boolean,
  "issue": "如果无效，请描述问题",
  "suggestion": "给执行者的改进建议（如：请调用 read 工具读取文件内容）"
}`;

    const userContent = `原始目标: "${originalPrompt}"
执行者思考: "${thinking}"
执行者回复: "${content}"
执行者动作: ${JSON.stringify(tool_calls || [])}`;

    try {
      const resp = await chatFunc(criticConfig, [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent }
      ], { jsonMode: true });

      const audit = JSON.parse(resp.content.match(/\{[\s\S]*\}/)[0]);
      return audit;
    } catch (e) {
      return { is_valid: true, error: "Audit failed, bypassing" };
    }
  }

  analyze(turnResult, state) {
    const { tool_calls, content, thinking, loopStatus } = turnResult;
    const { stepCount, availableSkillsCount, isSimpleChat, explicitTaskIntent } = state;

    const hasTools = tool_calls && tool_calls.length > 0;
    const combinedText = (content + thinking).toLowerCase();

    // Reset interception counter if agent takes action or finishes
    if (hasTools || loopStatus === "DONE") {
      this.consecutiveInterceptions = 0;
    }

    // 1. 拦截空谈
    // Old: Regex-based interception was too brittle for Chinese (false positives on report verbs).
    // Now relying on System Prompt to enforce "Action First" behavior.
    /* 
    const actionRegex = /cat|ls|read|write|bash|execute|run|query|sqlite|查|读|写|执行|找|数一数|确认/;
    // Fix: Whitelist result reporting keywords (don't intercept if reporting results)
    const allowRegex = /结果|总共|一共|统计|找到|完成|搞定/;

    const promisedAction = actionRegex.test(combinedText) && !allowRegex.test(combinedText);

    // Fix: 如果 loopStatus 已经是 SUCCESS/DONE，说明任务已完成，不要再拦截“空谈”
    const explicitSuccess = loopStatus === "SUCCESS" || loopStatus === "DONE";
    if (promisedAction && !hasTools && !explicitSuccess) {
      if (stepCount >= 4) {
        return { nextAction: "STOP", status: "FAILED", message: "爷爷生气了！你光动嘴不动手，本领都丢了吗？" };
      }
      return {
        nextAction: "CONTINUE",
        promptHint: "警告：你承诺了要查/执行，但没祭出法宝（tool_calls）！爷爷要看实际反馈，请立即执行命令，不要脑补！",
        status: "RUNNING"
      };
    }
    */

    // 2. 拦截“首轮跑路” (最重要的修复点)
    // 如果是第一步，既没工具调用，也没说“搞定啦”，且不是纯闲聊模式（有可用技能），才强制重试
    const explicitlyDone = loopStatus === "DONE" || combinedText.includes("搞定啦") || combinedText.includes("完成");
    const isChatMode = isSimpleChat === true || availableSkillsCount === 0;

    if (stepCount === 1 && !hasTools && !explicitlyDone && !isChatMode && explicitTaskIntent === true) {
      // 如果连续拦截超过 1 次，说明 Agent 确实不想动，放行避免死循环
      if (this.consecutiveInterceptions >= 1) {
        telemetry.warn("[Decision] 第一步拦截多次失败，强制放行以避免死循环。");
        return { nextAction: "STOP", status: "DONE" };
      }

      this.consecutiveInterceptions++;
      telemetry.info("[Decision] 第一步拦截：既无动作也未完成，强制重试。");
      return {
        nextAction: "CONTINUE",
        promptHint: "爷爷觉得你还没开始干活呢，怎么就停了？请祭出法宝开始行动！",
        status: "RUNNING"
      };
    }

    // 3. 正常成功判定
    if (explicitlyDone) {
      return { nextAction: "STOP", status: "DONE", taskUpdates: { status: "done" } };
    }

    // 4. 物理上限
    if (stepCount >= this.maxSteps) return { nextAction: "STOP", status: "PAUSED_LIMIT" };

    // 5. 有动作就继续
    if (hasTools) return { nextAction: "CONTINUE", status: "RUNNING" };

    // 6. 默认停止
    return { nextAction: "STOP", status: "DONE" };
  }

  _getFingerprint(tool_calls) {
    if (!tool_calls || tool_calls.length === 0) return "NO_TOOLS";
    return tool_calls.map(tc => `${tc.function?.name}:${tc.function?.arguments}`).join("|");
  }
}
