# @kuafu/framework

> Channel-agnostic Agent Runtime Framework (TypeScript)

**Requires Node.js ≥ 20**

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


---

## Memory System

kuafu provides a three-layer pluggable memory protocol that gives the Kernel long-term context beyond the current conversation window.

### MemoryProvider Protocol

```typescript
interface MemoryProvider {
  retrieve(query: string, options?: {
    limit?: number;
    sessionId?: string;
    taskId?: string;
    scope?: 'session' | 'global';
  }): Promise<MemoryItem[]>;

  store?(item: MemoryItem): Promise<void>;
}

interface MemoryItem {
  id: string;
  content: string;
  score?: number;           // Relevance 0–1
  source?: string;          // e.g. 'kuafu-facts', 'memox', 'sqlite-history'
  purpose?: 'chat_history' | 'knowledge';
  metadata?: Record<string, unknown>;
}
```

- `purpose: 'chat_history'` → injected as multi-turn messages into the LLM
- `purpose: 'knowledge'` (default) → injected as `<retrieved_memory>` block in system prompt

### Built-in Providers (bridge)

| Provider | Source | Mode |
|---|---|---|
| `BridgeMemoryProvider` | Bridge SQLite (`kuafu_facts` table + chat history) | read + write |
| `MemoxMemoryProvider` | memox SQLite (host, read-only mount) | read-only |
| `CompositeMemoryProvider` | Fan-out to all providers | aggregates |

### kuafu_facts Table

Long-term assistant responses scoped by `chat_id` + `thread_id`. Written by `BridgeMemoryProvider.store()` after each DONE.

```sql
CREATE TABLE kuafu_facts (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  thread_id INTEGER DEFAULT 0,
  task_id TEXT,
  content TEXT NOT NULL,     -- LLM-extracted fact bullets or handoff summary
  tags TEXT DEFAULT '',      -- 'extracted' | 'handoff'
  importance INTEGER DEFAULT 3,  -- 1-5; 5 = handoff/critical
  created_at INTEGER NOT NULL
);
```

### kuafu_traces Table (Verifiable Tape)

Records which memory items were actually injected into each Kernel run. Enables context provenance — debug why the agent responded a certain way.

```sql
CREATE TABLE kuafu_traces (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  session_id TEXT,
  item_count INTEGER DEFAULT 0,
  items TEXT NOT NULL DEFAULT '[]',  -- JSON: [{id, source, purpose, score, preview}]
  created_at INTEGER NOT NULL
);
```

Query traces:
```sql
SELECT task_id, item_count, items, datetime(created_at/1000,'unixepoch') as ts
FROM kuafu_traces ORDER BY created_at DESC LIMIT 10;
```

### Context Budget

`CompositeMemoryProvider` enforces a token budget (default 2000 tokens ≈ 8000 chars) after dedup + priority sort. Override via env:

```bash
KUAFU_CONTEXT_BUDGET_CHARS=12000
```

Priority order: handoff items (tags=handoff) → highest score → insertion order.

### kuafu_actions Table (Tool Execution Provenance)

Records every tool call made during the ACTING FSM state. Together with `kuafu_traces` (memory provenance), forms the complete Verifiable Tape.

```sql
CREATE TABLE kuafu_actions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  session_id TEXT,
  tool_name TEXT NOT NULL,
  tool_args TEXT DEFAULT '{}',    -- JSON: tool call arguments
  tool_result TEXT DEFAULT '{}',  -- JSON: {ok, stdout, stderr, error}
  success INTEGER DEFAULT 1,      -- 1=ok, 0=failed
  duration_ms INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
```

Query recent tool executions:
```sql
SELECT task_id, tool_name, success, duration_ms,
       substr(tool_args, 1, 80) as args_preview,
       datetime(created_at/1000,'unixepoch') as ts
FROM kuafu_actions ORDER BY created_at DESC LIMIT 20;
```

### Complete Verifiable Tape

| Table | Records | Purpose |
|---|---|---|
| `kuafu_traces` | Memory items injected per LLM call | Why did the agent know X? |
| `kuafu_actions` | Tool calls + results per ACTING step | What did the agent actually do? |
| `kuafu_facts` | Extracted facts + handoff summaries | What did the agent learn? |

## Verifiable Tape & Replay Engine

Every LLM call emitted by the Kernel is recorded as a **Tape entry** — a deterministic, content-addressable snapshot containing the full context needed to replay the call.

### What gets recorded

Each trace entry captures:
- `traceId` — unique UUID per LLM call
- `taskId` / `sessionId` — execution context
- `systemPrompt` — stored once per unique content (content-addressable via SHA-256)
- `conversationHistory` — full message history at point of call
- `llmResponse` — the raw model output
- `model` — model identifier
- `stepCount` — which reasoning step triggered this call
- `latencyMs` — wall-clock LLM latency

### Enabling the Tape

Implement the `TraceSink` interface and pass it to the Kernel:

```typescript
import type { TraceSink, TracePayload } from '@kuafu/framework';

const myTraceSink: TraceSink = {
  onTrace(payload: TracePayload): void | Promise<void> {
    // persist to SQLite, S3, stdout — whatever you need
    console.log('trace:', payload.traceId, payload.stepCount);
  }
};

const kernel = new Kernel({ store, llm: myLLM, traceSink: myTraceSink });
```

### Replaying a trace

Given a `traceId`, you can re-run the exact same LLM call and compare outputs:

```typescript
// The payload contains everything needed to reconstruct the call
const payload: TracePayload = await yourStore.getTrace(traceId);

const original = payload.llmResult.content;
const replayed = await myLLM({
  systemPrompt: payload.systemPrompt,
  conversationHistory: payload.conversationHistory,
  prompt: payload.prompt,
});

console.log('same?', original === replayed.content);
```

### Use cases

- **Debugging** — reproduce any agent decision from production
- **Regression testing** — lock a prompt + context, assert output doesn't change after model updates  
- **Prompt auditing** — full audit trail of every LLM call
- **A/B testing** — replay same trace against different models

## Acknowledgements

Kuafu's design is inspired by **[bub](https://github.com/bubbuild/bub)** — a collaborative agent framework built around the principle that context should be explicit, verifiable, and handoff-friendly rather than opaque inherited state.

Key ideas borrowed from bub:
- **Verifiable Tape** — treating every LLM interaction as an auditable, replayable record
- **Channel-neutral execution** — agent behavior that doesn't depend on a specific IM product
- **Explicit context assembly** — reconstructing context from interaction history rather than relying on ambient state

> *"Systems are judged by how well teams can inspect, review, and continue work together."*  
> — [Socialized Evaluation](https://psiace.me/posts/im-and-socialized-evaluation/), the philosophy behind bub

## License

MIT © [DoSomeForFun](https://github.com/DoSomeForFun)
