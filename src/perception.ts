import { telemetry } from './telemetry.js';
import fs from 'node:fs';
import path from 'node:path';

const SOUL_CACHE = { data: null as string | null, ts: 0 };
const CACHE_TTL = 30000; // 30 seconds

/**
 * Skill interface
 */
export interface Skill {
  name: string;
  description: string;
  entry: string;
  args?: string;
  argsMode?: string;
  source?: string;
  isBuiltin?: boolean;
}

/**
 * Agent state interface
 */
export interface AgentState {
  sessionId?: string;
  taskId?: string;
  task?: any;
  isSimpleChat?: boolean;
  [key: string]: any;
}

/**
 * Perception Layer - Agent's "awareness"
 */
export class Perception {
  private config: any;
  private store: any;
  private _allSkills: Skill[] | null;
  private _skillsLoadedAt: number;
  private skillRefreshMs: number;
  private _soul: string | null;
  private _workspace: any | null;

  constructor(config: any = {}) {
    this.config = config;
    this.store = config.store || null;
    this._allSkills = null;
    this._skillsLoadedAt = 0;
    this.skillRefreshMs = this._toSafeInt(
      config.skillRefreshMs ?? process.env.AGENT_SKILLS_REFRESH_MS ?? process.env.TELEGRAM_SKILLS_REFRESH_MS,
      3000
    );
    this._soul = null;
    this._workspace = null;
  }

  /**
   * Convert to safe integer
   */
  private _toSafeInt(value: any, fallback: number): number {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  }

  /**
   * Get discovered skills
   */
  private _getSkills(): Skill[] {
    const now = Date.now();
    const expired = now - this._skillsLoadedAt >= this.skillRefreshMs;
    
    if (!this._allSkills || expired) {
      // Simplified: in full implementation, would call listDiscoveredSkills
      this._allSkills = [];
      this._skillsLoadedAt = now;
    }
    
    return this._allSkills || [];
  }

  /**
   * Get soul configuration
   */
  private _getSoul(): string {
    const now = Date.now();
    if (SOUL_CACHE.data !== null && (now - SOUL_CACHE.ts < CACHE_TTL)) {
      return SOUL_CACHE.data;
    }

    try {
      const soul = fs.existsSync('SOUL.md') ? fs.readFileSync('SOUL.md', 'utf-8') : '';
      SOUL_CACHE.data = soul;
      SOUL_CACHE.ts = now;
      return soul;
    } catch (e) {
      return '';
    }
  }

  /**
   * Gather perception data
   */
  async gather(input: {
    prompt: string;
    task?: any;
    retrievedContext?: any[];
    sessionId?: string;
    taskId?: string;
    isSimpleChat?: boolean;
    requestChatCompletion?: any;
    routerTimeoutMs?: number;
  }): Promise<{
    skills: Skill[];
    state: AgentState;
    workspace: any | null;
    lessons: any[];
    retrievedContext: any[];
  }> {
    const span = telemetry.startSpan('Perception.gather');
    
    try {
      const { prompt, task, retrievedContext = [], sessionId, taskId, isSimpleChat } = input;

      // Simple chat mode
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

      // Skill routing (simplified)
      let skills: Skill[] = [];
      try {
        skills = await this.routeSkills(prompt);
      } catch (e: any) {
        telemetry.warn('[Perception] Skill routing failed', { error: e.message });
        skills = [];
      }

      const state = this.observe(sessionId, taskId, task);
      const workspace = this.observeWorkspace();
      const branchId = task?.current_branch_id || task?.currentBranchId || undefined;
      const lessons = await this.readLessons(taskId, branchId);

      return {
        skills,
        state,
        workspace,
        lessons,
        retrievedContext
      };
    } catch (e: any) {
      span.end({ error: e.message });
      throw e;
    } finally {
      span.end();
    }
  }

  /**
   * Observe agent state
   */
  observe(sessionId?: string, taskId?: string, task?: any): AgentState {
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
  observeWorkspace(): any {
    if (this._workspace) {
      return this._workspace;
    }

    // Simplified workspace observation
    this._workspace = {
      cwd: process.cwd(),
      files: []
    };

    return this._workspace;
  }

  async readLessons(taskId?: string, branchId?: string): Promise<any[]> {
    if (!taskId || !this.store || typeof this.store.getLessons !== 'function') {
      return [];
    }
    try {
      return await this.store.getLessons(taskId, branchId, 4);
    } catch (e: any) {
      telemetry.warn('[Perception] Lesson retrieval failed', { error: e.message });
      return [];
    }
  }

  formatToContext(input: { lessons?: any[]; retrievedContext?: any[] }): string {
    const blocks: string[] = [];
    const lessons = Array.isArray(input.lessons) ? input.lessons : [];
    if (lessons.length > 0) {
      const lines = ['## Lessons Learned'];
      for (const lesson of lessons) {
        const rootCause = String(lesson?.root_cause || '').trim();
        const avoid = String(lesson?.what_not_to_do || '').trim();
        const alternative = String(lesson?.suggested_alternatives || '').trim();
        if (rootCause) lines.push(`- Root cause: ${rootCause}`);
        if (avoid) lines.push(`- Avoid: ${avoid}`);
        if (alternative) lines.push(`- Alternative: ${alternative}`);
      }
      blocks.push(lines.join('\n'));
    }
    const retrieved = Array.isArray(input.retrievedContext) ? input.retrievedContext : [];
    if (retrieved.length > 0) {
      const lines = retrieved
        .filter((item) => item?.content)
        .map((item) => {
          const sender = item.senderId || item.sender_id || 'unknown';
          const text = String(item.content).slice(0, 400);
          return `[${sender}]: ${text}`;
        });
      if (lines.length > 0) {
        blocks.push(`## Relevant Context\n${lines.join('\n')}`);
      }
    }
    return blocks.join('\n\n');
  }

  /**
   * Route skills based on prompt (simplified keyword matching)
   */
  async routeSkills(prompt: string): Promise<Skill[]> {
    const skills = this._getSkills();
    const promptLower = prompt.toLowerCase();

    // Simple keyword matching
    const matchedSkills = skills.filter(skill => {
      const nameMatch = promptLower.includes(skill.name.toLowerCase());
      const descMatch = skill.description && promptLower.includes(skill.description.toLowerCase());
      return nameMatch || descMatch;
    });

    return matchedSkills;
  }

  /**
   * Clear workspace cache
   */
  clearWorkspaceCache(): void {
    this._workspace = null;
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    this._allSkills = null;
    this._skillsLoadedAt = 0;
    this._soul = null;
    this._workspace = null;
    SOUL_CACHE.data = null;
    SOUL_CACHE.ts = 0;
  }
}

export default Perception;
