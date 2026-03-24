import fs from 'node:fs';
import path from 'node:path';

export type SkillSchema = {
  name: string;
  description: string;
  entry?: string;
  args?: Record<string, string>;
  when_to_use?: string[];
  when_not_to_use?: string[];
  examples?: Array<{ trigger: string; command: string }>;
  constraints?: string[];
};

export interface DiscoveredSkill {
  name: string;
  description: string;
  entry: string;
  skillPath: string;
  content: string;
  schema?: SkillSchema;
}

export type DiscoverOptions = {
  skillRoots: string[];
  skillBaseDirs: string[];
  cwd: string;
  log?: (message: string) => void;
};

export const DEFAULT_STOPWORDS = [
  '用户要求', '定时', '需要', '获取', '查看', '用户说', '用户要',
  'get', 'use', 'make', 'find', 'set', 'run', 'the', 'for', 'and', 'when', 'how', 'can', 'want', 'need'
];

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveContextPathCandidates(rawPath: string, baseDirs: string[]): string[] {
  if (!rawPath) return [];
  if (path.isAbsolute(rawPath)) return [rawPath];
  const uniqueBaseDirs = [...new Set(baseDirs.map((item) => item.trim()).filter(Boolean))];
  return uniqueBaseDirs.map((baseDir) => path.resolve(baseDir, rawPath));
}

export function resolveSkillRoots(rawRoots: string[], baseDirs: string[]): { existing: string[]; missing: string[] } {
  const existing: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();

  for (const rawRoot of rawRoots) {
    const trimmed = nonEmptyString(rawRoot);
    if (!trimmed) continue;
    const candidates = resolveContextPathCandidates(trimmed, baseDirs);
    const resolved = candidates.find((candidate) => candidate && fs.existsSync(candidate)) || '';
    if (resolved) {
      if (!seen.has(resolved)) {
        seen.add(resolved);
        existing.push(resolved);
      }
    } else if (!missing.includes(trimmed)) {
      missing.push(trimmed);
    }
  }

  return { existing, missing };
}

export function formatSkillPathForPrompt(absPath: string, cwd: string): string {
  const value = nonEmptyString(absPath);
  if (!value) return '';
  if (value.startsWith('/app/')) return value;
  const relative = path.relative(cwd, value);
  if (relative && !relative.startsWith('..')) return relative;
  return value;
}

export function discoverSkills(options: DiscoverOptions): DiscoveredSkill[] {
  const skills: DiscoveredSkill[] = [];
  const seenDirs = new Set<string>();
  const cwd = options.cwd || process.cwd();

  const { existing: resolvedRoots, missing: missingRoots } = resolveSkillRoots(options.skillRoots, options.skillBaseDirs);
  if (missingRoots.length > 0) {
    options.log?.(`[Skills] Skill roots missing roots=${missingRoots.join(',')}`);
  }

  for (const absRoot of resolvedRoots) {
    let entries: string[];
    try {
      entries = fs.readdirSync(absRoot);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const skillDir = path.join(absRoot, entry);
      if (seenDirs.has(skillDir)) continue;
      seenDirs.add(skillDir);

      const schemaPath = path.join(skillDir, 'schema.json');
      const skillMdPath = path.join(skillDir, 'SKILL.md');

      if (fs.existsSync(schemaPath)) {
        let schema: SkillSchema | null = null;
        try {
          const schemaContent = fs.readFileSync(schemaPath, 'utf8');
          schema = JSON.parse(schemaContent) as SkillSchema;
        } catch (e: any) {
          options.log?.(`[Skills] Failed to parse schema.json in ${skillDir}: ${e.message}`);
        }

        if (schema) {
          const relPath = formatSkillPathForPrompt(skillDir, cwd);
          skills.push({
            name: schema.name,
            description: schema.description,
            entry: schema.entry || relPath,
            skillPath: relPath,
            content: JSON.stringify(schema),
            schema
          });
          continue;
        }
      }

      if (!fs.existsSync(skillMdPath)) continue;

      let content: string;
      try {
        content = fs.readFileSync(skillMdPath, 'utf8');
      } catch {
        continue;
      }

      const nameMatch =
        content.match(/^name:\s*(.+)$/m) ||
        content.match(/[*_]{0,2}技能名称[*_]{0,2}\s*[：:]\s*(.+)/m) ||
        content.match(/[*_]{0,2}Skill Name[*_]{0,2}\s*[：:]\s*(.+)/im);
      const descMatch =
        content.match(/^description:\s*(.+)$/m) ||
        content.match(/[*_]{0,2}描述[*_]{0,2}\s*[：:]\s*(.+)/m) ||
        content.match(/[*_]{0,2}Description[*_]{0,2}\s*[：:]\s*(.+)/im);
      const name = nameMatch ? nameMatch[1].trim() : entry;
      const description = descMatch ? descMatch[1].trim() : '';

      const relPath = formatSkillPathForPrompt(skillDir, cwd);
      skills.push({ name, description, entry: relPath, skillPath: relPath, content });
    }
  }

  return skills;
}

export function routeSkillsByPrompt(
  skills: DiscoveredSkill[],
  prompt: string,
  stopwords?: Iterable<string>
): DiscoveredSkill[] {
  const sw = new Set(stopwords ?? DEFAULT_STOPWORDS);
  const promptLower = prompt.toLowerCase();
  return skills.filter((skill) => {
    if (promptLower.includes(skill.name.toLowerCase())) return true;
    if (skill.description && promptLower.includes(skill.description.toLowerCase())) return true;
    if (skill.schema?.when_to_use?.some((trigger) => {
      const triggerLower = trigger.toLowerCase();
      if (promptLower.includes(triggerLower)) return true;
      const keywords = triggerLower
        .replace(/[^a-z\u4e00-\u9fa5\s]/g, ' ')
        .split(/\s+/)
        .filter((k) => k.length >= 2 && !sw.has(k));
      return keywords.length > 0 && keywords.some((kw) => promptLower.includes(kw));
    })) return true;
    return false;
  });
}

export function formatSkillsPrompt(skills: DiscoveredSkill[]): string {
  const lines: string[] = ['[Available Skills]'];

  for (const skill of skills) {
    lines.push('');
    if (skill.schema) {
      const s = skill.schema;
      lines.push(`[Skill: ${s.name}]`);
      lines.push(`Description: ${s.description}`);
      lines.push(`Entry: ${s.entry || skill.skillPath}`);
      if (s.args && Object.keys(s.args).length > 0) {
        lines.push(`Args: ${Object.entries(s.args).map(([k, v]) => `${k} (${v})`).join(', ')}`);
      }
      if (s.when_to_use && s.when_to_use.length > 0) {
        lines.push(`When to use: ${s.when_to_use.join(', ')}`);
      }
      if (s.examples && s.examples.length > 0) {
        lines.push('Examples:');
        for (const ex of s.examples) {
          lines.push(`  - "${ex.trigger}" → ${ex.command}`);
        }
      }
      if (s.constraints && s.constraints.length > 0) {
        lines.push('Constraints:');
        for (const c of s.constraints) {
          lines.push(`  - ${c}`);
        }
      }
    } else {
      lines.push(`[Skill: ${skill.name}]`);
      lines.push(`Description: ${skill.description || '(no description)'}`);
      lines.push(`Path: ${skill.skillPath}`);
    }
  }

  lines.push('');
  lines.push('[End Available Skills]');
  return lines.join('\n');
}
