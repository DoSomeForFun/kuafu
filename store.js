import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { telemetry } from "./telemetry.js";

/**
 * Sensitive content patterns for filtering
 */
const SENSITIVE_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/i,  // OpenAI API key
  /ghp_[a-zA-Z0-9]{36}/,   // GitHub personal access token
  /gho_[a-zA-Z0-9]{36}/,   // GitHub OAuth token
  /ghu_[a-zA-Z0-9]{36}/,   // GitHub user-to-server token
  /ghs_[a-zA-Z0-9]{36}/,   // GitHub server-to-server token
  /ghr_[a-zA-Z0-9]{36}/,   // GitHub refresh token
  /password\s*[:=]\s*\S+/i,  // password field
  /secret\s*[:=]\s*\S+/i,    // secret field
  /api[_-]?key\s*[:=]\s*\S+/i,  // API key field
  /bearer\s+[a-zA-Z0-9\-_\.]{20,}/i,  // Bearer token
];

/**
 * Check if content contains sensitive information
 */
function containsSensitiveContent(content) {
  if (!content) return false;
  return SENSITIVE_PATTERNS.some(pattern => pattern.test(content));
}

/**
 * Unified Store (SQLite + Vector)
 */
export class Store {
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
      telemetry.warn("[Store] sqlite-vec load failed", { error: err?.message || String(err) });
    }

    this._initSchema();
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, title TEXT, date TEXT, notes TEXT, status TEXT DEFAULT 'todo', current_branch_id TEXT, updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, task_id TEXT, branch_id TEXT, execution_id TEXT, sender_id TEXT, content TEXT, payload TEXT, is_archived INTEGER DEFAULT 0, created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS lessons (
        id TEXT PRIMARY KEY, task_id TEXT, branch_id TEXT, root_cause TEXT, what_not_to_do TEXT, suggested_alternatives TEXT, trajectory TEXT, created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS llm_executions (
        id TEXT PRIMARY KEY, task_id TEXT, agent_name TEXT, prompt TEXT, thinking TEXT, status TEXT, 
        usage_prompt_tokens INTEGER, usage_completion_tokens INTEGER, latency_ms INTEGER, created_at INTEGER
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
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_runs_chat_sender_created ON runs(chat_id, sender_id, created_at DESC);");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_runs_status_updated ON runs(status, updated_at DESC);");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_run_events_run_created ON run_events(run_id, created_at DESC);");

    const lessonInfo = this.db.prepare("PRAGMA table_info(lessons)").all();
    if (!lessonInfo.some(col => col.name === "trajectory")) {
      this.db.exec("ALTER TABLE lessons ADD COLUMN trajectory TEXT;");
    }

    const tasksInfo = this.db.prepare("PRAGMA table_info(tasks)").all();
    if (!tasksInfo.some(col => col.name === "current_branch_id")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN current_branch_id TEXT;");
    }

    const messagesInfo = this.db.prepare("PRAGMA table_info(messages)").all();
    if (!messagesInfo.some(col => col.name === "branch_id")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN branch_id TEXT;");
    }
    if (!messagesInfo.some(col => col.name === "is_archived")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN is_archived INTEGER DEFAULT 0;");
    }

    try {
      // 检查现有表的字段
      let contextVecHasCreatedAt = false;
      try {
        const vecInfo = this.db.prepare("PRAGMA table_info(context_vectors)").all();
        contextVecHasCreatedAt = vecInfo.some(col => col.name === "created_at");
      } catch (e) { /* 表不存在，会自动创建 */ }

      if (contextVecHasCreatedAt) {
        // 表已有所需字段，静默跳过
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS context_vectors USING vec0(
            message_id TEXT, task_id TEXT, sender_id TEXT, content TEXT, 
            embedding FLOAT[384], created_at TEXT
          );
        `);
      } else {
        // 尝试重建表（如果存在旧数据会丢失，这里简化处理）
        this.db.exec("DROP TABLE IF EXISTS context_vectors");
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS context_vectors USING vec0(
            message_id TEXT, task_id TEXT, sender_id TEXT, content TEXT, 
            embedding FLOAT[384], created_at TEXT
          );
        `);
      }

      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS lesson_vectors USING vec0(
          lesson_id TEXT, prompt TEXT, 
          embedding FLOAT[384]
        );
      `);
    } catch (err) { }
  }

  // --- Helpers ---
  _mapMessage(row) {
    if (!row) return null;
    return {
      id: row.id,
      taskId: row.task_id,
      branchId: row.branch_id,
      executionId: row.execution_id,
      senderId: row.sender_id,
      content: row.content,
      isArchived: row.is_archived === 1,
      createdAt: row.created_at,
      payload: row.payload ? JSON.parse(row.payload) : {}
    };
  }

  async getTaskById(id) { return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id); }

  async createTask(input) {
    const task = {
      id: input.id || randomUUID(), title: input.title, date: input.date, notes: input.notes || "",
      status: "doing", current_branch_id: randomUUID(), updated_at: Date.now()
    };
    this.db.prepare("INSERT INTO tasks (id, title, date, notes, status, current_branch_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(task.id, task.title, task.date, task.notes, task.status, task.current_branch_id, task.updated_at);
    return task;
  }

  async pivotBranch(taskId) {
    const newBranchId = randomUUID();
    this.db.prepare("UPDATE tasks SET current_branch_id = ?, updated_at = ? WHERE id = ?").run(newBranchId, Date.now(), taskId);
    return newBranchId;
  }

  async saveTaskMessage(input) {
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare("INSERT INTO messages (id, task_id, branch_id, execution_id, sender_id, content, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.taskId, input.branchId || null, input.executionId || null, input.senderId, input.content, JSON.stringify(input.payload || {}), now);
    return { ...input, id, created_at: now };
  }

  async getActiveMessages(taskId, branchId, limit = 0) {
    const sql = limit > 0
      ? "SELECT * FROM (SELECT * FROM messages WHERE task_id = ? AND (branch_id = ? OR branch_id IS NULL) AND is_archived = 0 ORDER BY created_at DESC LIMIT ?) ORDER BY created_at ASC"
      : "SELECT * FROM messages WHERE task_id = ? AND (branch_id = ? OR branch_id IS NULL) AND is_archived = 0 ORDER BY created_at ASC";
    const rows = limit > 0
      ? this.db.prepare(sql).all(taskId, branchId, limit)
      : this.db.prepare(sql).all(taskId, branchId);
    return rows.map(r => this._mapMessage(r));
  }

  async getTaskMessages(taskId) {
    const rows = this.db.prepare("SELECT * FROM messages WHERE task_id = ? ORDER BY created_at ASC").all(taskId);
    return rows.map(r => this._mapMessage(r));
  }

  async saveLesson(input) {
    const id = randomUUID();
    this.db.prepare("INSERT INTO lessons (id, task_id, branch_id, root_cause, what_not_to_do, suggested_alternatives, trajectory, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.taskId, input.branchId, input.rootCause, input.whatNotToDo, input.alternatives, input.trajectory ? JSON.stringify(input.trajectory) : null, Date.now());
    return id;
  }

  async upsertLessonVector(lessonId, prompt, embedding) {
    if (!embedding) return;
    this.db.prepare("DELETE FROM lesson_vectors WHERE lesson_id = ?").run(lessonId);
    this.db.prepare("INSERT INTO lesson_vectors(lesson_id, prompt, embedding) VALUES (?, ?, ?)")
      .run(lessonId, prompt, JSON.stringify(embedding));
  }

  async searchGlobalLessons(embedding, limit = 3) {
    if (!embedding) return [];
    try {
      const rows = this.db.prepare(`
        SELECT lesson_id, prompt, distance
        FROM lesson_vectors
        WHERE embedding MATCH ? AND k = ?
        ORDER BY distance ASC
      `).all(JSON.stringify(embedding), limit);

      const lessons = [];
      for (const row of rows) {
        const lesson = await this.db.prepare("SELECT * FROM lessons WHERE id = ?").get(row.lesson_id);
        if (lesson) {
          lessons.push({
            ...lesson,
            score: 1 / (1 + row.distance),
            prompt: row.prompt
          });
        }
      }
      return lessons;
    } catch (e) {
      telemetry.warn("[Store] searchGlobalLessons failed", { error: e.message });
      return [];
    }
  }

  async getLessons(taskId) {
    return this.db.prepare("SELECT * FROM lessons WHERE task_id = ? ORDER BY created_at ASC").all(taskId);
  }

  async updateTask(id, updates) {
    const fields = Object.keys(updates).map(k => `${k} = ?`);
    this.db.prepare(`UPDATE tasks SET ${fields.join(", ")}, updated_at = ? WHERE id = ?`).run(...Object.values(updates), Date.now(), id);
  }

  async saveExecution(input) {
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(`INSERT INTO llm_executions (id, task_id, agent_name, prompt, thinking, status, usage_prompt_tokens, usage_completion_tokens, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.taskId, input.agentName, input.prompt, input.thinking, input.status, input.usagePromptTokens, input.usageCompletionTokens, input.latencyMs, now);
    return { id };
  }

  async upsertVector(input) {
    const { messageId, taskId, senderId, content, embedding, createdAt } = input;
    if (!embedding) return;

    // 敏感内容过滤 - 保护用户隐私和安全
    if (containsSensitiveContent(content)) {
      telemetry.info("[Store] upsertVector skipped due to sensitive content", { messageId, taskId });
      return;
    }

    // 过滤极短内容（噪音过滤）
    const contentLen = (content?.length || 0);
    const minLen = 3;
    if (contentLen < minLen) return;

    // 统一使用毫秒存储
    const timestamp = createdAt && createdAt > 0 ? String(createdAt) : String(Date.now());

    this.db.prepare("DELETE FROM context_vectors WHERE message_id = ?").run(messageId);
    this.db.prepare(`
      INSERT INTO context_vectors(message_id, task_id, sender_id, content, embedding, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(messageId, taskId, senderId, content, JSON.stringify(embedding), timestamp);
  }

  async searchRelevant(input) {
    const {
      embedding,
      limit = 5,
      filterByTaskId,
      filterByTaskIds,
      filterByTaskIdPrefix,
      timeDecayDays = 30,
      minContentLength = 3,
      senderWeightMap = {}  // 新增：{ "sender_id": weight } 映射表，由调用方传入，解耦 IM 系统
    } = input;
    if (!embedding) return [];

    // 多取一些结果，用于过滤和重排
    const fetchLimit = Math.max(limit * 3, 20);

    let sql = `
      SELECT message_id, task_id, sender_id, content, distance
      FROM context_vectors
      WHERE embedding MATCH ? AND k = ?
    `;
    const params = [JSON.stringify(embedding), fetchLimit];
    if (filterByTaskId) {
      sql += " AND task_id = ?";
      params.push(filterByTaskId);
    }
    if (Array.isArray(filterByTaskIds) && filterByTaskIds.length > 0) {
      const placeholders = filterByTaskIds.map(() => "?").join(", ");
      sql += ` AND task_id IN (${placeholders})`;
      params.push(...filterByTaskIds);
    }
    // 注意：vec0 KNN 查询不支持 LIKE，所以 filterByTaskIdPrefix 改为后处理过滤
    sql += " ORDER BY distance ASC";

    const rows = this.db.prepare(sql).all(...params);

    // 后处理：前缀过滤 + 内容过滤 + 发送者降权 + 时间衰减
    const prefix = filterByTaskIdPrefix;
    const now = Date.now();
    const cutoffTime = timeDecayDays > 0
      ? Math.floor(now / 1000) - timeDecayDays * 24 * 60 * 60
      : 0;

    const processed = rows
      .map(r => {
        const baseScore = 1 / (1 + r.distance);
        let finalScore = baseScore;

        // 0. 前缀过滤（vec0 不支持 LIKE，后处理过滤）
        if (prefix && !String(r.task_id || "").startsWith(prefix)) {
          return null; // 标记为过滤
        }

        // 1. 内容长度过滤（预处理阶段，不算分）
        const contentLen = (r.content?.length || 0);

        // 2. 发送者降权：使用 senderWeightMap，由调用方配置，解耦 IM 系统
        const senderId = String(r.sender_id || "");
        if (senderWeightMap && typeof senderWeightMap === "object") {
          // 精确匹配
          let weight = senderWeightMap[senderId];
          // 前缀匹配（如 "bot_" 开头的）
          if (weight === undefined) {
            for (const [key, val] of Object.entries(senderWeightMap)) {
              if (senderId.toLowerCase().startsWith(key.toLowerCase())) {
                weight = val;
                break;
              }
            }
          }
          // 默认权重为 1.0（不降权）
          if (weight !== undefined && weight < 1.0) {
            finalScore *= weight;
          }
        }

        // 3. 时间衰减（统一使用毫秒）
        // created_at 存储为 TEXT（毫秒）
        const createdAtStr = r.created_at;
        if (timeDecayDays > 0 && createdAtStr) {
          const createdAtMs = Number(createdAtStr);
          if (createdAtMs && createdAtMs > 0) {
            const ageDays = (now - createdAtMs) / (1000 * 60 * 60 * 24);
            const timeWeight = Math.exp(-ageDays / timeDecayDays);
            finalScore *= (0.3 + 0.7 * timeWeight); // 最低 30% 权重
          }
        }

        return {
          id: r.message_id,
          taskId: r.task_id,
          senderId: r.sender_id,
          content: r.content,
          contentLength: contentLen,
          isBotMessage,
          createdAt: createdAtStr,
          baseScore,
          finalScore
        };
      })
      // 过滤：null（被前缀过滤排除的）+ 短内容
      .filter(r => r !== null && r.contentLength >= minContentLength)
      // 按最终分数排序
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, limit);

    return processed.map(r => ({
      id: r.id,
      taskId: r.taskId,
      senderId: r.senderId,
      content: r.content,
      score: r.finalScore
    }));
  }

  _mapRun(row) {
    if (!row) return null;
    return {
      id: row.id,
      chatId: row.chat_id,
      senderId: row.sender_id,
      taskId: row.task_id,
      sessionId: row.session_id,
      sourceMessageId: row.source_message_id,
      panelChatId: row.panel_chat_id,
      panelMessageId: row.panel_message_id,
      title: row.title,
      prompt: row.prompt,
      status: row.status,
      stopReason: row.stop_reason,
      executor: row.executor,
      routeReason: row.route_reason,
      error: row.error,
      outputPreview: row.output_preview,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      archivedAt: row.archived_at,
      updatedAt: row.updated_at,
      createdAt: row.created_at
    };
  }

  _mapRunEvent(row) {
    if (!row) return null;
    let payload = {};
    if (row.payload) {
      try {
        payload = JSON.parse(row.payload);
      } catch {
        payload = {};
      }
    }
    return {
      id: row.id,
      runId: row.run_id,
      eventType: row.event_type,
      summary: row.summary,
      payload,
      createdAt: row.created_at
    };
  }

  async createRun(input = {}) {
    const id = input.id || randomUUID();
    const now = Date.now();
    const row = {
      id,
      chatId: String(input.chatId ?? ""),
      senderId: String(input.senderId ?? ""),
      taskId: String(input.taskId ?? ""),
      sessionId: String(input.sessionId ?? ""),
      sourceMessageId: String(input.sourceMessageId ?? ""),
      panelChatId: String(input.panelChatId ?? ""),
      panelMessageId: String(input.panelMessageId ?? ""),
      title: String(input.title ?? ""),
      prompt: String(input.prompt ?? ""),
      status: String(input.status || "queued"),
      stopReason: String(input.stopReason ?? ""),
      executor: String(input.executor ?? ""),
      routeReason: String(input.routeReason ?? ""),
      error: String(input.error ?? ""),
      outputPreview: String(input.outputPreview ?? ""),
      startedAt: Number(input.startedAt || 0) || null,
      finishedAt: Number(input.finishedAt || 0) || null,
      archivedAt: Number(input.archivedAt || 0) || null,
      updatedAt: now,
      createdAt: now
    };
    this.db
      .prepare(`
        INSERT INTO runs (
          id, chat_id, sender_id, task_id, session_id, source_message_id, panel_chat_id, panel_message_id,
          title, prompt, status, stop_reason, executor, route_reason, error, output_preview,
          started_at, finished_at, archived_at, updated_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        row.id,
        row.chatId,
        row.senderId,
        row.taskId,
        row.sessionId,
        row.sourceMessageId,
        row.panelChatId,
        row.panelMessageId,
        row.title,
        row.prompt,
        row.status,
        row.stopReason,
        row.executor,
        row.routeReason,
        row.error,
        row.outputPreview,
        row.startedAt,
        row.finishedAt,
        row.archivedAt,
        row.updatedAt,
        row.createdAt
      );
    return this.getRunById(row.id);
  }

  async getRunById(id) {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(String(id || ""));
    return this._mapRun(row);
  }

  async updateRun(id, updates = {}) {
    const normalizedId = String(id || "").trim();
    if (!normalizedId) return null;
    const mapping = {
      chatId: "chat_id",
      senderId: "sender_id",
      taskId: "task_id",
      sessionId: "session_id",
      sourceMessageId: "source_message_id",
      panelChatId: "panel_chat_id",
      panelMessageId: "panel_message_id",
      title: "title",
      prompt: "prompt",
      status: "status",
      stopReason: "stop_reason",
      executor: "executor",
      routeReason: "route_reason",
      error: "error",
      outputPreview: "output_preview",
      startedAt: "started_at",
      finishedAt: "finished_at",
      archivedAt: "archived_at"
    };
    const fields = [];
    const params = [];
    for (const [key, value] of Object.entries(updates || {})) {
      const column = mapping[key];
      if (!column) continue;
      fields.push(`${column} = ?`);
      params.push(value);
    }
    if (!fields.length) return this.getRunById(normalizedId);
    fields.push("updated_at = ?");
    params.push(Date.now());
    params.push(normalizedId);
    this.db.prepare(`UPDATE runs SET ${fields.join(", ")} WHERE id = ?`).run(...params);
    return this.getRunById(normalizedId);
  }

  async listRuns(input = {}) {
    const limit = Math.max(1, Number(input.limit || 20));
    const params = [];
    const where = [];
    if (input.chatId !== undefined && input.chatId !== null) {
      where.push("chat_id = ?");
      params.push(String(input.chatId));
    }
    if (input.senderId !== undefined && input.senderId !== null) {
      where.push("sender_id = ?");
      params.push(String(input.senderId));
    }
    const includeArchived = input.includeArchived === true;
    if (input.archivedOnly === true) {
      where.push("archived_at IS NOT NULL AND archived_at > 0");
    } else if (!includeArchived) {
      where.push("(archived_at IS NULL OR archived_at = 0)");
    }
    if (Array.isArray(input.statuses) && input.statuses.length > 0) {
      const normalizedStatuses = input.statuses.map((item) => String(item || "").trim()).filter(Boolean);
      if (normalizedStatuses.length) {
        where.push(`status IN (${normalizedStatuses.map(() => "?").join(", ")})`);
        params.push(...normalizedStatuses);
      }
    }
    if (Number.isFinite(Number(input.updatedAfter)) && Number(input.updatedAfter) > 0) {
      where.push("updated_at > ?");
      params.push(Number(input.updatedAfter));
    }
    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM runs ${whereClause} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit);
    return rows.map((row) => this._mapRun(row));
  }

  async appendRunEvent(input = {}) {
    const runId = String(input.runId || "").trim();
    if (!runId) return null;
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare("INSERT INTO run_events (id, run_id, event_type, summary, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        id,
        runId,
        String(input.eventType || ""),
        String(input.summary || ""),
        JSON.stringify(input.payload || {}),
        now
      );
    return {
      id,
      runId,
      eventType: String(input.eventType || ""),
      summary: String(input.summary || ""),
      payload: input.payload || {},
      createdAt: now
    };
  }

  async listRunEvents(runId, limit = 50) {
    const normalizedRunId = String(runId || "").trim();
    if (!normalizedRunId) return [];
    const safeLimit = Math.max(1, Number(limit || 50));
    const rows = this.db
      .prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(normalizedRunId, safeLimit);
    return rows.map((row) => this._mapRunEvent(row));
  }
}
