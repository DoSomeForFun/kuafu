---
name: toastplan-http-sync
description: Use this skill when operating ToastPlan via local HTTP endpoints (`/api/tools`, `/api/call`), including task lifecycle sync plus project/outcome/goal create-update operations with executable scripts.
category: integration
tags: [toastplan, http, task, sync]
---

# ToastPlan HTTP Sync Skill

## 适用场景
- 当用户要求“在 ToastPlan 中同步任务状态”。
- 当用户要求“通过 HTTP 调用 ToastPlan 工具”。
- 当用户要求“查看可用工具或参数 schema”。

### Instructions
1. **优先使用脚本**：脚本目录 `/app/skills/toastplan-http-sync/scripts/`。
2. **AI 任务规范**：设置 `isAiActive: true`，标题以 `🤖 [AI]` 开头。
3. **环境适配**：使用 `http://host.docker.internal:42857`。

### Examples
**场景：创建 AI 任务**
User: "创建一个 AI 任务叫 Demo"
Protocol: { "call_tool": { "name": "bash", "arguments": { "command": "./scripts/tp-http-create-ai-task.sh \"🤖 [AI] Demo\" \"2026-02-16\" \"notes...\"" } } }

## 执行约束

- 默认优先使用 `Project Toast Plan`：`d8c64249-4a7a-41ae-9913-9843c4fcd90a`。
- 所有 AI 任务都设置 `isAiActive: true`，标题以 `🤖 [AI]` 开头。
- 每个任务都要有 `date`（`YYYY-MM-DD`）和 `notes`（目标、范围、验收点）。
- 任务流转固定：`create_task` -> `update_task(status=doing)` -> `update_task(status=done)`。
- 若 `42857` 不可达，先读取发现文件；仍失败时必须询问用户端口。

## 0) 最小可执行脚本（优先）

脚本目录：`/app/skills/toastplan-http-sync/scripts/`

> **重要更新**：容器内访问宿主机 ToastPlan 服务时，应使用 `http://host.docker.internal:42857` 而非 `localhost`。所有脚本已适配此配置。

- `tp-http-discover-base-url.sh`
  - 输出当前可用 Base URL（会验证可达性）。
- `tp-http-wait-until-ready.sh`
  - 等待 HTTP 服务就绪：`<timeout_seconds> <interval_seconds>`
- `tp-http-list-tools.sh`
  - 列出全部工具和参数 schema。
- `tp-http-call-tool.sh`
  - 通用调用：`<tool_name> [arguments_json]`
- `tp-http-create-ai-task.sh`
  - 创建 AI 任务：`<title> <date> <notes> [project_id] [outcome_id]`
- `tp-http-create-goal.sh`
  - 创建 Goal：`<title> <year> [description] [color] [priority]`
- `tp-http-update-goal.sh`
  - 更新 Goal：`<goal_id> <updates_json>`
- `tp-http-create-project.sh`
  - 创建 Project：`<title> <year> [description] [category] [color] [linked_goal_id] [is_ai_autonomous]`
- `tp-http-update-project.sh`
  - 更新 Project：`<project_id> <updates_json>`
- `tp-http-create-outcome.sh`
  - 创建 Outcome：`<week_id> <title> [project_ids_json_array] [note] [color] [completed]`
- `tp-http-update-outcome.sh`
  - 更新 Outcome：`<outcome_id> <updates_json>`
- `tp-http-set-task-doing.sh`
  - 更新任务为 `doing`：`<task_id>`
- `tp-http-set-task-done.sh`
  - 更新任务为 `done`：`<task_id> [completed_at_ms]`
- `tp-http-save-task-message.sh`
  - 写任务消息：`<task_id> <sender_id> <content>`
- `tp-http-get-task-messages.sh`
  - 读任务消息：`<task_id>`
- `tp-http-list-runnable-tasks.sh`
  - 拉可执行队列：`[limit] [project_id]`

最小任务流转示例：

```bash
scripts_dir="docs/skills/toastplan-http-sync/scripts"
"${scripts_dir}/tp-http-wait-until-ready.sh" 20 1
"${scripts_dir}/tp-http-create-ai-task.sh" \
  "🤖 [AI] Demo task" \
  "2026-02-11" \
  "Goal: demo, Scope: script test, Acceptance: task created"
"${scripts_dir}/tp-http-set-task-doing.sh" "<task_id>"
"${scripts_dir}/tp-http-set-task-done.sh" "<task_id>"
```

