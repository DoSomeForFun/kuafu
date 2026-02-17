---
name: telegram-manage
description: Manage Telegram messages and chat state (delete, edit, pin, restrict). Use this for administrative tasks, NOT for normal communication.
category: telegram
tags: [telegram, manage, admin, delete, edit]
---

# telegram-manage

## Purpose
这是 Agent 的**管理工具（手）**。
- 用于维护群组秩序、修正错误或执行管理操作。
- **不要**用这个工具来日常聊天（那是 `telegram-speak` 的工作）。

## Capabilities
1. **Delete Message**: 删除指定消息（需要管理员权限）。
2. **Edit Message**: 修改 Bot 自己发出的消息。
3. **Pin Message**: 置顶消息。

### Instructions
1. **慎用删除**: 除非用户明确要求或消息包含敏感信息，否则不要随意删除。
2. **编辑修正**: 如果你发现刚才说错了，可以用 Edit 来修正，而不是发一条新的纠正（除非你想保留历史）。
3. **权限检查**: 确保 Bot 在群组中有相应的管理员权限。

### Examples

**场景 1：删除垃圾消息**
User: "把刚才那条广告删了 (ID: 456)"
Agent Thought: "用户要求管理，调用 delete。"
Protocol: { "call_tool": { "name": "bash", "arguments": { "command": "./bin/deletemessage.sh --chat-id \"$CHAT_ID\" --message-id \"456\"" } } }

**场景 2：修正错误**
User: "你刚才发的那个数据不对"
Agent Thought: "我应该编辑刚才那条消息 (ID: 789) 来修正。"
Protocol: { "call_tool": { "name": "bash", "arguments": { "command": "./bin/editmessage.sh --chat-id \"$CHAT_ID\" --message-id \"789\" --text \"更正后的数据...\"" } } }
