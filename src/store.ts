import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import type { Task, Message, TaskStatus } from './types.js';
import type { IStore, SaveTaskMessageInput } from './interfaces.js';

/**
 * Sensitive content patterns for filtering
 */
const SENSITIVE_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/i,
  /ghp_[a-zA-Z0-9]{36}/,
  /gho_[a-zA-Z0-9]{36}/,
  /ghu_[a-zA-Z0-9]{36}/,
  /ghs_[a-zA-Z0-9]{36}/,
  /ghr_[a-zA-Z0-9]{36}/,
  /password\s*[:=]\s*\S+/i,
  /secret\s*[:=]\s*\S+/i,
  /api[_-]?key\s*[:=]\s*\S+/i,
  /bearer\s+[a-zA-Z0-9\-_\.]{20,}/i
];

/**
 * Check if content contains sensitive information
 */
function containsSensitiveContent(content: string | undefined | null): boolean {
  if (!content) return false;
  return SENSITIVE_PATTERNS.some(pattern => pattern.test(content));
}

/**
 * Unified Store (SQLite + Vector)
 */
export class Store implements IStore {
  public db: Database.Database;

  constructor(dbPath: string = 'data/agent-tasks.sqlite') {
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (dir && dir !== '.' && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this._initSchema();
  }

  private _initSchema(): void {
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

    // Create indexes
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
  async createTask(task: { id: string; title: string; date: string; status?: TaskStatus; notes?: string }): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO tasks (id, title, date, status, notes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      task.id,
      task.title,
      task.date,
      task.status || 'todo',
      task.notes || null,
      Date.now()
    );
  }

  /**
   * Get task by ID
   */
  async getTaskById(taskId: string): Promise<Task | null> {
    const stmt = this.db.prepare('SELECT * FROM tasks WHERE id = ?');
    const row = stmt.get(taskId) as {
      id: string;
      title: string;
      date: string;
      status: string;
      notes: string | null;
      current_branch_id: string | null;
      updated_at: number | null;
    } | undefined;
    
    if (!row) return null;
    
    return {
      id: row.id,
      title: row.title,
      date: row.date,
      status: row.status as TaskStatus,
      notes: row.notes ?? undefined,
      current_branch_id: row.current_branch_id ?? undefined,
      updated_at: row.updated_at ?? undefined
    };
  }

  /**
   * Update task status
   */
  async updateTaskStatus(taskId: string, status: TaskStatus): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?
    `);
    
    stmt.run(status, Date.now(), taskId);
  }

  /**
   * Create and switch to a new task branch.
   */
  async pivotBranch(taskId: string): Promise<string> {
    const branchId = randomUUID();
    const stmt = this.db.prepare(`
      UPDATE tasks SET current_branch_id = ?, updated_at = ? WHERE id = ?
    `);
    stmt.run(branchId, Date.now(), taskId);
    return branchId;
  }

  /**
   * Save task message
   */
  async saveTaskMessage(message: SaveTaskMessageInput): Promise<void> {
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
  async getMessagesForTask(taskId: string, branchId?: string): Promise<Message[]> {
    let sql = 'SELECT * FROM messages WHERE task_id = ? AND is_archived = 0';
    const params: unknown[] = [taskId];
    
    if (branchId) {
      sql += ' AND branch_id = ?';
      params.push(branchId);
    }
    
    sql += ' ORDER BY created_at ASC';
    
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Array<{
      id: string;
      task_id: string;
      branch_id: string;
      execution_id: string | null;
      sender_id: string;
      content: string;
      payload: string | null;
      is_archived: number;
      created_at: number;
    }>;
    
    return rows.map(row => ({
      id: row.id,
      task_id: row.task_id,
      branch_id: row.branch_id,
      execution_id: row.execution_id ?? undefined,
      sender_id: row.sender_id,
      content: row.content,
      payload: row.payload ?? undefined,
      is_archived: row.is_archived,
      created_at: row.created_at
    }));
  }

  /**
   * Get active messages for task+branch.
   */
  async getActiveMessages(taskId: string, branchId: string): Promise<Message[]> {
    return this.getMessagesForTask(taskId, branchId);
  }

  /**
   * Save lesson learned
   */
  async saveLesson(lesson: {
    id: string;
    task_id: string;
    branch_id: string;
    root_cause: string;
    what_not_to_do: string;
    suggested_alternatives?: string;
    trajectory?: string;
  }): Promise<void> {
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
  async saveLLMExecution(execution: {
    id: string;
    task_id: string;
    agent_name?: string;
    prompt: string;
    thinking?: string;
    status: string;
    usage_prompt_tokens?: number;
    usage_completion_tokens?: number;
    latency_ms?: number;
  }): Promise<void> {
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
  close(): void {
    this.db.close();
  }
}

export default Store;
