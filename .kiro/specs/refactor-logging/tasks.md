# Implementation Plan

- [x] 1. Define the unified logger port interface and log level types
- [x] 1.1 Add the ILogger port to the application layer
  - Define the `ILogger` port in `application/ports/logger.ts` with four methods: `debug()`, `info()`, `warn()`, and `error()`
  - Each method accepts a message string and an optional plain-object context parameter
  - The interface must not expose any transport details (stderr, file path, third-party library)
  - All methods must be unconditionally safe — implementations must never throw
  - _Requirements: 1.1, 1.2_

- [x] 1.2 Add the LogLevel type and level comparison utility
  - Define `LogLevel` as a discriminated union of four string literals: `"debug"`, `"info"`, `"warn"`, `"error"`
  - Export an ordered constant array `LOG_LEVEL_ORDER` to support severity comparison
  - Implement `isLevelEnabled(configured, candidate)` returning true when `candidate` is at or above `configured` severity
  - _Requirements: 2.1, 2.2, 2.4, 5.2_

- [x] 2. (P) Implement the ConsoleLogger infrastructure component
- [x] 2.1 (P) Implement level filtering and TTY detection in ConsoleLogger
  - Build `ConsoleLogger` in `infra/logger/` implementing the `ILogger` interface
  - Accept `minLevel: LogLevel` and an optional `isTTY` flag in the constructor
  - Determine TTY status from `process.stderr.isTTY` when the flag is not explicitly provided
  - Silently suppress any log entry whose level is below `minLevel` with no side effects
  - Default log level when none is configured must be `"info"`
  - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [x] 2.2 (P) Implement TTY-aware ANSI color rendering in ConsoleLogger
  - When `isTTY` is true, prefix each output line with the correct ANSI escape code: gray for `debug`, reset/white for `info`, yellow for `warn`, red for `error`; reset color after each line
  - When `isTTY` is false, output plain text in the format `[LEVEL] message { ...context }` with no escape codes
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 3. (P) Implement the ToolContextLogger adapter
  - Create `ToolContextLogger` in `application/services/tools/` implementing the `Logger` interface from `domain/tools/types.ts`
  - Forward successful tool invocations (`Logger.info`) as `ILogger.debug` entries including tool name, input summary, duration, and output size
  - Forward failed invocations with a non-zero exit code or permission denial (`Logger.error`, non-runtime status) as `ILogger.warn`
  - Forward runtime exceptions (`Logger.error`, `resultStatus === "runtime"`) as `ILogger.error`
  - No changes are required to individual git or shell tool implementations — all logging already flows through `ToolExecutor`
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

- [x] 4. (P) Extend the configuration schema and loader to support log level
- [x] 4.1 (P) Add logLevel to the configuration type definitions
  - Add a required `logLevel: LogLevel` field to `AesConfig` — always present after loading, defaulting to `"info"` when absent in the file
  - Add an optional `logLevel?: LogLevel` field to `WritableConfig` — optional so the field can be omitted from the written file
  - _Requirements: 4.1, 4.2, 4.3_

- [x] 4.2 (P) Update ConfigLoader to read and validate logLevel
  - Parse the `logLevel` field from `aes.config.json` when present; supply the default `"info"` when it is absent
  - Reject any value that is not one of the four valid `LogLevel` strings with a `ConfigValidationError` that lists `"logLevel"` in `missingFields`
  - _Requirements: 4.2, 4.3_

- [ ] 5. Wire ILogger through the DI containers and rename the debug CLI flags
- [ ] 5.1 Update RunOptions and DebugLogWriter for the renamed debug fields
  - Rename `debugFlow` → `debug` and `debugFlowLog` → `debugLog` in the `RunOptions` interface
  - Remove the optional `filePath` parameter from `DebugLogWriter`'s constructor; it must always write to `process.stderr` from now on
  - `debugLog` now exclusively routes `ILogger` debug-level output to an NDJSON file, not domain debug events
  - _Requirements: 5.1, 5.5, 5.6_

- [ ] 5.2 Wire ILogger into RunContainer and inject it into all consumers
  - Create exactly one `ConsoleLogger` instance per container, using `"debug"` when the `debug` option is true, otherwise using `config.logLevel`
  - Create exactly one `ToolContextLogger` wrapping the `ConsoleLogger` and supply it as `context.logger` in `ToolContext`
  - Add `logger: ILogger` to the `RunDependencies` return value
  - Inject `ILogger` into `RunSpecUseCase`, `ClaudeProvider`, and `MockLlmProvider` via their constructors
  - Update `ConfigureContainer` in `main/` to inject `ILogger` into `ConfigureCommand`
  - _Requirements: 1.3, 1.4, 1.5, 5.3_

- [ ] 5.3 Rename the debug flags in main/index.ts
  - Remove `--debug-flow`; add `--debug` (boolean, default false)
  - Remove `--debug-flow-log`; add `--debug-log` (string) for routing `ILogger` output to a file
  - Passing `--debug-flow` must produce an unrecognized-flag error via citty
  - Compute the effective log level as `args["debug"] ? "debug" : config.logLevel ?? "info"` and pass it to `RunContainer`
  - Replace `process.stderr.write` calls for operational messages with `ILogger` method calls; retain `process.stderr.write` only for pre-logger errors that occur before `ConfigLoader.load()` succeeds
  - _Requirements: 5.1, 5.2, 5.4, 5.6_

