import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import type { IStore, Message, SaveTaskMessageInput, Task, TaskStatus } from './types.js';

// sqlite-vec is optional — RAG vector features are disabled if it fails to load.
let sqliteVecLoad: ((db: Database.Database) => void) | null = null;
try {
  const sqliteVec = await import('sqlite-vec');
  sqliteVecLoad = sqliteVec.load;
} catch {
  // sqlite-vec not available in this environment — vector features disabled
}

// vec0 virtual table shadow-table suffixes (used to purge stale state during migration)
const VEC0_SHADOW_SUFFIXES = [
  '_chunks', '_rowids', '_info',
  '_metadatachunks00', '_metadatachunks01', '_metadatachunks02', '_metadatachunks03', '_metadatachunks04',
  '_metadatatext00', '_metadatatext01', '_metadatatext02', '_metadatatext03', '_metadatatext04',
  '_vector_chunks00',
];

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

    // Load sqlite-vec extension for vector search (optional — graceful degradation)
    if (sqliteVecLoad) {
      try {
        sqliteVecLoad(this.db);
      } catch (err: any) {
        console.warn('[Store] sqlite-vec load failed:', err?.message || err);
        sqliteVecLoad = null; // disable for this instance
      }
    }

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

    // Apply incremental migrations for older databases
    this._applyMigrations();

    // Set up vec0 virtual tables for vector search (requires sqlite-vec)
    if (sqliteVecLoad) {
      this._initVecTables();
    }
  }

  private _applyMigrations(): void {
    const lessonsInfo = this.db.prepare('PRAGMA table_info(lessons)').all() as { name: string }[];
    if (!lessonsInfo.some(col => col.name === 'trajectory')) {
      this.db.exec('ALTER TABLE lessons ADD COLUMN trajectory TEXT;');
    }

    const tasksInfo = this.db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    if (!tasksInfo.some(col => col.name === 'current_branch_id')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN current_branch_id TEXT;');
    }

    const messagesInfo = this.db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
    if (!messagesInfo.some(col => col.name === 'branch_id')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN branch_id TEXT;');
    }
    if (!messagesInfo.some(col => col.name === 'is_archived')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN is_archived INTEGER DEFAULT 0;');
    }
  }

  /**
   * [Context Anchor]
   * - Intent: Create / migrate vec0 virtual tables for semantic vector search.
   * - Constraints: vec0 uses internal shadow tables (_chunks, _rowids, etc.). If a regular
   *   `context_vectors` table exists from an older schema, a `DROP TABLE` alone is not enough —
   *   stale shadow tables cause `CREATE VIRTUAL TABLE IF NOT EXISTS` to silently no-op, leaving
   *   the virtual table in a corrupt / inconsistent state.
   * - Invariants: After this method returns, `context_vectors` MUST be a valid vec0 virtual table
   *   OR the entire vec0 setup must have been skipped (sqliteVecLoad = null).
   * - Failure Modes: Any error here is caught and logged; RAG features degrade gracefully.
   */
  private _initVecTables(): void {
    try {
      const VEC0_DDL = `
        CREATE VIRTUAL TABLE IF NOT EXISTS context_vectors USING vec0(
          message_id TEXT, task_id TEXT, sender_id TEXT, content TEXT,
          embedding FLOAT[384], created_at TEXT
        );
      `;

      // Determine the current state of the `context_vectors` table
      const existing = this.db.prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'context_vectors'`
      ).get() as { sql: string } | undefined;

      const isVirtualVec0 = existing?.sql?.toUpperCase().includes('USING VEC0') ?? false;
      const isRegularTable = existing !== undefined && !isVirtualVec0;

      if (isRegularTable) {
        // Old regular table — drop it AND all stale shadow tables so that the subsequent
        // CREATE VIRTUAL TABLE is not silently skipped due to leftover shadow state.
        this.db.exec('DROP TABLE IF EXISTS context_vectors');
        for (const suffix of VEC0_SHADOW_SUFFIXES) {
          this.db.exec(`DROP TABLE IF EXISTS context_vectors${suffix}`);
        }
      } else if (isVirtualVec0) {
        // Already a vec0 virtual table — verify it is readable; if corrupt, rebuild.
        try {
          this.db.prepare('SELECT count(*) FROM context_vectors').get();
        } catch {
          // Corrupt vec0 state — drop the virtual table (which cascades to shadow tables)
          // and re-create from scratch.
          this.db.exec('DROP TABLE IF EXISTS context_vectors');
          for (const suffix of VEC0_SHADOW_SUFFIXES) {
            this.db.exec(`DROP TABLE IF EXISTS context_vectors${suffix}`);
          }
        }
      }

      this.db.exec(VEC0_DDL);

      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS lesson_vectors USING vec0(
          lesson_id TEXT, prompt TEXT,
          embedding FLOAT[384]
        );
      `);
    } catch (err: any) {
      console.warn('[Store] vec0 table init failed — vector search disabled:', err?.message || err);
      sqliteVecLoad = null;
    }
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
   * Upsert a vector embedding for semantic search.
   * No-op if sqlite-vec is not loaded or content is too short / sensitive.
   */
  async upsertVector(input: {
    messageId: string;
    taskId: string;
    senderId: string;
    content: string;
    embedding: number[];
    createdAt?: number;
  }): Promise<void> {
    if (!sqliteVecLoad) return;
    const { messageId, taskId, senderId, content, embedding, createdAt } = input;
    if (!embedding?.length) return;
    if (!content || content.length < 3) return;
    if (containsSensitiveContent(content)) return;

    const timestamp = createdAt && createdAt > 0 ? String(createdAt) : String(Date.now());
    try {
      this.db.prepare('DELETE FROM context_vectors WHERE message_id = ?').run(messageId);
      this.db.prepare(`
        INSERT INTO context_vectors(message_id, task_id, sender_id, content, embedding, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(messageId, taskId, senderId, content, JSON.stringify(embedding), timestamp);
    } catch (err: any) {
      throw new Error(`vectors persist failed: ${err?.message || err}`);
    }
  }

  /**
   * Search for semantically relevant messages using KNN on vec0.
   * Returns an empty array if sqlite-vec is not loaded.
   */
  async searchRelevant(input: {
    embedding: number[];
    limit?: number;
    filterByTaskId?: string;
    filterByTaskIds?: string[];
    filterByTaskIdPrefix?: string;
    timeDecayDays?: number;
    minContentLength?: number;
    senderWeightMap?: Record<string, number>;
  }): Promise<Array<{ id: string; taskId: string; senderId: string; content: string; score: number }>> {
    if (!sqliteVecLoad) return [];
    const {
      embedding,
      limit = 5,
      filterByTaskId,
      filterByTaskIds,
      filterByTaskIdPrefix,
      timeDecayDays = 30,
      minContentLength = 3,
      senderWeightMap = {},
    } = input;
    if (!embedding?.length) return [];

    const fetchLimit = Math.max(limit * 3, 20);
    let sql = `
      SELECT message_id, task_id, sender_id, content, distance, created_at
      FROM context_vectors
      WHERE embedding MATCH ? AND k = ?
    `;
    const params: unknown[] = [JSON.stringify(embedding), fetchLimit];

    if (filterByTaskId) { sql += ' AND task_id = ?'; params.push(filterByTaskId); }
    if (filterByTaskIds?.length) {
      sql += ` AND task_id IN (${filterByTaskIds.map(() => '?').join(', ')})`;
      params.push(...filterByTaskIds);
    }
    sql += ' ORDER BY distance ASC';

    let rows: any[];
    try {
      rows = this.db.prepare(sql).all(...params);
    } catch (err: any) {
      throw new Error(`vectors blob read error: ${err?.message || err}`);
    }

    const now = Date.now();
    return rows
      .map((r: any) => {
        if (filterByTaskIdPrefix && !String(r.task_id ?? '').startsWith(filterByTaskIdPrefix)) return null;
        const contentLen = r.content?.length ?? 0;
        if (contentLen < minContentLength) return null;

        let score = 1 / (1 + r.distance);

        // Sender weight
        const sid = String(r.sender_id ?? '');
        for (const [key, weight] of Object.entries(senderWeightMap)) {
          if (sid === key || sid.toLowerCase().startsWith(key.toLowerCase())) {
            if (weight < 1.0) score *= weight;
            break;
          }
        }

        // Time decay
        if (timeDecayDays > 0 && r.created_at) {
          const ageDays = (now - Number(r.created_at)) / (1000 * 60 * 60 * 24);
          score *= 0.3 + 0.7 * Math.exp(-ageDays / timeDecayDays);
        }

        return { id: r.message_id, taskId: r.task_id, senderId: r.sender_id, content: r.content, score };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }
}

export default Store;
