import fs from "node:fs";
import path from "node:path";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { listDiscoveredSkills, loadSkillBody } from "./skill-loader.js";

const execAsync = promisify(execCb);

/**
 * Action Layer (HuluWa 2.0 - Clean & Generic)
 * 职责：提供最基础的物理操作能力，不包含业务逻辑。
 */
export class Action {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || process.cwd();
    this.sandboxBase = path.join(this.projectRoot, ".huluwa/sandboxes");
    this.cwd = this.projectRoot;
    this.sandboxPath = null;
    this.timeoutMs = options.timeoutMs || 120000;
    this.bashRetryMax = this._toSafeInt(options.bashRetryMax ?? process.env.TELEGRAM_BASH_RETRY_MAX, 1);
    this.bashRetryBaseDelayMs = this._toSafeInt(options.bashRetryBaseDelayMs ?? process.env.TELEGRAM_BASH_RETRY_BASE_DELAY_MS, 800);
    this.bashRetryMaxDelayMs = this._toSafeInt(options.bashRetryMaxDelayMs ?? process.env.TELEGRAM_BASH_RETRY_MAX_DELAY_MS, 4000);
  }

  getSpecs() {
    return [
      {
        type: "function",
        function: {
          name: "bash",
          description: "在当前工作目录下执行终端命令。",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "要执行的完整 shell 命令。" }
            },
            required: ["command"],
            additionalProperties: false
          }
        }
      },
      {
        type: "function",
        function: {
          name: "read",
          description: "读取文件内容。",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "文件相对路径。" }
            },
            required: ["path"],
            additionalProperties: false
          }
        }
      },
      {
        type: "function",
        function: {
          name: "recall",
          description: "Recall earlier conversation history for the current task. Use when you need context from previous steps that are no longer visible, such as earlier tool results, user instructions, or intermediate findings.",
          parameters: {
            type: "object",
            properties: {
              keyword: { type: "string", description: "Optional keyword to filter messages (e.g., 'sqlite', 'error'). Leave empty to get the most recent older messages." },
              limit: { type: "number", description: "Number of messages to retrieve (default: 10, max: 30)." }
            },
            additionalProperties: false
          }
        }
      },
      {
        type: "function",
        function: {
          name: "search_and_load_skill",
          description: "搜索并加载一个技能的完整文档。当你在执行中发现需要某个工具或领域知识但当前上下文中没有时，调用此工具按关键词搜索可用技能并加载其详细说明。",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "搜索关键词，如 'sqlite'、'git'、'docker'。" }
            },
            required: ["query"],
            additionalProperties: false
          }
        }
      },
      {
        type: "function",
        function: {
          name: "write",
          description: "在沙盒内创建或覆盖文件。",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "文件路径。" },
              content: { type: "string", description: "文件内容。" }
            },
            required: ["path", "content"],
            additionalProperties: false
          }
        }
      }
    ];
  }

  async setupWorkspace(taskId) {
    this.sandboxPath = path.join(this.sandboxBase, taskId.slice(0, 8));
    try {
      if (!fs.existsSync(this.sandboxPath)) fs.mkdirSync(this.sandboxPath, { recursive: true });
      this.cwd = this.sandboxPath;
      return { ok: true, sandbox: this.sandboxPath };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  async invokeTool(name, args = {}) {
    const toolName = String(name || "").trim();
    if (!toolName) return { ok: false, error: "Tool name is required." };

    if (this._isBuiltinTool(toolName)) {
      if (typeof this[toolName] !== "function") {
        return { ok: false, error: `Builtin tool ${toolName} is not callable.` };
      }
      return this[toolName](args);
    }

    return this._invokeSkillTool(toolName, args);
  }

  _isBuiltinTool(name) {
    return this.getSpecs().some((spec) => spec?.function?.name === name);
  }

  _selectSkillCandidate(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    const preferNonBuiltin = candidates.find((skill) => !skill?.isBuiltin);
    return preferNonBuiltin || candidates[0];
  }

  _assertSkillEntryPath(skillRoot, entryRel) {
    if (!entryRel) throw new Error("Skill entry is empty.");
    if (path.isAbsolute(entryRel)) {
      throw new Error(`Skill entry must be relative, got absolute path: ${entryRel}`);
    }
    const resolved = path.resolve(skillRoot, entryRel);
    const normalizedRoot = path.resolve(skillRoot);
    if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
      throw new Error(`Skill entry escapes skill directory: ${entryRel}`);
    }
    return resolved;
  }

  _shellQuote(value) {
    const s = String(value ?? "");
    return `'${s.replace(/'/g, `'\"'\"'`)}'`;
  }

  _buildArgvPairs(args) {
    const pairs = [];
    const obj = args && typeof args === "object" ? args : {};
    for (const [rawKey, rawValue] of Object.entries(obj)) {
      const key = String(rawKey || "").trim();
      if (!key) continue;
      const cliKey = `--${key.replace(/_/g, "-")}`;
      if (typeof rawValue === "boolean") {
        if (rawValue) pairs.push(cliKey);
        continue;
      }
      if (rawValue === null || rawValue === undefined) continue;
      const value = typeof rawValue === "object" ? JSON.stringify(rawValue) : String(rawValue);
      pairs.push(`${cliKey} ${this._shellQuote(value)}`);
    }
    return pairs.join(" ");
  }

  _buildSkillCommand(entryPath, args, argsMode) {
    const quotedEntry = this._shellQuote(entryPath);
    const mode = String(argsMode || "json").toLowerCase();
    if (mode === "json") {
      const params = JSON.stringify(args && typeof args === "object" ? args : {});
      return `bash ${quotedEntry} --params ${this._shellQuote(params)}`;
    }
    if (mode === "argv") {
      const argv = this._buildArgvPairs(args);
      return argv ? `bash ${quotedEntry} ${argv}` : `bash ${quotedEntry}`;
    }
    if (mode === "raw") {
      const rawCommand = String(args?.command || "").trim();
      if (!rawCommand) {
        throw new Error("raw args mode requires arguments.command.");
      }
      return `bash ${quotedEntry} ${rawCommand}`;
    }
    throw new Error(`Unsupported skill args mode: ${mode}`);
  }

  async _invokeSkillTool(toolName, args = {}) {
    const allSkills = listDiscoveredSkills({
      skillsDir: process.env.AGENT_SKILLS_DIR || process.env.TELEGRAM_SKILLS_DIR,
      skillsDirs: process.env.AGENT_SKILLS_DIRS
    });
    const lowerName = toolName.toLowerCase();
    const matches = allSkills.filter((skill) => String(skill.name || "").toLowerCase() === lowerName);
    if (matches.length === 0) {
      return { ok: false, error: `Tool ${toolName} not found.` };
    }

    const skill = this._selectSkillCandidate(matches);
    const skillRoot = path.dirname(skill.path);
    const entryRel = String(skill.entry || "run.sh").trim();
    let entryPath = "";
    try {
      entryPath = this._assertSkillEntryPath(skillRoot, entryRel);
    } catch (error) {
      return { ok: false, error: `[skill:${skill.name}] ${error.message}` };
    }

    if (!fs.existsSync(entryPath)) {
      return {
        ok: false,
        error: `[skill:${skill.name}] entry not found: ${entryPath}. Add frontmatter entry or create run.sh.`
      };
    }

    let command = "";
    try {
      command = this._buildSkillCommand(entryPath, args, skill.argsMode || "json");
    } catch (error) {
      return { ok: false, error: `[skill:${skill.name}] ${error.message}` };
    }

    const result = await this.bash({ command });
    return {
      ...result,
      skill: {
        name: skill.name,
        path: skill.path,
        entry: entryRel,
        argsMode: skill.argsMode || "json"
      }
    };
  }

  async bash(args) {
    const OUTPUT_LIMIT = 3000;
    const maxRetries = this.bashRetryMax;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const { stdout, stderr } = await execAsync(args.command, { cwd: this.cwd, timeout: this.timeoutMs });
        return {
          ok: true,
          stdout: this._smartTruncate(stdout.trim(), OUTPUT_LIMIT),
          stderr: stderr.trim(),
          retryInfo: { retried: attempt, attempts: attempt + 1, exhausted: false }
        };
      } catch (error) {
        const errorText = `${error?.message || ""}\n${error?.stderr || ""}`;
        const retryable = this._isRetryableBashError(errorText);
        const exhausted = !retryable || attempt >= maxRetries;

        if (exhausted) {
          return {
            ok: false,
            error: this._smartTruncate(error.message, OUTPUT_LIMIT),
            stderr: error.stderr,
            retryInfo: { retried: attempt, attempts: attempt + 1, retryable, exhausted: true }
          };
        }

        await this._sleep(this._retryDelayMs(attempt + 1));
      }
    }

    return { ok: false, error: "Unexpected retry loop state in bash tool." };
  }

  _smartTruncate(text, limit) {
    if (!text || text.length <= limit) return text;
    const headSize = Math.floor(limit * 0.6);
    const tailSize = limit - headSize;
    return `${text.slice(0, headSize)}\n\n[... truncated ${text.length - headSize - tailSize} chars, total ${text.length} chars. Use | head, | tail, or | grep to refine ...]\n\n${text.slice(-tailSize)}`;
  }

  _isRetryableBashError(errorText) {
    const RETRYABLE_PATTERN = /timeout|timed out|etimedout|econnreset|econnrefused|econnaborted|enotfound|eai_again|enetunreach|ehostunreach|epipe|429|502|503|504|socket hang up|network|temporar(?:y|ily)|resource busy|text file busy|permission denied|operation not permitted|eacces|eperm/i;
    return RETRYABLE_PATTERN.test(String(errorText || ""));
  }

  _retryDelayMs(attempt) {
    const exponential = Math.min(this.bashRetryBaseDelayMs * (2 ** Math.max(attempt - 1, 0)), this.bashRetryMaxDelayMs);
    const jitter = Math.floor(Math.random() * 200);
    return exponential + jitter;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  _toSafeInt(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  }

  async read(args) {
    let target = path.resolve(this.cwd, args.path);
    if (!fs.existsSync(target)) target = path.resolve(this.projectRoot, args.path);
    try {
      const content = fs.readFileSync(target, "utf-8");
      return { ok: true, content: content.slice(0, 5000) };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  setContext({ store, taskId, branchId }) {
    this._store = store;
    this._taskId = taskId;
    this._branchId = branchId;
  }

  async recall(args) {
    if (!this._store || !this._taskId) return { ok: false, error: "No task context available." };

    const limit = Math.min(Math.max(args.limit || 10, 1), 30);
    const messages = await this._store.getActiveMessages(this._taskId, this._branchId, limit + 20);

    let results = messages.map(m => ({
      sender: m.senderId,
      content: String(m.content || "").slice(0, 500),
      time: new Date(m.createdAt).toISOString()
    }));

    if (args.keyword) {
      const kw = args.keyword.toLowerCase();
      results = results.filter(m => m.content.toLowerCase().includes(kw));
    }

    return { ok: true, count: results.length, messages: results.slice(-limit) };
  }

  async search_and_load_skill(args) {
    const query = String(args.query || "").toLowerCase();
    if (!query) return { ok: false, error: "query is required." };

    const allSkills = listDiscoveredSkills({
      skillsDir: process.env.AGENT_SKILLS_DIR || process.env.TELEGRAM_SKILLS_DIR,
      skillsDirs: process.env.AGENT_SKILLS_DIRS
    });
    if (!allSkills.length) return { ok: false, error: "No skills available." };

    // Match by name keywords or description
    const matches = allSkills.filter(s => {
      const nameTokens = s.name.toLowerCase().split(/[-_]+/);
      const desc = (s.description || "").toLowerCase();
      return nameTokens.some(t => t.includes(query) || query.includes(t)) || desc.includes(query);
    });

    if (matches.length === 0) {
      return { ok: false, available: allSkills.map(s => s.name), error: `No skill matched "${args.query}". See 'available' for all skills.` };
    }

    // Load the best match's full body
    const skill = matches[0];
    const body = loadSkillBody(skill.path);
    return { ok: true, name: skill.name, description: skill.description, instructions: body.slice(0, 4000) };
  }

  async write(args) {
    const target = path.resolve(this.cwd, args.path);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, args.content, "utf-8");
      return { ok: true, bytes: args.content.length };
    } catch (e) { return { ok: false, error: e.message }; }
  }
}
