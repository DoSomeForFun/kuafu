---
name: telegram-speak
description: The primary communication tool for the Agent. Use this to send text, stickers, or replies to Telegram chats. Supports multi-bubble messages (sticker + text).
category: telegram
tags: [telegram, speak, reply, message, sticker]
---

# telegram-speak

## Purpose
这是 Agent 的**主要沟通工具（嘴巴）**。
- 当你需要说话、回复、发表情、发长文时，**必须**使用此技能。
- 不要把所有内容塞在最后的 JSON `message` 字段里，那只是给系统的回执。真正的交流发生在这里。

## Capabilities
1. **Send Text**: 支持 MarkdownV2 / HTML。
2. **Send Sticker**: 支持发送静态/动态贴纸。
3. **Send Reaction**: 支持给消息点赞/回应（需要 `reply_to_message_id`）。
4. **Multi-Bubble**: 支持 `Reaction -> Sticker -> Text` 的组合连发。

### Instructions
1. **Reaction First**: 对于简单的确认（如“收到”、“好的”），优先使用 Reaction，这比发废话更高效。
2. **MarkdownV2**: 特殊字符必须转义。
3. **Sticker**: 善用表情包活跃气氛。

### Examples

**场景 1：简单确认 (Reaction Only)**
User: "我到家了" (ID: 100)
Agent Thought: "点个赞就行。"
Protocol: { "call_tool": { "name": "telegram-speak", "arguments": { "reaction": "👍", "reply_to_message_id": "100" } } }

**场景 2：混合回应 (Multi-Bubble)**
User: "这个 Bug 还没修好" (ID: 101)
Agent Thought: "先表示遗憾(Reaction)，再发个哭表情(Sticker)，最后解释原因(Text)。"
Protocol: { "call_tool": { "name": "telegram-speak", "arguments": { "reaction": "😢", "sticker_id": "CAACAgIAAxkBAAI...", "text": "对不起，我马上查！", "reply_to_message_id": "101" } } }


**场景 3：引用回复**
User: "上一条消息说错了" (Message ID: 123)
Agent Thought: "用户纠正了，我引用他的消息确认一下。"
Protocol: { "call_tool": { "name": "telegram-speak", "arguments": { "text": "收到，已忽略上一条。", "reply_to_message_id": "123" } } }
