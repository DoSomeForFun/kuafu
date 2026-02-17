import fs from "node:fs/promises";
import path from "node:path";
import { telemetry } from "./telemetry.js";

/**
 * Experience Journal (ToastPlan 2.0 - Evolution Layer 1)
 * 
 * 记录每次任务的执行统计，为后续的批量反思提供原始数据。
 * 纯数据记录，零 LLM 调用。
 */
export class ExperienceJournal {
  constructor(options = {}) {
    // 默认日志路径
    this.logFile = options.logFile || path.resolve(process.cwd(), ".agent-learning-log.jsonl");
  }

  /**
   * 追加一条经验日志
   * @param {Object} entry
   */
  async append(entry) {
    try {
      const logEntry = {
        taskId: entry.taskId,
        timestamp: Date.now(),
        steps: entry.steps,
        tools_used: entry.tools_used || [],
        tool_failures: entry.tool_failures || 0,
        status: entry.status,
        latency_total_ms: entry.latency_total_ms,
        prompt_tokens_total: entry.prompt_tokens_total || 0,
        completion_tokens_total: entry.completion_tokens_total || 0,
        prompt_summary: this._summarizePrompt(entry.prompt)
      };

      const line = JSON.stringify(logEntry) + "\n";
      await fs.appendFile(this.logFile, line, "utf8");
    } catch (error) {
      telemetry.error("[ExperienceJournal] Failed to write log", error);
      // 日志记录失败不应阻断主流程，静默失败
    }
  }

  /**
   * 简单截断 Prompt 作为摘要
   */
  _summarizePrompt(prompt) {
    if (!prompt) return "";
    return prompt.length > 100 ? prompt.slice(0, 100) + "..." : prompt;
  }
}
