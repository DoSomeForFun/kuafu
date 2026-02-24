// src/store.ts
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
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
    try {
      loadSqliteVec(this.db);
    } catch (err) {
      console.warn("[Store] sqlite-vec load failed:", err.message);
    }
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
      CREATE TABLE IF NOT EXISTS context_vectors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT,
        task_id TEXT,
        sender_id TEXT,
        content TEXT,
        embedding BLOB
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id);
      CREATE INDEX IF NOT EXISTS idx_messages_branch ON messages(branch_id);
      CREATE INDEX IF NOT EXISTS idx_lessons_task ON lessons(task_id);
      CREATE INDEX IF NOT EXISTS idx_llm_executions_task ON llm_executions(task_id);
      CREATE INDEX IF NOT EXISTS idx_runs_chat ON runs(chat_id);
      CREATE INDEX IF NOT EXISTS idx_runs_sender ON runs(sender_id);
      CREATE INDEX IF NOT EXISTS idx_context_vectors_task ON context_vectors(task_id);
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

// src/index.ts
var VERSION = "1.2.0-ts";
var kuafuFramework = {
  VERSION,
  Store,
  Action,
  telemetry,
  runWithTrace
};
var index_default = kuafuFramework;
export {
  Action,
  Store,
  VERSION,
  index_default as default,
  runWithTrace,
  telemetry
};
//# sourceMappingURL=index.js.map