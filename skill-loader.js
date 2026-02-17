import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_SCAN = 200;
const DEFAULT_SNIPPET_CHARS = 1200;
const BUILTIN_SKILLS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "default-skills");
const AGENTS_SKILLS_BEGIN = "<!-- AUTO_SKILLS_BEGIN -->";
const AGENTS_SKILLS_END = "<!-- AUTO_SKILLS_END -->";
const EXCLUDED_BUILTIN_SKILLS = new Set(["telegram-manage", "telegram-speak", "toastplan-http-sync"]);

function walkSkillFiles(rootDir, maxScan = DEFAULT_MAX_SCAN, options = {}) {
  if (!rootDir || !fs.existsSync(rootDir)) return [];
  const stack = [path.resolve(rootDir)];
  const files = [];
  const isBuiltin = Boolean(options.isBuiltin);

  while (stack.length && files.length < maxScan) {
    const current = stack.pop();
    if (!current) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (files.length >= maxScan) break;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        if (isBuiltin && EXCLUDED_BUILTIN_SKILLS.has(entry.name)) continue;
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase() === "skill.md") {
        files.push(fullPath);
      }
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

function listSkillRoots(customDir) {
  const roots = [];
  const includeBuiltin = String(process.env.TELEGRAM_INCLUDE_BUILTIN_SKILLS || "true").toLowerCase() !== "false";
  if (includeBuiltin && fs.existsSync(BUILTIN_SKILLS_DIR)) {
    roots.push(path.resolve(BUILTIN_SKILLS_DIR));
  }
  if (customDir && fs.existsSync(customDir)) {
    roots.push(path.resolve(customDir));
  }
  return [...new Set(roots)];
}

function collectSkillFiles(roots, maxScan) {
  const files = [];
  for (const root of roots) {
    const remaining = maxScan - files.length;
    if (remaining <= 0) break;
    const isBuiltin = path.resolve(root) === path.resolve(BUILTIN_SKILLS_DIR);
    files.push(...walkSkillFiles(root, remaining, { isBuiltin }));
  }
  return [...new Set(files)];
}

function readSkillSnippet(filePath, maxChars = DEFAULT_SNIPPET_CHARS) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return raw.replace(/\r\n/g, "\n").trim().slice(0, maxChars);
  } catch {
    return "";
  }
}

function inferDescription(snippet) {
  // 1. Try to parse YAML Frontmatter
  const yamlMatch = snippet.match(/^---\n([\s\S]*?)\n---/);
  if (yamlMatch) {
    const yamlContent = yamlMatch[1];
    const descMatch = yamlContent.match(/description:\s*(.+)$/m);
    if (descMatch) return descMatch[1].trim();
  }

  // 2. Fallback to existing logic
  const line = String(snippet || "")
    .split("\n")
    .map((row) => row.trim())
    .find((row) => row && !row.startsWith("#") && !row.startsWith("---"));
  return line || "";
}

function parseFrontmatter(content) {
  const yamlMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!yamlMatch) return {};
  
  const metadata = {};
  const lines = yamlMatch[1].split("\n");
  for (const line of lines) {
    const [key, ...values] = line.split(":");
    if (key && values.length) {
      metadata[key.trim()] = values.join(":").trim();
    }
  }
  return metadata;
}

function buildCatalog(skillFiles, maxChars) {
  return skillFiles
    .map((filePath) => {
      // Only read the first 2000 chars for metadata parsing
      const snippet = readSkillSnippet(filePath, 2000); 
      if (!snippet) return null;
      
      const dirName = path.basename(path.dirname(filePath));
      const frontmatter = parseFrontmatter(snippet);
      
      const name = frontmatter.name || dirName;
      const description = frontmatter.description || inferDescription(snippet);

      return {
        name,
        path: filePath,
        description,
        // No full snippet loaded initially
      };
    })
    .filter(Boolean);
}

/**
 * Load full skill body by name
 */
export function loadSkillBody(skillPath) {
  try {
    const content = fs.readFileSync(skillPath, "utf-8");
    // Remove frontmatter
    return content.replace(/^---\n[\s\S]*?\n---/, "").trim();
  } catch (e) {
    return "";
  }
}

/**
 * 列出所有已发现的技能（仅元数据）
 */
export function listDiscoveredSkills(options = {}) {
  const skillsDir = options.skillsDir || process.env.TELEGRAM_SKILLS_DIR || "";
  const maxScan = Math.max(20, Number(options.maxScan || process.env.TELEGRAM_MAX_SKILL_SCAN) || DEFAULT_MAX_SCAN);
  // We don't need maxSnippetChars for listing anymore, we just need enough to read frontmatter
  
  const skillRoots = listSkillRoots(skillsDir);
  if (!skillRoots.length) return [];
  const skillFiles = collectSkillFiles(skillRoots, maxScan);
  return buildCatalog(skillFiles, 2000).sort((a, b) => a.name.localeCompare(b.name));
}

export function formatSkillContext(skills = []) {
  if (!Array.isArray(skills) || !skills.length) return "";
  const lines = ["[Dynamic Skills]"];
  for (const skill of skills) {
    lines.push(`- ${skill.name} (${skill.path})`);
    lines.push(skill.snippet);
  }
  return lines.join("\n");
}