- [ ] 6. (P) Instrument operational log call sites
- [ ] 6.1 (P) Add phase lifecycle logging to RunSpecUseCase
  - Inject `ILogger` into `RunSpecUseCase`'s constructor options alongside existing ports
  - Emit an `info`-level entry when a workflow phase begins, with `{ phase, specName }` in the context object
  - Emit an `info`-level entry when a phase completes successfully, with `{ phase, outcome }` in the context
  - Emit an `error`-level entry when a phase fails, with `{ phase, reason }` in the context
  - _Requirements: 6.1, 6.2, 6.3_

- [ ] 6.2 (P) Add LLM interaction logging to ClaudeProvider and MockLlmProvider
  - Inject `ILogger` via the constructor in both providers
  - Emit a `debug`-level entry before each LLM call with `{ phase, callIndex, promptPreview }` where the prompt preview is truncated to the first 500 characters
  - Emit a `debug`-level entry after each successful response with `{ callIndex, responseSummary }`
  - Emit an `error`-level entry on failure with `{ callIndex, errorCategory, errorMessage }`
  - Never log the full prompt or response at `info` level or above
  - _Requirements: 7.1, 7.2, 7.3, 7.4_

- [ ] 7. (P) Add log level selection to the aes configure wizard
  - Add a `selectLogLevel()` interactive step to `ConfigWizard` presenting exactly the four valid log levels as selectable choices (no free-text input)
  - Persist the chosen level via `IConfigWriter.write()` with the `logLevel` field set
  - Verify that subsequent `aes run` invocations read and apply the persisted level without requiring a runtime flag
  - _Requirements: 4.1, 4.4_

- [ ] 8. (P) Emit DI resolution log entries from RunContainer.build()
  - Emit a `debug`-level entry for each resolved dependency naming the type and its concrete implementation
  - Emit an `info`-level entry whenever a mock or stub is substituted for a production dependency (e.g., mock LLM provider active in `--debug` mode)
  - Emit an `error`-level entry if a required dependency resolves to null or undefined where that is not expected
  - Ensure all DI resolution entries are emitted before the use case is invoked so they appear at the top of the log output for each run
  - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [ ] 9. Write unit and integration tests
- [ ] 9.1 (P) Unit tests for ConsoleLogger and isLevelEnabled
  - Verify that entries below `minLevel` are suppressed and entries at or above are emitted
  - Verify all 16 combinations of `(configured, candidate)` level pairs in `isLevelEnabled`
  - Verify ANSI escape codes are present when `isTTY` is true and absent when `isTTY` is false
  - Verify the correct color code is applied for each log level (`debug` → gray, `info` → reset, `warn` → yellow, `error` → red)
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5_

- [ ] 9.2 (P) Unit tests for ConfigLoader log level handling
  - Verify that `logLevel` is parsed and returned correctly from `aes.config.json`
  - Verify the default value `"info"` is returned when the `logLevel` field is absent from the file
  - Verify that a `ConfigValidationError` is thrown when `logLevel` contains an invalid string value
  - _Requirements: 4.2, 4.3_

- [ ] 9.3 Integration tests for the full logging pipeline
  - Verify `RunContainer.build()` returns a `ConsoleLogger` instance as `RunDependencies.logger`
  - Verify that when `debug: true` the effective log level is `"debug"` and the mock LLM provider is active
  - Verify DI resolution log entries are emitted before the use case is invoked
  - Verify the `aes configure` wizard saves `logLevel` and `ConfigLoader.load()` returns it on next startup
  - Verify that passing `--debug-flow` via the CLI produces a non-zero exit code with an unrecognized-flag error
  - _Requirements: 1.4, 1.5, 4.1, 4.4, 5.1, 5.3, 5.4, 9.1, 9.2, 9.3, 9.4_

---

## Requirements Coverage

| Requirement | Tasks |
|-------------|-------|
| 1.1–1.2 | 1.1 |
| 1.3–1.5 | 5.2 |
| 2.1–2.4 | 1.2, 2.1 |
| 3.1–3.5 | 2.2 |
| 4.1–4.4 | 4.1, 4.2, 7 |
| 5.1–5.6 | 5.1, 5.2, 5.3 |
| 6.1–6.3 | 6.1 |
| 7.1–7.4 | 6.2 |
| 8.1–8.5 | 3 |
| 9.1–9.4 | 8 |
| 10.4 | 2.1, 2.2 (native implementation satisfies this criterion) |

> **Requirement 10 note**: Req 10.1–10.3 are conditional on pino adoption ("Where pino is adopted…"). Per the design non-goals, mandatory pino adoption is explicitly out of scope. Req 10.4 ("If pino is not adopted, implement equivalent filtering, color rendering, and NDJSON serialization natively") is fully satisfied by Tasks 2.1 and 2.2. A pino-based `PinoLogger` variant can be added as a future enhancement confined to `infra/logger/` without altering the `ILogger` contract.
