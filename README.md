# @kuafu/framework

> Channel-agnostic Agent Runtime Framework (TypeScript)

A lightweight, embeddable agent runtime with built-in FSM state machine, SQLite persistence, and tool execution. Designed for bots, CLIs, and any channel that needs autonomous agent behavior.

## Why Kuafu?

| Feature | Kuafu | LangChain | AutoGen |
|---------|-------|-----------|--------|
| FSM State Machine | ✅ Built-in | ❌ | ❌ |
| SQLite Persistence | ✅ Native | ❌ | ❌ |
| Bundle Size | ~200KB | 2MB+ | 5MB+ |
| Dependencies | 2 (better-sqlite3, pino) | 50+ | 20+ |

## Install

```bash
npm install @kuafu/framework
```

## Core Concepts

### Kernel (FSM State Machine)
Orchestrates agent execution through 6 states: `PERCEIVING` → `THINKING` → `DECIDING` → `ACTING` → `REFLECTING` → `DONE`. Each state can inject custom handlers.

### Store
SQLite-backed persistence for tasks, messages, and agent turns. Provides `createTask`, `appendMessage`, `getTaskHistory` APIs.

### Action
Tool execution layer. Register custom actions (shell commands, HTTP calls, etc.) and let the agent decide which to invoke.

## Quick Start

```typescript
import { Kernel, Store } from '@kuafu/framework';
import type { LLMCallOptions, LLMCallResult } from '@kuafu/framework';

// 1. 实现 LLM 函数（替换为 OpenAI / Anthropic / 本地模型）
async function myLLM(options: LLMCallOptions): Promise<LLMCallResult> {
  // const res = await openai.chat.completions.create({ ... });
  return { content: 'Hello!', usage: { promptTokens: 10, completionTokens: 5 }, latencyMs: 100 };
}

// 2. 创建 Store + 任务
const store = new Store(':memory:');
await store.createTask({ id: 'task-001', title: 'Demo', date: '2026-01-01' });

// 3. 创建 Kernel，注入 LLM
const kernel = new Kernel({ store, llm: myLLM });

// 4. 执行
const result = await kernel.run({
  taskId: 'task-001',
  prompt: 'What is 1+1?',
  sessionId: 'session-001',
  maxSteps: 5
});

console.log(result.status);  // 'DONE' | 'FAILED'
console.log(result.content);
```

## API Reference

### Kernel constructor

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `store` | `IStore` | ✅ | Storage backend (use `Store` for SQLite) |
| `llm` | `LLMFunction` | ✅ | LLM function `(options) => Promise<LLMCallResult>` |
| `action` | `IAction` | ❌ | Tool executor (use `Action` for shell/file ops) |
| `progressSink` | `IProgressSink` | ❌ | Real-time step progress callback |
| `outcomeSink` | `OutcomeSink` | ❌ | Final result callback |

### Kernel.run(options: KernelRunOptions)

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `taskId` | `string` | ✅ | 任务唯一 ID（需先用 `Store.createTask` 创建） |
| `prompt` | `string` | ✅ | 用户输入 |
| `sessionId` | `string` | ✅ | 会话 ID（同一对话保持一致） |
| `maxSteps` | `number` | ❌ | 最大 FSM 循环步数（默认 30） |
| `maxHistory` | `number` | ❌ | 携带的历史消息条数（默认 10） |
| `agentName` | `string` | ❌ | 代理名称标识 |
| `retrievedContext` | `any[]` | ❌ | 外部检索的上下文块 |
| `progressSink` | `ProgressSink` | ❌ | 实时进度回调 |
| `outcomeSink` | `OutcomeSink` | ❌ | 执行结果回调 |

### Store

- `createTask({ id, title, date, notes? })` → 创建任务
- `getTaskById(taskId)` → 获取任务
- `getMessagesForTask(taskId, branchId?)` → 获取消息历史

### Action

- `bash(command)` → 执行 shell 命令
- `read(filePath)` → 读取文件
- `write(filePath, content)` → 写入文件
- `invokeTool(toolCall)` → 执行工具调用
- `getSpecs()` → 获取可用工具规格列表
