# Contributing to @kuafu/framework

Thank you for your interest in contributing!

## Development Setup

```bash
# Clone the repo
git clone https://github.com/DoSomeForFun/kuafu.git
cd kuafu/packages/kuafu-framework

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Type check
npm run typecheck
```

## Project Structure

```
packages/kuafu-framework/
├── src/
│   ├── kernel/       # FSM state machine + LLM orchestration
│   ├── store/        # SQLite-backed persistence
│   ├── action/       # Tool execution layer
│   ├── telemetry/    # Logging + tracing
│   └── types.ts      # Public type exports
├── dist/             # Built output (do not edit)
└── tests/            # Node.js built-in test runner tests
```

## Pull Request Guidelines

- **One concern per PR** — don't mix refactor + feature in the same PR
- **Tests required** — all new behavior must have tests in `tests/`
- **No breaking changes without major version bump**
- Run `npm run build && npm test` before submitting

## Commit Message Format

```
<type>(<scope>): <short description>

Types: feat | fix | refactor | test | chore | docs
Scope: kernel | store | action | telemetry | types | build

Examples:
  feat(kernel): add traceSink support for LLM call recording
  fix(store): handle concurrent writes with WAL mode
  docs(readme): add Replay Engine usage section
```

## Testing

Tests use Node.js built-in test runner (no additional test framework needed):

```bash
npm test
# or run a specific file:
node --test tests/kernel.test.js
```

## Releasing

Releases are managed via Git tags. Push a `v*` tag to trigger the npm publish workflow:

```bash
git tag v1.3.0
git push origin v1.3.0
```
