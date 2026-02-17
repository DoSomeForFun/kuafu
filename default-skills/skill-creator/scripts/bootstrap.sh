#!/bin/bash
# ToastPlan Skill Bootstrapper
# Usage: bash bootstrap.sh <name> "<description>"

SKILL_NAME=$1
DESCRIPTION=$2
SKILLS_ROOT="/app/skills"

if [ -z "$SKILL_NAME" ] || [ -z "$DESCRIPTION" ]; then
  echo "Usage: $0 <skill-name> <description>"
  exit 1
fi

# Normalize name: lowercase and hyphens
SKILL_NAME=$(echo "$SKILL_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
TARGET_DIR="$SKILLS_ROOT/$SKILL_NAME"

if [ -d "$TARGET_DIR" ]; then
  echo "Error: Skill $SKILL_NAME already exists at $TARGET_DIR"
  exit 2
fi

# 1. Create structure
mkdir -p "$TARGET_DIR/scripts"
mkdir -p "$TARGET_DIR/references"

# 2. Generate SKILL.md with proper YAML frontmatter (ToastPlan Standard)
cat <<EOF > "$TARGET_DIR/SKILL.md"
---
name: $SKILL_NAME
description: $DESCRIPTION
category: uncategorized
tags: [new]
---

# $SKILL_NAME

## Context
(Explain why this skill was created and what problem it solves)

## Usage
(Provide concrete examples of how to use the scripts or logic in this skill)

### Instructions
1. **Rule 1**: ...
2. **Rule 2**: ...

### Examples
**Scenario 1: ...**
User: ...
Response: { ... }
EOF

echo "SUCCESS: Skill $SKILL_NAME scaffolded at $TARGET_DIR"
echo "Next step: Use 'edit' to fill the SKILL.md body and create implementation scripts."
