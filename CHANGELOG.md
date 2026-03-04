# Changelog

All notable changes to `@kuafu/framework` will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/). This project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-03-04

### Initial Open Source Release

#### Core Framework
- **Kernel** — FSM state machine orchestrating agent execution through 6 states: `PERCEIVING → THINKING → DECIDING → ACTING → REFLECTING → DONE`
- **Store** — SQLite-backed persistence via `better-sqlite3` for tasks, messages, and agent turns
- **Action** — Tool execution layer with custom action registration
- **Telemetry** — `pino`-based structured logging

#### Verifiable Tape & Replay Engine
- `TraceSink` interface — fire-and-forget hook called after every LLM call
- `TracePayload` — complete context snapshot per LLM call: `systemPrompt`, `conversationHistory`, `llmResult`, `model`, `stepCount`, `latencyMs`
- Content-addressable system prompt storage (SHA-256 dedup)
- Deterministic context assembly — every trace carries enough context to fully replay the call
- `LLMCallResult.model` field added for model tracking

#### Public API Exports
- `@kuafu/framework` — `Kernel`, `Store`, all types
- `@kuafu/framework/kernel` — kernel-only import
- `@kuafu/framework/action` — action layer
- `@kuafu/framework/store` — store layer
- `@kuafu/framework/telemetry` — telemetry utilities
