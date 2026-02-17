---
name: github
description: Integrate common GitHub CLI operations (pull, push, checkout, commit, create PR, etc.)
category: development
tags: [git, github, vcs, code]
---

# github skill

## Purpose
集成所有常见 github CLI 高频操作（拉取 pull、推送 push、签出 checkout、提交 commit、创建分支/PR 等），实现一套统一入口，后续直接 skill 模式快捷调用。

### Instructions
1. **统一入口**：所有操作通过 `gh-wrapper.sh` 调用。
2. **认证前置**：首次使用前需确认已通过 `gh auth login` 登录。

### Examples
**场景：拉取代码**
User: "拉取最新代码"
Protocol: { "call_tool": { "name": "bash", "arguments": { "command": "bash ./gh-wrapper.sh pull" } } }

## 能力举例
- gh auth login: 一次性登录
- gh repo clone [url]
- gh pr create / merge / checkout
- gh issue list / view / close
- gh codespace ...
- gh api 调用（REST/GraphQL）

## 用法（示例）
- bash ./gh-wrapper.sh pull
- bash ./gh-wrapper.sh push
- bash ./gh-wrapper.sh checkout <branch>
- ...

## 扩展说明
如需特殊参数或多仓库、自动化流水线，可后续扩展。

---
主脚本定义：gh-wrapper.sh，统一封装所有 gh cli 子命令逻辑。