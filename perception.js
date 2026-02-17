import { listDiscoveredSkills, loadSkillBody } from "./skill-loader.js";
import { telemetry } from "./telemetry.js";
import { getRoutingModelConfig } from "./routing-config.js";
import fs from "node:fs";
import path from "node:path";

/**
 * Perception Layer
 * 负责构建 Agent 的“意识现场”：环境、技能、目标、快照
 */
export class Perception {
  constructor(config = {}) {
    this.config = config;
    this._allSkills = null;
    this._soul = null;
    this._workspace = null;
  }

  _getSkills() {
    if (!this._allSkills) {
      this._allSkills = listDiscoveredSkills({ skillsDir: this.config.skillsDir });
    }
    return this._allSkills;
  }

  _getSoul() {
    if (this._soul === null) {
      try {
        this._soul = fs.existsSync("SOUL.md") ? fs.readFileSync("SOUL.md", "utf-8") : "";
      } catch (e) {
        this._soul = "";
      }
    }
    return this._soul;
  }

  /**
   * 核心感知方法
   */
  async gather(input) {
    const { prompt, task, retrievedContext, sessionId, taskId, isSimpleChat } = input;

    if (isSimpleChat) {
      const state = this.observe(sessionId, taskId, task);
      state.isSimpleChat = true;
      return {
        skills: [],
        state,
        workspace: null,
        lessons: [],
        retrievedContext: []
      };
    }

    // 2. 语义技能路由 (Semantic Routing)
    // 优先使用语义路由，如果配置了 Router Model；否则降级到关键词路由
    let skills = [];
    try {
      skills = await this.routeSkillsSemantic(prompt, input.requestChatCompletion);
    } catch (e) {
      telemetry.warn("[Perception] Semantic routing failed, falling back to keywords.", { error: e?.message || String(e) });
      skills = this.routeSkills(prompt);
    }

    // 3. 环境观测 (New: Workspace Snapshot)
    const state = this.observe(sessionId, taskId, task);
    const workspace = this.observeWorkspace();

    // 4. 教训检索 (New: Lesson Injection)
    let lessons = [];
    try {
      // 4.1 Task-Specific Lessons (Strong Match)
      // We need access to Store here. But Perception doesn't have direct access to Store instance usually.
      // However, Kernel creates Perception. We could pass store to gather?
      // Or we can import getVectorStore()._rawStore (Store instance) if we use the singleton pattern from vector-store.js?
      // The `task` object passed here comes from store.getTaskById(), so we might need to query store.
      
      // Let's assume input.store is available or we use the singleton getVectorStore()._rawStore as a fallback?
      // The cleanest way is to pass store in input.
      // Let's check Kernel.js call site. It passes { prompt, task, retrievedContext, sessionId, taskId, requestChatCompletion }.
      // We should update Kernel to pass `store`.
      
      // For now, let's try to access store if passed, or skip.
      const store = input.store; 
      if (store) {
        lessons = await store.getLessons(taskId);
      }
    } catch (e) {
      telemetry.warn("[Perception] Failed to load lessons", { error: e.message });
    }

    return {
      skills,
      state,
      workspace,
      lessons, // Return lessons
      retrievedContext: prompt.length > 20 ? retrievedContext : []
    };
  }

  /**
   * 关键词路由：按文件夹名匹配技能，零 token 消耗
   * 文件夹名即路由 key，例如 sqlite-db-query → ["sqlite", "db", "query"]
   */
  routeSkills(prompt) {
    const allSkills = this._getSkills();
    if (!allSkills.length) return [];

    const normalizedPrompt = prompt.toLowerCase();
    return allSkills.filter(skill => {
      const keywords = skill.name.split(/[-_]+/).filter(k => k.length > 1);
      return keywords.some(k => normalizedPrompt.includes(k));
    });
  }

  /**
   * 语义路由：利用 LLM 理解意图，选择相关技能
   */
  async routeSkillsSemantic(prompt, chatFunc) {
    const allSkills = this._getSkills();
    if (!allSkills.length) return [];

    // 如果 prompt 很短，直接回退到关键词匹配（省钱）
    if (prompt.length < 5) return this.routeSkills(prompt);

    const availableSkills = allSkills.map(s => `- ${s.name}: ${s.description}`).join("\n");
    const systemPrompt = `You are a Skill Router. Select relevant skills for the user's request from the list below.
Available Skills:
${availableSkills}

User Request: "${prompt}"

Rules:
1. Return a JSON object with a "skills" array containing the exact names of relevant skills.
2. Select at most 3 skills.
3. If no skills are relevant, return an empty array.
4. ONLY return JSON.`;

    const config = getRoutingModelConfig();

    // Use a lightweight call
    const response = await chatFunc(config, [
      { role: "system", content: systemPrompt },
      { role: "user", content: "Select skills." }
    ], {
      jsonSchema: {
        type: "object",
        properties: { skills: { type: "array", items: { type: "string" } } },
        required: ["skills"],
        additionalProperties: false
      }
    });

    try {
      const content = response.content.match(/\{[\s\S]*\}/)?.[0] || "{}";
      const result = JSON.parse(content);
      const selectedNames = new Set(result.skills || []);

      const selected = allSkills.filter(s => selectedNames.has(s.name));
      telemetry.info("[Perception] Semantic Router selected", { skills: selected.map(s => s.name) });

      // 合并关键词匹配的结果（作为兜底），防止 LLM 漏掉显而易见的
      const keywordMatches = this.routeSkills(prompt);
      const merged = [...new Map([...selected, ...keywordMatches].map(s => [s.name, s])).values()];

      return merged;
    } catch (e) {
      telemetry.error("[Perception] Router JSON parse error", e);
      return this.routeSkills(prompt);
    }
  }

