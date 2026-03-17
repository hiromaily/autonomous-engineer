# Research & Design Decisions

---
**Purpose**: Capture discovery findings, architectural investigations, and rationale that inform the technical design.

---

## Summary

- **Feature**: `refactor-logging`
- **Discovery Scope**: Extension — modifying an existing system to introduce unified logging
- **Key Findings**:
  - Four specialized logger classes (`DebugLogWriter`, `JsonLogWriter`, `NdjsonImplementationLoopLogger`, `NdjsonSelfHealingLoopLogger`) exist in `infra/logger/` with no shared `ILogger` port in `application/ports/`
  - `process.stderr` is written to directly in `src/main/index.ts` and `RunContainer.build()` bypassing any future logger abstraction
  - The `--debug-flow` flag currently bundles LLM mock, gate auto-approval, and debug event emission; the refactoring separates "debug mode" into `--debug` while isolating the new `--debug-log` file-path flag

## Research Log

### Existing Logger Inventory

- **Context**: Need to understand what logging infrastructure already exists before designing the unified `ILogger` port.
- **Sources Consulted**: Direct file inspection of `orchestrator-ts/src/infra/logger/` and `application/ports/logging.ts`, `application/ports/debug.ts`
- **Findings**:
  - `IDebugEventSink` (in `application/ports/debug.ts`) handles structured `DebugEvent` objects for LLM call tracing — unrelated to general log levels
  - `IJsonLogWriter` (in `application/ports/logging.ts`) handles workflow event NDJSON to file — also unrelated to general log levels
  - `NdjsonImplementationLoopLogger` and `NdjsonSelfHealingLoopLogger` write domain-specific NDJSON logs; these are domain audit logs, not operational logs
  - No `ILogger` port exists anywhere in `application/ports/`
  - `process.stderr.write(...)` is used directly in `src/main/index.ts` for config errors, debug-flow messages, and warning messages
  - `RunContainer.build()` uses `process.stderr.write(...)` for log-writer error warnings
- **Implications**: `ILogger` is a greenfield addition to `application/ports/`. Existing specialized loggers remain unchanged (they serve different purposes). Operational log calls currently in `src/main/index.ts` and the container will migrate to `ILogger`.

### CLI Flag Audit

- **Context**: Requirement 5 renames `--debug-flow` to `--debug` and `--debug-flow-log` to `--debug-log`.
- **Sources Consulted**: `src/main/index.ts` (runCommand args definition)
- **Findings**:
  - `--debug-flow` (boolean): triggers mock LLM, auto-approved gates, debug event emission
  - `--debug-flow-log` (string): file path for NDJSON debug events; falls back to stderr if absent
  - `--log-json` (string): workflow event NDJSON file path (unrelated, kept as-is)
- **Implications**: Remove `--debug-flow` and `--debug-flow-log`; add `--debug` (boolean) and `--debug-log` (string). Internal `RunOptions` fields rename accordingly (`debugFlow` → `debug`, `debugFlowLog` → `debugLog`).

### Config Persistence for Log Level

- **Context**: Requirement 4 requires log level to be persisted in the `aes` config file.
- **Sources Consulted**: `application/ports/config.ts`, `infra/config/config-loader.ts` (existence confirmed via imports in `run-container.ts`)
- **Findings**:
  - `WritableConfig` and `AesConfig` do not contain a `logLevel` field yet
  - `ConfigLoader` reads from `aes.config.json`; adding `logLevel` is additive and backward-compatible (defaults to `"info"` when absent)
  - `ConfigureCommand` / `ConfigWizard` will need a new prompt step for log level selection
- **Implications**: Extend `WritableConfig`, `AesConfig` with optional `logLevel?: LogLevel`. `ConfigLoader` sets default `"info"` when field is absent. `ConfigureCommand` adds a log-level selection step.

### Architecture Linter Boundaries

- **Context**: Previous refactoring (`refactoring-dry`) established `infra/logger/` and registered it in the architecture linter. Need to confirm `ILogger` placement does not violate boundaries.
- **Sources Consulted**: `orchestrator-ts/scripts/lint-ts-architecture.sh` (knowledge from session context)
- **Findings**:
  - `application/ports/` is the correct layer for `ILogger` — all existing ports follow this pattern
  - `infra/logger/` is the correct layer for the concrete implementation (`ConsoleLogger`)
  - `main/` (composition root) may import from all layers; logger injection happens here
- **Implications**: `ILogger` goes in `application/ports/logger.ts`. Concrete implementations in `infra/logger/`. No linter violations expected.

### Pino vs Native Implementation

