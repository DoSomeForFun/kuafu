// src/store.ts
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
var Store = class {
  db;
  constructor(dbPath = "data/agent-tasks.sqlite") {
    if (dbPath !== ":memory:") {
      const dir = path.dirname(dbPath);
      if (dir && dir !== "." && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this._initSchema();
  }
  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT,
        date TEXT,
        notes TEXT,
        status TEXT DEFAULT 'todo',
        current_branch_id TEXT,
        updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        branch_id TEXT,
        execution_id TEXT,
        sender_id TEXT,
        content TEXT,
        payload TEXT,
        is_archived INTEGER DEFAULT 0,
        created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS lessons (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        branch_id TEXT,
        root_cause TEXT,
        what_not_to_do TEXT,
        suggested_alternatives TEXT,
        trajectory TEXT,
        created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS llm_executions (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        agent_name TEXT,
        prompt TEXT,
        thinking TEXT,
        status TEXT,
        usage_prompt_tokens INTEGER,
        usage_completion_tokens INTEGER,
        latency_ms INTEGER,
        created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        chat_id TEXT,
        sender_id TEXT,
        task_id TEXT,
        session_id TEXT,
        source_message_id TEXT,
        panel_chat_id TEXT,
        panel_message_id TEXT,
        title TEXT,
        prompt TEXT,
        status TEXT,
        stop_reason TEXT,
        executor TEXT,
        route_reason TEXT,
        error TEXT,
        output_preview TEXT,
        started_at INTEGER,
        finished_at INTEGER,
        archived_at INTEGER,
        updated_at INTEGER,
        created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS run_events (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        event_type TEXT,
        summary TEXT,
        payload TEXT,
        created_at INTEGER
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id);
      CREATE INDEX IF NOT EXISTS idx_messages_branch ON messages(branch_id);
      CREATE INDEX IF NOT EXISTS idx_lessons_task ON lessons(task_id);
      CREATE INDEX IF NOT EXISTS idx_llm_executions_task ON llm_executions(task_id);
      CREATE INDEX IF NOT EXISTS idx_runs_chat ON runs(chat_id);
      CREATE INDEX IF NOT EXISTS idx_runs_sender ON runs(sender_id);
    `);
  }
  /**
   * Create a new task
   */
  async createTask(task) {
    const stmt = this.db.prepare(`
      INSERT INTO tasks (id, title, date, status, notes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      task.id,
      task.title,
      task.date,
      task.status || "todo",
      task.notes || null,
      Date.now()
    );
  }
  /**
   * Get task by ID
   */
  async getTaskById(taskId) {
    const stmt = this.db.prepare("SELECT * FROM tasks WHERE id = ?");
    const row = stmt.get(taskId);
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      date: row.date,
      status: row.status,
      notes: row.notes,
      current_branch_id: row.current_branch_id,
      updated_at: row.updated_at
    };
  }
  /**
   * Update task status
   */
  async updateTaskStatus(taskId, status) {
    const stmt = this.db.prepare(`
      UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?
    `);
    stmt.run(status, Date.now(), taskId);
  }
  /**
   * Save task message
   */
  async saveTaskMessage(message) {
    const stmt = this.db.prepare(`
      INSERT INTO messages (id, task_id, branch_id, execution_id, sender_id, content, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      message.id,
      message.task_id,
      message.branch_id,
      message.execution_id || null,
      message.sender_id,
      message.content,
      message.payload ? JSON.stringify(message.payload) : null,
      Date.now()
    );
  }
  /**
   * Get messages for task
   */
  async getMessagesForTask(taskId, branchId) {
    let sql = "SELECT * FROM messages WHERE task_id = ? AND is_archived = 0";
    const params = [taskId];
    if (branchId) {
      sql += " AND branch_id = ?";
      params.push(branchId);
    }
    sql += " ORDER BY created_at ASC";
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params);
    return rows.map((row) => ({
      id: row.id,
      task_id: row.task_id,
      branch_id: row.branch_id,
      execution_id: row.execution_id,
      sender_id: row.sender_id,
      content: row.content,
      payload: row.payload,
      is_archived: row.is_archived,
      created_at: row.created_at
    }));
  }
  /**
   * Save lesson learned
   */
  async saveLesson(lesson) {
    const stmt = this.db.prepare(`
      INSERT INTO lessons (id, task_id, branch_id, root_cause, what_not_to_do, suggested_alternatives, trajectory, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      lesson.id,
      lesson.task_id,
      lesson.branch_id,
      lesson.root_cause,
      lesson.what_not_to_do,
      lesson.suggested_alternatives || null,
      lesson.trajectory || null,
      Date.now()
    );
  }
  /**
   * Save LLM execution record
   */
  async saveLLMExecution(execution) {
    const stmt = this.db.prepare(`
      INSERT INTO llm_executions (id, task_id, agent_name, prompt, thinking, status, usage_prompt_tokens, usage_completion_tokens, latency_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      execution.id,
      execution.task_id,
      execution.agent_name || null,
      execution.prompt,
      execution.thinking || null,
      execution.status,
      execution.usage_prompt_tokens || null,
      execution.usage_completion_tokens || null,
      execution.latency_ms || null,
      Date.now()
    );
  }
  /**
   * Close the database connection
   */
  close() {
    this.db.close();
  }
};

// src/telemetry.ts
import pino from "pino";
var SimpleSpan = class {
  name;
  startTime;
  endTime;
  attributes = {};
  constructor(name) {
    this.name = name;
    this.startTime = Date.now();
  }
  end(attributes) {
    this.endTime = Date.now();
    if (attributes) {
      this.attributes = { ...this.attributes, ...attributes };
    }
  }
};
var logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "yyyy-mm-dd HH:MM:ss"
    }
  }
});
var TelemetryImpl = class {
  info(message, data) {
    logger.info({ traceId: "no-trace", ...data }, message);
  }
  warn(message, data) {
    logger.warn({ traceId: "no-trace", ...data }, message);
  }
  error(message, data) {
    logger.error({ traceId: "no-trace", ...data }, message);
  }
  debug(message, data) {
    logger.debug({ traceId: "no-trace", ...data }, message);
  }
  startSpan(name) {
    return new SimpleSpan(name);
  }
};
var telemetry = new TelemetryImpl();
async function runWithTrace(traceId, fn) {
  const span = telemetry.startSpan(traceId);
  try {
    const result = await fn();
    span.end({ success: true });
    return result;
  } catch (error) {
    span.end({ success: false, error: error.message });
    throw error;
  }
}

// src/action.ts
import fs2 from "fs";
import path2 from "path";
import { exec as execCb } from "child_process";
import { promisify } from "util";
var execAsync = promisify(execCb);
var Action = class {
  projectRoot;
  sandboxBase;
  cwd;
  sandboxPath;
  timeoutMs;
  bashRetryMax;
  bashRetryBaseDelayMs;
  bashRetryMaxDelayMs;
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || process.cwd();
    this.sandboxBase = options.sandboxBase || path2.join(this.projectRoot, ".huluwa/sandboxes");
    this.cwd = options.cwd || this.projectRoot;
    this.sandboxPath = null;
    this.timeoutMs = options.timeoutMs ?? (this._getEnvInt("KUAFU_TOOL_TIMEOUT_MS", 12e4) || this._getEnvInt("AGENT_TOOL_TIMEOUT_MS", 12e4));
    this.bashRetryMax = this._toSafeInt(options.bashRetryMax ?? this._getEnvInt("TELEGRAM_BASH_RETRY_MAX", 1));
    this.bashRetryBaseDelayMs = this._toSafeInt(options.bashRetryBaseDelayMs ?? this._getEnvInt("TELEGRAM_BASH_RETRY_BASE_DELAY_MS", 800));
    this.bashRetryMaxDelayMs = this._toSafeInt(options.bashRetryMaxDelayMs ?? this._getEnvInt("TELEGRAM_BASH_RETRY_MAX_DELAY_MS", 4e3));
  }
  /**
   * Convert to safe integer
   */
  _toSafeInt(value, defaultValue) {
    const num = parseInt(value, 10);
    return Number.isFinite(num) && num > 0 ? num : defaultValue;
  }
  /**
   * Get environment variable as safe integer
   */
  _getEnvInt(envVar, defaultValue) {
    const value = process.env[envVar] || String(defaultValue);
    return this._toSafeInt(value, defaultValue);
  }
  /**
   * Get tool specifications
   */
  getSpecs() {
    return [
      {
        type: "function",
        function: {
          name: "bash",
          description: "Execute shell command in the current working directory.",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "The complete shell command to execute." }
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
          description: "Read file content.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Relative file path." }
            },
            required: ["path"],
            additionalProperties: false
          }
        }
      },
      {
        type: "function",
        function: {
          name: "write",
          description: "Create or overwrite file in sandbox.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path." },
              content: { type: "string", description: "File content." }
            },
            required: ["path", "content"],
            additionalProperties: false
          }
        }
      }
    ];
  }
  /**
   * Execute bash command
   */
  async bash(command) {
    const startTime = Date.now();
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.cwd,
        timeout: this.timeoutMs,
        shell: "/bin/bash"
      });
      return {
        ok: true,
        stdout,
        stderr,
        retryInfo: {
          retried: 0,
          attempts: 1,
          exhausted: false
        }
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const isTimeout = error.code === "ETIMEDOUT" || error.killed;
      return {
        ok: false,
        error: error.message || String(error),
        stderr: error.stderr,
        retryInfo: {
          retried: 0,
          attempts: 1,
          exhausted: !isTimeout
        }
      };
    }
  }
  /**
   * Read file content
   */
  async read(filePath) {
    const fullPath = path2.join(this.cwd, filePath);
    try {
      if (!fs2.existsSync(fullPath)) {
        return {
          ok: false,
          error: `File not found: ${filePath}`
        };
      }
      const content = fs2.readFileSync(fullPath, "utf-8");
      return {
        ok: true,
        stdout: content
      };
    } catch (error) {
      return {
        ok: false,
        error: error.message || String(error)
      };
    }
  }
  /**
   * Write file content
   */
  async write(filePath, content) {
    const fullPath = path2.join(this.cwd, filePath);
    try {
      const dir = path2.dirname(fullPath);
      if (!fs2.existsSync(dir)) {
        fs2.mkdirSync(dir, { recursive: true });
      }
      fs2.writeFileSync(fullPath, content, "utf-8");
      return {
        ok: true,
        stdout: `File written: ${filePath}`
      };
    } catch (error) {
      return {
        ok: false,
        error: error.message || String(error)
      };
    }
  }
  /**
   * Invoke tool by name
   */
  async invokeTool(toolCall) {
    const { name, arguments: args } = toolCall.function;
    switch (name) {
      case "bash":
        return await this.bash(args.command);
      case "read":
        return await this.read(args.path);
      case "write":
        return await this.write(args.path, args.content);
      default:
        return {
          ok: false,
          error: `Unknown tool: ${name}`
        };
    }
  }
};

// src/perception.ts
import fs3 from "fs";
var SOUL_CACHE = { data: null, ts: 0 };
var CACHE_TTL = 3e4;
var Perception = class {
  config;
  _allSkills;
  _skillsLoadedAt;
  skillRefreshMs;
  _soul;
  _workspace;
  constructor(config = {}) {
    this.config = config;
    this._allSkills = null;
    this._skillsLoadedAt = 0;
    this.skillRefreshMs = this._toSafeInt(
      config.skillRefreshMs ?? process.env.AGENT_SKILLS_REFRESH_MS ?? process.env.TELEGRAM_SKILLS_REFRESH_MS,
      3e3
    );
    this._soul = null;
    this._workspace = null;
  }
  /**
   * Convert to safe integer
   */
  _toSafeInt(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  }
  /**
   * Get discovered skills
   */
  _getSkills() {
    const now = Date.now();
    const expired = now - this._skillsLoadedAt >= this.skillRefreshMs;
    if (!this._allSkills || expired) {
      this._allSkills = [];
      this._skillsLoadedAt = now;
    }
    return this._allSkills || [];
  }
  /**
   * Get soul configuration
   */
  _getSoul() {
    const now = Date.now();
    if (SOUL_CACHE.data !== null && now - SOUL_CACHE.ts < CACHE_TTL) {
      return SOUL_CACHE.data;
    }
    try {
      const soul = fs3.existsSync("SOUL.md") ? fs3.readFileSync("SOUL.md", "utf-8") : "";
      SOUL_CACHE.data = soul;
      SOUL_CACHE.ts = now;
      return soul;
    } catch (e) {
      return "";
    }
  }
  /**
   * Gather perception data
   */
  async gather(input) {
    const span = telemetry.startSpan("Perception.gather");
    try {
      const { prompt, task, retrievedContext = [], sessionId, taskId, isSimpleChat } = input;
      if (isSimpleChat) {
        const state2 = this.observe(sessionId, taskId, task);
        state2.isSimpleChat = true;
        return {
          skills: [],
          state: state2,
          workspace: null,
          lessons: [],
          retrievedContext: []
        };
      }
      let skills = [];
      try {
        skills = await this.routeSkills(prompt);
      } catch (e) {
        telemetry.warn("[Perception] Skill routing failed", { error: e.message });
        skills = [];
      }
      const state = this.observe(sessionId, taskId, task);
      const workspace = this.observeWorkspace();
      const lessons = [];
      return {
        skills,
        state,
        workspace,
        lessons,
        retrievedContext
      };
    } catch (e) {
      span.end({ error: e.message });
      throw e;
    } finally {
      span.end();
    }
  }
  /**
   * Observe agent state
   */
  observe(sessionId, taskId, task) {
    return {
      sessionId,
      taskId,
      task,
      isSimpleChat: false
    };
  }
  /**
   * Observe workspace
   */
  observeWorkspace() {
    if (this._workspace) {
      return this._workspace;
    }
    this._workspace = {
      cwd: process.cwd(),
      files: []
    };
    return this._workspace;
  }
  /**
   * Route skills based on prompt (simplified keyword matching)
   */
  async routeSkills(prompt) {
    const skills = this._getSkills();
    const promptLower = prompt.toLowerCase();
    const matchedSkills = skills.filter((skill) => {
      const nameMatch = promptLower.includes(skill.name.toLowerCase());
      const descMatch = skill.description && promptLower.includes(skill.description.toLowerCase());
      return nameMatch || descMatch;
    });
    return matchedSkills;
  }
  /**
   * Clear workspace cache
   */
  clearWorkspaceCache() {
    this._workspace = null;
  }
  /**
   * Clear all caches
   */
  clearCache() {
    this._allSkills = null;
    this._skillsLoadedAt = 0;
    this._soul = null;
    this._workspace = null;
    SOUL_CACHE.data = null;
    SOUL_CACHE.ts = 0;
  }
};

// src/decision.ts
var Decision = class {
  maxSteps;
  constructor(options = {}) {
    this.maxSteps = options.maxSteps ?? 30;
  }
  /**
   * Check if agent should continue
   */
  shouldContinue(history, currentStep, lastToolCalls) {
    const span = telemetry.startSpan("Decision.shouldContinue");
    try {
      if (currentStep >= this.maxSteps) {
        return {
          shouldContinue: false,
          stopReason: "max_steps_exceeded"
        };
      }
      if (lastToolCalls && lastToolCalls.length > 0) {
        return {
          shouldContinue: true
        };
      }
      const lastTurn = history[history.length - 1];
      if (!lastTurn || !lastTurn.content) {
        return {
          shouldContinue: false,
          stopReason: "empty_response"
        };
      }
      const content = lastTurn.content.toLowerCase();
      if (this.isCompletionIndicated(content)) {
        return {
          shouldContinue: false,
          stopReason: "task_completed"
        };
      }
      if (this.detectLoop(history)) {
        return {
          shouldContinue: false,
          stopReason: "loop_detected"
        };
      }
      return {
        shouldContinue: true
      };
    } finally {
      span.end();
    }
  }
  /**
   * Check if content indicates task completion
   */
  isCompletionIndicated(content) {
    const englishPatterns = [
      /\b(done|finished|completed|complete)\b/i,
      /\b(success|succeeded)\b/i
    ];
    const chinesePatterns = [
      /任务完成/i,
      /已完成/i,
      /完成工作/i,
      /完成了/i,
      /做完/i,
      /搞定/i,
      /结束/i
    ];
    for (const pattern of englishPatterns) {
      if (pattern.test(content)) {
        return true;
      }
    }
    for (const pattern of chinesePatterns) {
      if (pattern.test(content)) {
        return true;
      }
    }
    return false;
  }
  /**
   * Detect repetitive loops in history
   */
  detectLoop(history) {
    if (history.length < 6) {
      return false;
    }
    const recentTurns = history.slice(-6);
    const firstHalf = recentTurns.slice(0, 3);
    const secondHalf = recentTurns.slice(3, 6);
    const firstHalfContent = firstHalf.map((t) => t.content).join("|");
    const secondHalfContent = secondHalf.map((t) => t.content).join("|");
    return firstHalfContent === secondHalfContent;
  }
  /**
   * Check semantic self-verification
   */
  semanticCheck(prompt, response) {
    if (!response || response.trim().length === 0) {
      return {
        shouldContinue: false,
        stopReason: "empty_response",
        intercept: true,
        interceptMessage: "Response is empty"
      };
    }
    return {
      shouldContinue: true
    };
  }
  /**
   * Update max steps
   */
  setMaxSteps(maxSteps) {
    this.maxSteps = maxSteps;
  }
  /**
   * Get current max steps
   */
  getMaxSteps() {
    return this.maxSteps;
  }
};

// src/kernel/fsm.ts
var KernelFSM = class {
  context;
  constructor(context) {
    this.context = context;
  }
  /**
   * Run FSM loop until DONE or FAILED
   */
  async run(handlers) {
    const span = telemetry.startSpan("KernelFSM.run");
    try {
      while (this.context.state !== "DONE" && this.context.state !== "FAILED") {
        telemetry.debug(`[FSM] State: ${this.context.state}`);
        try {
          switch (this.context.state) {
            case "PERCEIVING":
              this.context = await handlers.handlePerceiving(this.context);
              break;
            case "THINKING":
              this.context = await handlers.handleThinking(this.context);
              break;
            case "DECIDING":
              this.context = await handlers.handleDeciding(this.context);
              break;
            case "ACTING":
              this.context = await handlers.handleActing(this.context);
              break;
            case "REFLECTING":
              this.context = await handlers.handleReflecting(this.context);
              break;
            default:
              throw new Error(`Unknown state: ${this.context.state}`);
          }
          if (this.context.onStep) {
            this.context.onStep(this.context);
          }
          this.context.stepCount++;
        } catch (error) {
          telemetry.error(`[FSM] Error in state ${this.context.state}`, {
            error: error.message
          });
          this.context.state = "FAILED";
          this.context.finalResult = {
            error: error.message
          };
        }
      }
      return this.context;
    } finally {
      span.end({
        finalState: this.context.state,
        steps: this.context.stepCount
      });
    }
  }
  /**
   * Transition to next state
   */
  transition(nextState) {
    telemetry.debug(`[FSM] Transition: ${this.context.state} \u2192 ${nextState}`);
    this.context.state = nextState;
  }
  /**
   * Get current state
   */
  getState() {
    return this.context.state;
  }
  /**
   * Get current context
   */
  getContext() {
    return this.context;
  }
  /**
   * Update context
   */
  updateContext(updates) {
    this.context = { ...this.context, ...updates };
  }
};

// src/kernel/index.ts
var Kernel = class {
  store;
  action;
  progressSink;
  outcomeSink;
  constructor(options = {}) {
    this.store = options.store || options.backend;
    this.action = options.action || null;
    this.progressSink = options.progressSink || null;
    this.outcomeSink = options.outcomeSink || null;
  }
  /**
   * Run kernel with options
   */
  async run(options) {
    const {
      taskId,
      prompt: originalPrompt,
      sessionId,
      maxSteps = 30,
      retrievedContext = [],
      onStep,
      maxHistory = 10,
      progressSink,
      outcomeSink: perCallOutcomeSink,
      isSimpleChat: forceSimpleChat,
      promptEmbedding
    } = options;
    const resolvedOutcomeSink = perCallOutcomeSink || this.outcomeSink;
    const traceId = `task-${taskId}-sess-${sessionId}-${Date.now()}`;
    const resolvedProgressSink = progressSink || this.progressSink;
    return runWithTrace(traceId, async () => {
      const span = telemetry.startSpan("Kernel.run");
      try {
        const task = await this.store.getTaskById(taskId);
        if (!task) {
          throw new Error(`Task not found: ${taskId}`);
        }
        const currentBranchId = task.current_branch_id || await this.store.pivotBranch(taskId);
        await this.saveUserPrompt(taskId, currentBranchId, originalPrompt);
        const context = {
          // Config
          taskId,
          sessionId,
          originalPrompt,
          maxSteps,
          maxHistory,
          agentName: options.agentName,
          onStep,
          progressSink: resolvedProgressSink,
          progressHeartbeatMs: 6e3,
          // Runtime State
          state: "PERCEIVING",
          stepCount: 0,
          turnHint: null,
          isWorkspaceReady: false,
          forceSimpleChat,
          promptEmbedding,
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
          // Metrics
          toolsUsed: [],
          toolFailures: 0,
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          runStartTime: Date.now()
        };
        this.emitProgress(context, "RUN_STARTED", {
          status: "RUNNING",
          maxSteps
        });
        const fsm = new KernelFSM(context);
        const result = await fsm.run({
          handlePerceiving: async (ctx) => await this.handlePerceiving(ctx),
          handleThinking: async (ctx) => await this.handleThinking(ctx),
          handleDeciding: async (ctx) => await this.handleDeciding(ctx),
          handleActing: async (ctx) => await this.handleActing(ctx),
          handleReflecting: async (ctx) => await this.handleReflecting(ctx)
        });
        const durationMs = Date.now() - context.runStartTime;
        const kernelResult = {
          success: context.state === "DONE",
          status: context.state,
          content: context.finalResult?.content || "",
          steps: context.stepCount,
          durationMs,
          stopReason: context.finalResult?.stopReason,
          meta: {
            loop: {
              stopReason: context.finalResult?.stopReason,
              durationMs
            }
          }
        };
        span.end({
          success: kernelResult.success,
          durationMs
        });
        if (resolvedOutcomeSink) {
          try {
            await resolvedOutcomeSink.onOutcome({
              taskId,
              sessionId,
              status: kernelResult.success ? "completed" : "failed",
              content: kernelResult.content,
              trigger: options.trigger || "unknown",
              durationMs,
              error: kernelResult.error,
              metadata: options.outcomeMeta
            });
          } catch (sinkErr) {
            console.warn("[Kernel] outcomeSink.onOutcome failed:", sinkErr.message);
          }
        }
        return kernelResult;
      } catch (error) {
        span.end({
          success: false,
          error: error.message
        });
        const failedResult = {
          success: false,
          status: "FAILED",
          content: "",
          error: error.message,
          stopReason: "error"
        };
        if (resolvedOutcomeSink) {
          try {
            await resolvedOutcomeSink.onOutcome({
              taskId,
              sessionId,
              status: "failed",
              content: "",
              trigger: options.trigger || "unknown",
              error: error.message
            });
          } catch (_) {
          }
        }
        return failedResult;
      }
    });
  }
  /**
   * Save user prompt to history
   */
  async saveUserPrompt(taskId, branchId, prompt) {
    const existingMsgs = await this.store.getActiveMessages(taskId, branchId);
    const lastMsg = existingMsgs[existingMsgs.length - 1];
    if (!lastMsg || lastMsg.senderId !== "user" || lastMsg.content !== prompt) {
      await this.store.saveTaskMessage({
        taskId,
        branchId,
        senderId: "user",
        content: prompt,
        payload: {}
      });
    }
  }
  /**
   * Handle PERCEIVING state
   */
  async handlePerceiving(context) {
    const span = telemetry.startSpan("Kernel.handlePerceiving");
    try {
      const perceptionData = await context.perception.gather({
        prompt: context.originalPrompt,
        task: context.task,
        retrievedContext: context.retrievedContext,
        sessionId: context.sessionId,
        taskId: context.taskId,
        isSimpleChat: context.forceSimpleChat
      });
      context = {
        ...context,
        sensoryData: perceptionData,
        contextBlock: perceptionData.state?.contextBlock || "",
        state: "THINKING"
      };
      span.end();
      return context;
    } catch (error) {
      span.end({ error: error.message });
      throw error;
    }
  }
  /**
   * Handle THINKING state
   */
  async handleThinking(context) {
    const span = telemetry.startSpan("Kernel.handleThinking");
    try {
      const llmResult = await this.callLLM({
        prompt: context.originalPrompt,
        systemPrompt: context.contextBlock
      });
      context = {
        ...context,
        turnResult: llmResult,
        totalPromptTokens: context.totalPromptTokens + (llmResult.usage?.promptTokens || 0),
        totalCompletionTokens: context.totalCompletionTokens + (llmResult.usage?.completionTokens || 0),
        state: "DECIDING"
      };
      span.end();
      return context;
    } catch (error) {
      span.end({ error: error.message });
      throw error;
    }
  }
  /**
   * Handle DECIDING state
   */
  async handleDeciding(context) {
    const span = telemetry.startSpan("Kernel.handleDeciding");
    try {
      const turnResult = context.turnResult;
      if (turnResult?.toolCalls && turnResult.toolCalls.length > 0) {
        context = {
          ...context,
          toolsUsed: [...context.toolsUsed, ...turnResult.toolCalls.map((tc) => tc.function?.name)],
          state: "ACTING"
        };
      } else {
        context = {
          ...context,
          finalResult: {
            content: turnResult?.content || "",
            stopReason: "task_completed"
          },
          state: "DONE"
        };
      }
      span.end();
      return context;
    } catch (error) {
      span.end({ error: error.message });
      throw error;
    }
  }
  /**
   * Handle ACTING state
   */
  async handleActing(context) {
    const span = telemetry.startSpan("Kernel.handleActing");
    try {
      const turnResult = context.turnResult;
      if (!turnResult?.toolCalls) {
        context = {
          ...context,
          state: "THINKING"
        };
        return context;
      }
      const toolResults = [];
      for (const toolCall of turnResult.toolCalls) {
        const result = await this.action.invokeTool(toolCall);
        toolResults.push(result);
        if (!result.ok) {
          context.toolFailures++;
        }
      }
      context = {
        ...context,
        turnResult: {
          ...turnResult,
          toolResults
        },
        state: "REFLECTING"
      };
      span.end();
      return context;
    } catch (error) {
      span.end({ error: error.message });
      throw error;
    }
  }
  /**
   * Handle REFLECTING state
   */
  async handleReflecting(context) {
    const span = telemetry.startSpan("Kernel.handleReflecting");
    try {
      context = {
        ...context,
        state: "THINKING"
      };
      span.end();
      return context;
    } catch (error) {
      span.end({ error: error.message });
      throw error;
    }
  }
  /**
   * Call LLM
   */
  async callLLM(options) {
    return {
      content: "LLM response",
      usage: {
        promptTokens: 0,
        completionTokens: 0
      }
    };
  }
  /**
   * Emit progress event
   */
  emitProgress(context, type, data) {
    if (context.progressSink) {
      context.progressSink.emit({
        type,
        taskId: context.taskId,
        sessionId: context.sessionId,
        ...data
      });
    }
  }
};

// src/index.ts
var VERSION = "1.2.0-ts";
var kuafuFramework = {
  VERSION,
  Store,
  Action,
  Perception,
  Decision,
  Kernel,
  telemetry,
  runWithTrace
};
var index_default = kuafuFramework;
export {
  Action,
  Decision,
  Kernel,
  Perception,
  Store,
  VERSION,
  index_default as default,
  runWithTrace,
  telemetry
};
//# sourceMappingURL=index.js.map