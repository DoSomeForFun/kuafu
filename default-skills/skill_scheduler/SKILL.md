---
name: skill_scheduler
description: Schedule tasks using cron expressions to trigger other skills periodically
category: utility
tags: [cron, schedule, timer]
---

# skill_scheduler

## Purpose
定时任务调度技能。支持复杂周期表达式（如 cron 语法）、灵活调度任意技能（如富文本消息、引用消息等），可作为其他技能的触发器。

### Instructions
1. **Cron 必填**：所有任务必须提供合法的 Cron 表达式。
2. **Skill 绑定**：必须指定目标 Skill 名称。
3. **参数格式**：Params 必须是合法的 JSON 字符串。

### Examples
**场景：每周一提醒**
User: "每周一早上9点提醒我开会"
Protocol: { "call_tool": { "name": "bash", "arguments": { "command": "./schedule_task.sh --cron \"0 9 * * MON\" --skill \"telegram-rich-message\" --params '{\"text\":\"早会提醒\"}'" } } }

## 主要能力
- 支持标准 cron 表达式，自定义周期与时间。
- 可串联调度任意现有 skill，如 skill_orchestrator、telegram-rich-message。
- 定时管理任务注册、删除、列表、暂停、恢复。
- 失败报警与日志。

## 用法概览
1. 登记任务示例
```bash
./schedule_task.sh --cron "0 9 * * MON" --skill "telegram-rich-message" --params '{"chat_id":"676271937","text":"每周一早安提醒！","parse_mode":"MarkdownV2"}'
```
2. 查看当前所有已注册定时任务
```bash
./list_tasks.sh
```
3. 取消/暂停任务
```bash
./remove_task.sh --task-id 1
```

## 场景示例
- 每天固定时间推送富文本/引用消息到群。
- 按照复杂 cron 周期批量多步任务（结合 skill_orchestrator 实现更强链路）。
- 周期性提醒、定点自动播报、周期轮询任务。

---
详细设计与入口脚本开发中。