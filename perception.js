import { listDiscoveredSkills, loadSkillBody } from "./skill-loader.js";
import { telemetry } from "./telemetry.js";
import { getRoutingModelConfig } from "./routing-config.js";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";

const SOUL_CACHE = { data: null, ts: 0 };
const SKILL_DOCS_CACHE = new Map(); // path -> { content: string, ts: number }
const CACHE_TTL = 30000; // 30 seconds

/**
 * Perception Layer
 * 负责构建 Agent 的“意识现场”：环境、技能、目标、快照
 */
export class Perception {
  constructor(config = {}) {
    this.config = config;
    this._allSkills = null;
    this._skillsLoadedAt = 0;
    this.skillRefreshMs = this._toSafeInt(
      config.skillRefreshMs ?? process.env.AGENT_SKILLS_REFRESH_MS ?? process.env.TELEGRAM_SKILLS_REFRESH_MS,
      3000
    );
    this._soul = null;
    this._workspace = null;
  }

  _getSkills() {
    const now = Date.now();
    const expired = now - this._skillsLoadedAt >= this.skillRefreshMs;
    if (!this._allSkills || expired) {
      this._allSkills = listDiscoveredSkills({
        skillsDir: this.config.skillsDir,
        skillsDirs: this.config.skillsDirs
      });
      this._skillsLoadedAt = now;
    }
    return this._allSkills;
  }

  _toSafeInt(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  }

  _getSoul() {
    const now = Date.now();
    if (SOUL_CACHE.data !== null && (now - SOUL_CACHE.ts < CACHE_TTL)) {
      return SOUL_CACHE.data;
    }

    try {
      const soul = fs.existsSync("SOUL.md") ? fs.readFileSync("SOUL.md", "utf-8") : "";
      SOUL_CACHE.data = soul;
      SOUL_CACHE.ts = now;
      return soul;
    } catch (e) {
      return "";
    }
  }

  /**
   * 核心感知方法
   */
  async gather(input) {
    const span = telemetry.startSpan("Perception.gather");
    try {
      const { prompt, task, retrievedContext, sessionId, taskId, isSimpleChat } = input;

      // Predictive Warmup Signal (Fire and forget)
      this._predictiveWarmup(prompt);

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
        skills = await this.routeSkillsSemantic(prompt, input.requestChatCompletion, input.routerTimeoutMs);
      } catch (e) {
        telemetry.warn("[Perception] Semantic routing failed, falling back to keywords.", { error: e?.message || String(e) });
        skills = this.routeSkills(prompt);
      }

      const state = this.observe(sessionId, taskId, task);
      const workspace = this.observeWorkspace();

      // 4. 教训与经验检索 (Lesson & Experience Injection)
      let lessons = [];
      let globalExperiences = [];
      try {
        const store = input.store;
        if (store) {
          // 4.1 Task-Specific Lessons
          lessons = await store.getLessons(taskId);

          // 4.2 Global Experiences (Deep Retrieval)
          if (input.promptEmbedding) {
            globalExperiences = await store.searchGlobalLessons(input.promptEmbedding, 3);
          }
        }
      } catch (e) {
        telemetry.warn("[Perception] Failed to load experiences", { error: e.message });
      }

      return {
        skills,
        state,
        workspace,
        lessons,
        globalExperiences,
        retrievedContext: prompt.length > 20 ? retrievedContext : []
      };
    } finally {
      span.end();
    }
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

  _predictiveWarmup(prompt) {
    try {
      const SOCKET_PATH = "/tmp/kuafu-executor.sock";
      const text = String(prompt || "").toLowerCase();
      let executor = "codex_cli"; // default
      if (text.includes("#qwen") || text.includes("/qwen") || text.includes("qwen")) executor = "qwen_cli";
      else if (text.includes("#iflow") || text.includes("/iflow") || text.includes("iflow")) executor = "iflow_cli";

      const socket = net.createConnection(SOCKET_PATH);
      socket.on("error", () => { }); // siliently fail if daemon not running
      socket.write(JSON.stringify({ type: "warmup", executor }) + "\n");
      socket.end();
    } catch (e) {
      // ignore
    }
  }

  /**
   * 语义路由：利用 LLM 理解意图，选择相关技能
   */
  async routeSkillsSemantic(prompt, chatFunc, routerTimeoutMs) {
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
    const resolvedConfig = Number.isFinite(Number(routerTimeoutMs))
      ? { ...config, timeoutMs: Number(routerTimeoutMs) }
      : config;

    const response = await chatFunc(resolvedConfig, [
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
   * 提取动态任务信号关键词 (提取所有可用技能的名字和前几个关键词作为信号)
   */
  getTaskSignals() {
    const skills = this._getSkills();
    const signals = new Set(["npm", "git", "docker", "run", "http", "sql", "db", "log", "error", "bug"]);

    for (const s of skills) {
      if (s.name) {
        // 将技能名拆解（如 sqlite-db-query -> sqlite, db, query）
        s.name.split(/[-_]+/).forEach(k => { if (k.length >= 3) signals.add(k.toLowerCase()); });
      }
      if (s.description) {
        // 从描述中提取前几个英文单词或数字作为信号
        const words = s.description.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
        words.slice(0, 15).forEach(w => signals.add(w));
      }
    }
    return Array.from(signals);
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
      const now = Date.now();
      const skillDocs = skills.map(s => {
        const skillPath = s.path;

        // Cache Check
        const cached = SKILL_DOCS_CACHE.get(skillPath);
        if (cached && (now - cached.ts < CACHE_TTL)) {
          return cached.content;
        }

        let extra = "";
        try {
          if (fs.existsSync(skillPath)) {
            const content = loadSkillBody(skillPath);
            const instMatch = content.match(/### Instructions([\s\S]*?)(?=###|$)/i);
            const exMatch = content.match(/### Examples([\s\S]*?)(?=###|$)/i);
            if (instMatch) extra += `\n**使用准则**:${instMatch[1].trim()}`;
            if (exMatch) extra += `\n**实战范例**:${exMatch[1].trim()}`;
          }
        } catch (e) { }

        const formatted = `### 技能: ${s.name}\n${s.description}${extra}`;
        SKILL_DOCS_CACHE.set(skillPath, { content: formatted, ts: now });
        return formatted;
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

    // 6. 全局经验与确定性轨迹 (Global Experience & Anchors)
    const { globalExperiences } = data;
    if (globalExperiences && globalExperiences.length > 0) {
      const experienceText = globalExperiences.map(exp => {
        let block = `### 过去经验: ${exp.prompt}\n- 💡 洞察: ${exp.root_cause}\n- ✅ 推荐: ${exp.suggested_alternatives}`;
        if (exp.trajectory) {
          try {
            const traj = JSON.parse(exp.trajectory);
            if (Array.isArray(traj) && traj.length > 0) {
              const formattedTraj = traj.map(step => {
                if (typeof step === 'string') return step;
                if (step && typeof step === 'object' && step.name) {
                  // If bash, try to extract command name for brevity
                  if (step.name === 'bash' && step.args) {
                    try {
                      const args = JSON.parse(step.args);
                      const cmd = String(args.command || "").trim().split(/\s+/)[0];
                      return cmd ? `bash(${cmd})` : 'bash';
                    } catch (e) { return 'bash'; }
                  }
                  return step.name;
                }
                return String(step);
              }).join(" -> ");
              block += `\n- 🚀 成功路径 (Trajectory): ${formattedTraj}`;
            }
          } catch (e) { }
        }
        return block;
      }).join("\n\n");
      sections.push(`[GLOBAL_EXPERIENCE_RECALL]\n${experienceText}`);
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
