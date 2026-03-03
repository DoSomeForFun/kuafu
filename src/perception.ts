import { telemetry } from './telemetry.js';
import fs from 'node:fs';
import path from 'node:path';
import type { ContextBlock } from './types.js';

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
  private _allSkills: Skill[] | null;
  private _skillsLoadedAt: number;
  private skillRefreshMs: number;
  private _soul: string | null;
  private _workspace: any | null;

  constructor(config: any = {}) {
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
    blocks?: ContextBlock[];
  }> {
    const span = telemetry.startSpan('Perception.gather');
    
    try {
      const { prompt, task, retrievedContext = [], sessionId, taskId, isSimpleChat } = input;

      // Build blocks array
      const blocks: ContextBlock[] = [];

      // 1. task_goal block - always exists
      blocks.push({
        type: 'task_goal',
        content: prompt,
        source: 'user_input',
        label: 'Task'
      });

      // Simple chat mode - only task_goal block
      if (isSimpleChat) {
        const state = this.observe(sessionId, taskId, task);
        state.isSimpleChat = true;

        return {
          skills: [],
          state,
          workspace: null,
          lessons: [],
          retrievedContext: [],
          blocks
        };
      }

      // 2. system block - if SOUL.md exists
      const soulContent = this._getSoul();
      if (soulContent) {
        blocks.push({
          type: 'system',
          content: soulContent,
          source: 'SOUL.md',
          label: 'System'
        });
      }

      // Skill routing (simplified)
      let skills: Skill[] = [];
      try {
        skills = await this.routeSkills(prompt);
      } catch (e: any) {
        telemetry.warn('[Perception] Skill routing failed', { error: e.message });
        skills = [];
      }

      // 3. skill blocks - one block per matched skill
      for (const skill of skills) {
        blocks.push({
          type: 'skill',
          content: skill.description,
          source: `skill:${skill.name}`,
          label: skill.name
        });
      }

      const state = this.observe(sessionId, taskId, task);
      const workspace = this.observeWorkspace();
      const lessons: any[] = [];

      // 4. retrieved blocks - one block per retrieved context item
      for (const ctx of retrievedContext) {
        blocks.push({
          type: 'retrieved',
          content: String(ctx),
          source: 'retrieved_context'
        });
      }

      return {
        skills,
        state,
        workspace,
        lessons,
        retrievedContext,
        blocks
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
