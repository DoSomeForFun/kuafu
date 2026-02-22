# Kuafu

Kuafu is a channel-agnostic agent runtime framework.

It provides a deterministic run loop (`PERCEIVING -> THINKING -> DECIDING -> ACTING -> REFLECTING`), tool execution, progress events, and session isolation helpers for host applications.

Kuafu does not depend on any single IM product. Telegram in this workspace is only a reference adapter.

## v1 Frozen Contracts

The following contracts are frozen in `v1.0.0`:

1. `protocol/events.js` + `protocol/events.ts`
2. `protocol/progress-event.schema.json`
3. `protocol/session-scope.js` + `protocol/session-scope.ts`
4. `host-adapter-sdk.js` + `host-adapter-sdk.ts`

## Runtime Prerequisites

1. Node.js `>=20`
2. A backend object implementing Kuafu store methods (see `store.js`)
3. Host-side identity mapping (`channel`, `conversationId`, `senderId`, `threadId`)
4. Optional progress sink

Minimum backend methods expected by `Kernel`:

1. `getTaskById`
2. `pivotBranch`
3. `getActiveMessages`
4. `saveTaskMessage`
5. `saveExecution`
6. `updateTask`
7. `getLessons` (optional but recommended)

## Quick Start (Host Adapter)

```js
import { Kernel } from "kuafu";
import { Store } from "kuafu/store.js";
import { createHostAdapterRuntime } from "kuafu/host-adapter-sdk.js";

const store = new Store("data/agent-tasks.sqlite");
const kernel = new Kernel({ store });

const runtime = createHostAdapterRuntime({
  kernel,
  progressSink: {
    emit(event) {
      // map ProgressEvent to your host UI/transport
      console.log("[progress]", event.type, event.taskId);
    }
  }
});

const identity = {
  channel: "my-im",
  conversationId: "conv-42",
  senderId: "user-7",
  threadId: "main"
};

const ctx = runtime.buildContext(identity);

if (!(await store.getTaskById(ctx.defaultTaskId))) {
  await store.createTask({
    id: ctx.defaultTaskId,
    title: "Conversation task",
    date: "2026-02-19",
    notes: "Created by host adapter bootstrap."
  });
}

const result = await runtime.run({
  ...identity,
  prompt: "Summarize last context and suggest next steps",
  contextScope: "isolated" // isolated | linked | conversation
});

console.log(result.status, result.message);
```

## Core Run Input

`kernel.run(...)` or `runtime.run(...)` accepts:

1. `taskId` (required by `kernel.run`, auto-derived by `runtime.run`)
2. `prompt` (required)
3. `sessionId` (required by `kernel.run`, auto-derived by `runtime.run`)
4. `contextScope` (`isolated` by default)
5. `agentName`
6. `retrievedContext` (array)
7. `maxSteps`
8. `maxHistory`
9. `progressSink` with signature:
   `progressSink: { emit(event: ProgressEvent): void | Promise<void> }`

## Session Isolation (Required Semantics)

Canonical session scope model:

`channel + conversationId + senderId + threadId`

Use helper instead of hand-rolled keys:

```js
import { buildSessionScopeKey } from "kuafu/protocol/session-scope.js";
```

Default behavior should remain `contextScope=isolated`.
Only widen to `linked` or `conversation` through explicit host intent.

## Progress Protocol (v1)

Event types:

1. `run_started`
2. `step_started`
3. `tool_started`
4. `tool_heartbeat`
5. `tool_finished`
6. `run_finished`
7. `run_failed`

Common fields on every event:

1. `type`
2. `taskId`
3. `sessionId`
4. `ts`
5. `version`
6. `capabilities`

Protocol sources:

1. `protocol/events.ts` (types)
2. `protocol/progress-event.schema.json` (JSON Schema)
3. `progress-events.js` (`normalizeProgressEvent`, `validateProgressEvent`)

## Router and Timeout Env Vars

Preferred router env vars:

1. `KUAFU_ROUTER_MODEL`
2. `KUAFU_ROUTER_BASE_URL`
3. `KUAFU_ROUTER_API_KEY`

Timeout tiers:

1. `KUAFU_ROUTER_TIMEOUT_MS`
2. `KUAFU_TOOL_TIMEOUT_MS`
3. `KUAFU_LLM_TIMEOUT_MS`

Legacy env aliases are still read for compatibility in `routing-config.js`, with deprecation deadlines logged at runtime.

## Skills

Kuafu can execute:

1. Built-in skills under `default-skills/`
2. External/learned skills discovered by `skill-loader.js`

Skill metadata comes from `SKILL.md` frontmatter (`name`, `description`, `entry`, `args_mode`).
This keeps the runtime generic and avoids host-specific tool hardcoding.

## Design Boundaries

Kuafu is responsible for:

1. Execution loop
2. Tool orchestration and retry
3. Progress event emission
4. Store-backed history and execution persistence

Host adapter is responsible for:

1. Inbound message normalization
2. Identity mapping and task lifecycle policy
3. Output delivery UX
4. Platform-specific permission/webhook/rate-limit handling

## Error Classification

Kuafu provides a unified error classification system in `errors.js`:

```js
import { classifyError, ErrorType, isTransientError } from "kuafu/errors.js";

// Classify HTTP errors
const errorType = classifyError(new Error("Too Many Requests"), { status: 429 });
// => "transient_rate_limit"

// Check if error is retryable
if (isTransientError(errorType)) {
  // retry logic
}
```

### Error Types

| Error Type | HTTP Status | Retryable | Description |
|------------|-------------|-----------|-------------|
| `transient_timeout` | 504 | ✅ | Request timed out |
| `transient_network` | - | ✅ | Network connection failed |
| `transient_rate_limit` | 429 | ✅ | Rate limit exceeded |
| `transient_service_unavailable` | 502, 503 | ✅ | Service temporarily unavailable |
| `permanent_not_found` | 404 | ❌ | Resource not found |
| `permanent_auth` | 401 | ❌ | Authentication failed |
| `permanent_forbidden` | 403 | ❌ | Access forbidden |
| `permanent_invalid_input` | 400 | ❌ | Invalid input provided |
| `system` | 500 | ❌ | System error (unexpected) |

## Store - Sender Weight Map

The `searchRelevant()` method supports `senderWeightMap` to adjust message relevance scores based on sender identity:

```js
const results = await store.searchRelevant({
  embedding,
  senderWeightMap: {
    "bot_kuafu": 0.3,  // exact match: only matches "bot_kuafu"
    "bot_": 0.5,       // prefix match: matches "bot_kuafu", "bot_assistant", etc.
    "system_": 0.2,    // prefix match
    "user_vip": 1.0    // exact match, no degradation
  },
  timeDecayDays: 30    // time-based decay
});
```

### Matching Rules

1. **Exact match takes priority** - If sender_id exactly matches a key, that weight is used
2. **Prefix match** - If no exact match, iterate all keys and check `senderId.startsWith(key)` (case-insensitive)
3. **Default weight is 1.0** - No degradation if no match found
4. **Only apply if weight < 1.0** - Weights >= 1.0 are ignored

Examples:
- `senderWeightMap: {"bot_": 0.5}` → "bot_kuafu" gets 0.5, "user_1" gets 1.0
- `senderWeightMap: {"bot_kuafu": 0.3, "bot_": 0.5}` → "bot_kuafu" gets 0.3 (exact match wins)

## Testing

Run tests with:

```bash
npm test
```

Test coverage:
- `__tests__/errors.test.js` - Error classification
- `__tests__/store-sender-weight.test.js` - Sender weight and time decay