- **Context**: Requirement 10 makes pino adoption optional.
- **Sources Consulted**: Pino documentation knowledge; project steering (no monolithic frameworks, Bun runtime)
- **Findings**:
  - Pino v9.x works with Bun (Node.js-compatible streams)
  - `pino-pretty` provides TTY color output; standard output is NDJSON
  - Native implementation with `process.stderr.isTTY` and ANSI codes covers requirements without a dependency
  - Native approach avoids adding an external dependency to a project that prefers minimal deps
- **Implications**: Design will support both paths via the same `ILogger` interface. Native implementation is the default; pino is documented as an optional variant. This design covers the native implementation.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Unified ILogger Port | Single `ILogger` in `application/ports/` with level-based methods | Clean separation, one injection point, testable | All callers must be updated | Aligns with hexagonal architecture |
| Per-Layer Logger Ports | Separate logger ports per use-case domain | Fine-grained control | Over-engineering; violates DRY | Rejected |
| Direct console usage | Keep `process.stderr` calls as-is but add colors | Zero changes to ports | Not injectable; not testable; no level filtering | Rejected |

## Design Decisions

### Decision: Single `ILogger` Port in `application/ports/`

- **Context**: Multiple components write to stderr directly or use specialized writers; there is no unified log-level concept
- **Alternatives Considered**:
  1. Extend `IDebugEventSink` to handle general logging — pollutes debug-specific interface
  2. Use a separate logger per layer — fragmentation, harder DI wiring
- **Selected Approach**: Define `ILogger` in `application/ports/logger.ts`; inject via `RunContainer`; implement in `infra/logger/console-logger.ts`
- **Rationale**: Consistent with existing port pattern; single injection point; testable by mock injection
- **Trade-offs**: All call sites that use `process.stderr.write` for operational messages must be updated
- **Follow-up**: Validate that no domain layer files import `process` directly

### Decision: Log Level as Discriminated Union

- **Context**: Requirement 2 defines four discrete levels; TypeScript strict mode mandates type safety
- **Alternatives Considered**:
  1. `string` type — allows invalid values
  2. `enum` — works but verbose in comparisons
- **Selected Approach**: `type LogLevel = "debug" | "info" | "warn" | "error"`; numeric comparison via ordered array
- **Rationale**: Idiomatic TypeScript; no runtime overhead; readable
- **Trade-offs**: None significant
- **Follow-up**: Export `LOG_LEVEL_ORDER` constant array for level comparisons

### Decision: TTY Detection for Color Output

- **Context**: Requirement 3.5 — no ANSI codes when output is not a TTY
- **Alternatives Considered**:
  1. Always emit ANSI — breaks file redirection
  2. External library (chalk, kleur) — extra dependency
- **Selected Approach**: Check `process.stderr.isTTY` at construction time; store as `readonly` field; apply ANSI codes conditionally
- **Rationale**: Zero dependencies; standard Node.js/Bun API; correct by design
- **Trade-offs**: Color detection is static at startup (not dynamic per write)
- **Follow-up**: Verify Bun's `process.stderr.isTTY` behavior

### Decision: Rename `--debug-flow` to `--debug` and `--debug-flow-log` to `--debug-log`

- **Context**: Requirement 5; `--debug-flow` is a compound concept; `--debug` is simpler and more intuitive
- **Alternatives Considered**:
  1. Keep `--debug-flow` as alias — backwards compatibility, but pollutes CLI surface
  2. Hard remove — breaking change but clean interface
- **Selected Approach**: Hard remove `--debug-flow` and `--debug-flow-log`; replace with `--debug` and `--debug-log`
- **Rationale**: CLI is internal tooling; breaking change is acceptable; requirement 5.4 explicitly prohibits `--debug-flow`
- **Trade-offs**: Any existing scripts using `--debug-flow` break
- **Follow-up**: Search for any CI or test scripts using `--debug-flow` and update them

## Risks & Mitigations

- **Risk**: Some application/domain layer code may call `process.stderr` directly — these must be identified and migrated to `ILogger` — **Mitigation**: Grep for `process.stderr` in `src/` and update all occurrences before implementation
- **Risk**: Adding `logLevel` to `AesConfig` may break existing serialized config files — **Mitigation**: Treat `logLevel` as optional with default `"info"` in `ConfigLoader`; backward compatible
- **Risk**: Pino's async transport model (worker thread) may conflict with Bun's runtime — **Mitigation**: Native implementation is the primary design; pino is optional and can be deferred

## References

- [Pino documentation](https://getpino.io) — v9 API and transport configuration
- [Node.js process.stderr.isTTY](https://nodejs.org/api/process.html#processstderrttylevel) — TTY detection API
- Hexagonal Architecture (Ports & Adapters) — project steering `tech.md`
- DI container rules — `.claude/rules/di.md`
