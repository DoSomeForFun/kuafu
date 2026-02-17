---
name: skill-creator
description: Guide for creating effective skills. This skill should be used when users want to create a new skill (or update an existing skill) that extends ToastPlan's capabilities with specialized knowledge, workflows, or tool integrations.
metadata:
  short-description: Create or update a skill
---

# Skill Creator

This skill provides guidance for creating effective skills.

## About Skills

Skills are modular, self-contained folders that extend ToastPlan's capabilities by providing
specialized knowledge, workflows, and tools. Think of them as "onboarding guides" for specific
domains or tasks—they transform ToastPlan from a general-purpose agent into a specialized agent
equipped with procedural knowledge that no model can fully possess.

### Skill Location Policy

Place all skills in: `/app/skills/<skill-name>`

### What Skills Provide

1. Specialized workflows - Multi-step procedures for specific domains
2. Tool integrations - Instructions for working with specific file formats or APIs
3. Domain expertise - Business logic, schemas, specialized knowledge
4. Bundled resources - Scripts, references, and assets

## Core Principles

### Concise is Key
Default assumption: ToastPlan is already very smart. Only add context ToastPlan doesn't already have. Prefer concise examples over verbose explanations.

### Progressive Disclosure Design Principle
Skills use a three-level loading system to manage context efficiently:
1. **Metadata (name + description)** - Always in context for routing.
2. **SKILL.md body** - Loaded only when skill triggers.
3. **Bundled resources** - Loaded/Executed as needed.

### Anatomy of a Skill
```
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter metadata (required: name, description)
│   └── Markdown instructions (required)
└── scripts/          - Executable code (Python/Bash/etc.)
```

## Skill Creation Process

1. **Understand**: Research the skill with concrete examples.
2. **Plan**: Identify reusable scripts, references, and assets.
3. **Initialize**: Run the bootstrap script:
   ```bash
   bash /app/skills/skill-creator/scripts/bootstrap.sh <skill-name> "<triggering-description>"
   ```
4. **Edit**: Implement the logic. Added scripts must be tested using `bash`.
5. **Validate**: Self-check that YAML frontmatter exists and instructions are clear.
6. **Iterate**: Improve based on real usage.