  /**
   * 环境快照 (Visualizing the Workspace)
   */
  observeWorkspace() {
    if (this._workspace) return this._workspace;
    const cwd = process.cwd();
    try {
      const items = fs.readdirSync(cwd).filter(item => {
        if (item === "node_modules" || item === ".git") return false;
        if (item.endsWith(".sqlite") || item.endsWith(".db")) return true;
        return !item.startsWith(".");
      });
      this._workspace = {
        cwd,
        items: items.map(name => {
          const stats = fs.statSync(path.join(cwd, name));
          return `${name}${stats.isDirectory() ? "/" : ""}`;
        })
      };
    } catch (e) {
      this._workspace = { cwd, items: [] };
    }
    return this._workspace;
  }

  /**
   * 环境观测 (Status)
   */
  observe(sessionId, taskId, task) {
    return {
      currentTime: new Date().toISOString(),
      sessionId,
      taskId,
      taskTitle: task?.title,
      taskStatus: task?.status,
      skillTree: this._getSkills().map(s => s.name),
      soul: this._getSoul()
    };
  }

  /**
   * 格式化 Context：动态拼装锦囊妙计
   */
  formatToContext(data) {
    const sections = [];
    const { skills, state, workspace, retrievedContext } = data;

    // 0. 灵魂注入
    if (state.soul) {
      sections.push(`[SYSTEM_PERSONA]\n${state.soul}`);
    }

    if (state.isSimpleChat) {
      return sections.join("\n\n---\n\n");
    }

    // 1. 动态技能锦囊 (New: Dynamic Skill Instructions & Examples)
    if (skills && skills.length > 0) {
      const skillDocs = skills.map(s => {
        // 尝试从 SKILL.md 中提取具体的锦囊
        const skillPath = path.join(this.config.skillsDir, s.name, "SKILL.md");
        let extra = "";
        try {
          if (fs.existsSync(skillPath)) {
            // New: Use lazy loading helper
            const content = loadSkillBody(skillPath);
            const instMatch = content.match(/### Instructions([\s\S]*?)(?=###|$)/i);
            const exMatch = content.match(/### Examples([\s\S]*?)(?=###|$)/i);
            if (instMatch) extra += `\n**使用准则**:${instMatch[1].trim()}`;
            if (exMatch) extra += `\n**实战范例**:${exMatch[1].trim()}`;
          }
        } catch (e) { }
        return `### 技能: ${s.name}\n${s.description}${extra}`;
      }).join("\n\n---\n\n");

      sections.push(`[DYNAMIC_SKILLS_MANUAL]\n${skillDocs}`);
    }

    // 2. 任务与环境快照 (保持不变...)
    if (state.taskTitle) {
      sections.push(`[Active Task] ${state.taskTitle} (Status: ${state.taskStatus})`);
    }
    if (workspace) {
      sections.push(`[Workspace Snapshot]\nCWD: ${workspace.cwd}\nFiles: ${workspace.items.join(", ")}`);
    }

    // 3. 环境信息
    sections.push(`[Runtime Environment] Time: ${state.currentTime} | SessionID: ${state.sessionId}`);

    // 4. 教训注入 (New: Lessons Learned)
    const { lessons } = data;
    if (lessons && lessons.length > 0) {
      const lessonText = lessons.map(l => 
        `- ❌ 避免 (Avoid): ${l.what_not_to_do}\n  ✅ 建议 (Prefer): ${l.suggested_alternatives}\n  💡 原因 (Reason): ${l.root_cause}`
      ).join("\n\n");
      sections.push(`[LESSONS_LEARNED]\n${lessonText}`);
    }

    // 5. RAG 检索
    if (retrievedContext && retrievedContext.length > 0) {
      const ragBlock = this._formatRetrievedContext(retrievedContext);
      if (ragBlock) sections.push(ragBlock);
    }

    return sections.join("\n\n---\n\n");
  }

  _formatRetrievedContext(retrievedContext, maxItems = 3) {
    if (!Array.isArray(retrievedContext) || !retrievedContext.length) return "";
    const items = retrievedContext.slice(0, maxItems);
    telemetry.debug("[RAG] Injected items", {
      count: items.length,
      items: items.map(r => `${r.taskId}: ${String(r.content || "").slice(0, 60)}`)
    });
    const lines = [
      "[Retrieved Context from Long-Term Memory]",
      "⚠️ Note: The following are historical fragments retrieved by semantic similarity. They may be outdated or from a different context.",
      "⚠️ Instruction: Use this information only for background knowledge. If it conflicts with the current conversation history, IGNORE it.",
      "---"
    ];
    items.forEach((row, index) => {
      const content = String(row?.content || "").trim().slice(0, 400);
      const score = row.score ? ` (Similarity: ${(row.score * 100).toFixed(0)}%)` : "";
      lines.push(`${index + 1}. [${row?.senderId}]${score}: ${content}`);
    });
    lines.push("---");
    return lines.join("\n");
  }
}