## 1) 发现服务地址

优先级顺序：

1. `http-service-connection.json` 中的 `httpService.baseUrl`
2. `mcp-connection.json` 中的 `mcpServers.toastplan.url`（去掉尾部 `/sse`）
3. 默认 `http://localhost:42857`

```bash
# Option A: new discovery file
cat http-service-connection.json

# Option B: legacy discovery file
cat mcp-connection.json
```

## 2) 健康检查与工具发现

```bash
curl -sS http://localhost:42857/api/tools
```

返回结构：

```json
{
  "tools": [
    {
      "name": "create_task",
      "description": "Create a new task",
      "inputSchema": { "type": "object", "properties": { "title": { "type": "string" } } }
    }
  ]
}
```

## 3) 通用调用模板

```bash
curl -sS -X POST http://localhost:42857/api/call \
  -H "Content-Type: application/json" \
  -d '{
    "name": "create_task",
    "arguments": {
      "title": "🤖 [AI] Example task",
      "date": "2026-02-11",
      "notes": "Goal, scope, acceptance",
      "linkedProjectId": "d8c64249-4a7a-41ae-9913-9843c4fcd90a",
      "isAiActive": true
    }
  }'
```

成功返回：

```json
{ "ok": true, "name": "create_task", "payload": { "success": true, "id": "..." } }
```

失败返回：

```json
{ "ok": false, "error": "..." }
```

## 4) 任务流转标准模板

### 4.1 创建任务（第一步）

```bash
curl -sS -X POST http://localhost:42857/api/call \
  -H "Content-Type: application/json" \
  -d '{
    "name": "create_task",
    "arguments": {
      "title": "🤖 [AI] <task title>",
      "date": "YYYY-MM-DD",
      "notes": "<goal/scope/acceptance>",
      "linkedProjectId": "d8c64249-4a7a-41ae-9913-9843c4fcd90a",
      "isAiActive": true
    }
  }'
```

### 4.2 开始执行（置为 doing）

```bash
curl -sS -X POST http://localhost:42857/api/call \
  -H "Content-Type: application/json" \
  -d '{
    "name": "update_task",
    "arguments": {
      "id": "<task_id>",
      "status": "doing"
    }
  }'
```

### 4.3 完成任务（置为 done）

```bash
curl -sS -X POST http://localhost:42857/api/call \
  -H "Content-Type: application/json" \
  -d '{
    "name": "update_task",
    "arguments": {
      "id": "<task_id>",
      "status": "done",
      "completedAt": 1739212800000
    }
  }'
```

## 5) 常用工具参数速查

- `create_task`
  - 常用参数：`title`, `date`, `notes`, `linkedProjectId`, `linkedOutcomeId`, `isAiActive`, `status`
- `update_task`
  - 常用参数：`id` + 任意可更新字段（如 `status`, `notes`, `assignedAgentId`, `completedAt`）
- `create_goal`
  - 常用参数：`title`, `year`, `description`, `color`, `priority`
- `update_goal`
  - 常用参数：`id`, `updates`
- `create_project`
  - 常用参数：`title`, `year`, `description`, `category`, `color`, `linkedGoalId`, `isAiAutonomous`
- `update_project`
  - 常用参数：`id`, `updates`
- `create_outcome`
  - 常用参数：`weekId`, `title`, `projectIds`, `note`, `completed`, `color`
- `update_outcome`
  - 常用参数：`id`, `updates`
- `list_runnable_tasks`
  - 常用参数：`statuses`, `requireAssignedAgent`, `excludeTaskIds`, `linkedProjectId`, `limit`
- `save_task_message`
  - 常用参数：`taskId`, `senderId`, `content`, `mentionedAgentId`, `payload`
- `get_task_messages`
  - 常用参数：`taskId`

## 6) 建议执行策略

- 每次会话先调用 `/api/tools`，以服务端 schema 为准，不硬编码老参数。
- 对关键写操作使用“探活 + 重试”（例如先 `GET /api/tools` 成功再 `POST /api/call`）。
- 若任务涉及多步骤交付，优先将每一步映射为独立任务并单独流转状态。
- 优先使用脚本目录中的命名脚本，只有脚本不覆盖的场景才直接手写 `curl`。
