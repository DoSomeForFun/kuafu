import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { telemetry } from "./telemetry.js";

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
        id TEXT PRIMARY KEY, task_id TEXT, branch_id TEXT, root_cause TEXT, what_not_to_do TEXT, suggested_alternatives TEXT, created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS llm_executions (
        id TEXT PRIMARY KEY, task_id TEXT, agent_name TEXT, prompt TEXT, thinking TEXT, status TEXT, 
        usage_prompt_tokens INTEGER, usage_completion_tokens INTEGER, latency_ms INTEGER, created_at INTEGER
      );
    `);

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
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS context_vectors USING vec0(
          message_id TEXT, task_id TEXT, sender_id TEXT, content TEXT, 
          embedding FLOAT[384]
        );
      `);
    } catch (err) {}
  }

  // --- Helpers ---
  _mapMessage(row) {
    if (!row) return null;
    return {
      id: row.id,
      taskId: row.task_id,
      branchId: row.branch_id,
      executionId: row.execution_id,
      senderId: row.sender_id, // 关键：映射为驼峰
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
    this.db.prepare("INSERT INTO lessons (id, task_id, branch_id, root_cause, what_not_to_do, suggested_alternatives, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.taskId, input.branchId, input.rootCause, input.whatNotToDo, input.alternatives, Date.now());
    return id;
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
    const { messageId, taskId, senderId, content, embedding } = input;
    if (!embedding) return;
    this.db.prepare("DELETE FROM context_vectors WHERE message_id = ?").run(messageId);
    this.db.prepare("INSERT INTO context_vectors(message_id, task_id, sender_id, content, embedding) VALUES (?, ?, ?, ?, ?)")
      .run(messageId, taskId, senderId, content, JSON.stringify(embedding));
  }

  async searchRelevant(input) {
    const {
      embedding,
      limit = 5,
      filterByTaskId,
      filterByTaskIds,
      filterByTaskIdPrefix
    } = input;
    if (!embedding) return [];
    let sql = `
      SELECT message_id, task_id, sender_id, content, distance
      FROM context_vectors
      WHERE embedding MATCH ? AND k = ?
    `;
    const params = [JSON.stringify(embedding), limit];
    if (filterByTaskId) {
      sql += " AND task_id = ?";
      params.push(filterByTaskId);
    }
    if (Array.isArray(filterByTaskIds) && filterByTaskIds.length > 0) {
      const placeholders = filterByTaskIds.map(() => "?").join(", ");
      sql += ` AND task_id IN (${placeholders})`;
      params.push(...filterByTaskIds);
    }
    if (filterByTaskIdPrefix) {
      sql += " AND task_id LIKE ?";
      params.push(`${String(filterByTaskIdPrefix)}%`);
    }
    sql += " ORDER BY distance ASC";

    const rows = this.db.prepare(sql).all(...params);

    return rows
      .slice(0, limit)
      .map(r => ({ id: r.message_id, taskId: r.task_id, senderId: r.sender_id, content: r.content, score: 1 / (1 + r.distance) }));
  }
}
