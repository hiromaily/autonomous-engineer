# Requirements Document

## Introduction

This specification covers the refactoring of the logging system in the `aes` CLI (Autonomous Engineer System). The current logging infrastructure uses several specialized log writers (`DebugLogWriter`, `JsonLogWriter`, `NdjsonImplementationLoopLogger`, etc.) without a unified log level model. This refactoring introduces a unified `ILogger` port interface with structured log levels and color differentiation, ensures key operational events are systematically captured (phases, LLM calls, agent commands, DI resolution), and replaces the `--debug-flow` CLI flag with `--debug`.

---

## Requirements

### Requirement 1: Unified Logger Port Interface

**Objective:** As an engineer, I want a single `ILogger` port interface in the application layer, so that all components use a consistent logging contract rather than ad-hoc writers.

#### Acceptance Criteria

1. The `aes` system shall define an `ILogger` port interface in `application/ports/` with methods for each log level: `debug()`, `info()`, `warn()`, and `error()`.
2. The `ILogger` interface shall accept a message string and an optional structured context object on each method.
3. All components (use cases, services, DI containers) that currently write to `process.stderr` directly or use specialized log writers shall use `ILogger` instead.
4. The `ILogger` implementation shall be provided through the DI container and shall not be constructed inline within business logic.
5. The `aes` system shall have exactly one `ILogger` instance active per run, injected at the composition root.

---

### Requirement 2: Structured Log Levels

**Objective:** As an operator, I want the logging system to support discrete log levels, so that I can control the verbosity of output and filter noise during normal operations.

#### Acceptance Criteria

1. The `aes` logger shall support four log levels: `debug`, `info`, `warn`, and `error`, in ascending severity order.
2. The `aes` logger shall output only log entries at or above the configured log level.
3. The `aes` logger shall default to the `info` level when no explicit level is configured.
4. When a log entry is emitted at `debug` level and the configured level is `info` or higher, the `aes` logger shall suppress the entry silently without side effects.

---

### Requirement 3: Color-Differentiated Log Output

**Objective:** As a developer, I want each log level to render in a distinct color in the terminal, so that I can immediately identify severity at a glance.

#### Acceptance Criteria

1. The `aes` logger shall render `debug` entries in a visually distinct muted color (e.g., gray).
2. The `aes` logger shall render `info` entries in a standard neutral color (e.g., white or default terminal color).
3. The `aes` logger shall render `warn` entries in yellow.
4. The `aes` logger shall render `error` entries in red.
5. If the output target is not a TTY (e.g., piped to a file), the `aes` logger shall omit ANSI color codes and write plain text.

---

### Requirement 4: Configurable Log Level via `configure` Subcommand

**Objective:** As an operator, I want to persist the log level in the `aes` configuration file, so that I do not need to pass a flag on every invocation.

#### Acceptance Criteria

1. When the user runs `aes configure`, the `aes` CLI shall offer an option to set the default log level.
2. The `aes` logger shall read the configured log level from the `aes` configuration file at startup.
3. If no log level is set in the configuration file, the `aes` logger shall default to `info`.
4. When a log level is saved via `aes configure`, subsequent `aes run` invocations shall use that level without requiring a flag.

---

### Requirement 5: `--debug` Flag Replacing `--debug-flow`

**Objective:** As a developer, I want a single `--debug` flag that activates debug-mode behavior, so that the CLI surface is simpler and more intuitive.

#### Acceptance Criteria

1. The `aes run` command shall accept a `--debug` flag in place of the previous `--debug-flow` flag.
2. When `--debug` is passed, the `aes` CLI shall set the active log level to `debug`.
3. When `--debug` is passed, the `aes` CLI shall use the mock LLM provider instead of the real one.
4. The `aes run` command shall no longer accept `--debug-flow`; passing it shall produce an unrecognized flag error.
5. The `--debug-flow-log` flag shall be renamed to `--debug-log`, accepting a file path to write debug-level entries as NDJSON to a file instead of stderr.
6. If `--debug` is not passed, the `aes` CLI shall use the log level from configuration (defaulting to `info`) and the real LLM provider.

---

### Requirement 6: Phase Lifecycle Logging

**Objective:** As a developer, I want the system to log the start and completion of each workflow phase, so that I can trace which phase is actively running during a workflow execution.

#### Acceptance Criteria

1. When a workflow phase begins, the `aes` logger shall emit an `info`-level entry recording the phase name and any relevant identifiers (e.g., spec name).
2. When a workflow phase completes successfully, the `aes` logger shall emit an `info`-level entry recording the phase name and outcome.
3. If a workflow phase fails, the `aes` logger shall emit an `error`-level entry recording the phase name and failure reason.

---

### Requirement 7: LLM Interaction Logging

**Objective:** As a developer, I want each LLM call and its outcome to be logged, so that I can audit the prompts sent and responses received during workflow execution.

#### Acceptance Criteria

1. When the `aes` system sends a prompt to an LLM provider, the `aes` logger shall emit a `debug`-level entry containing the phase, call index, and a truncated prompt preview.
2. When the LLM provider returns a response, the `aes` logger shall emit a `debug`-level entry containing the call index and a summary of the response.
3. If an LLM call fails, the `aes` logger shall emit an `error`-level entry containing the call index, error category, and error message.
4. The `aes` logger shall never emit the full LLM prompt or response at `info` level or above, to avoid cluttering standard output.

---

### Requirement 8: Agent Command Logging

**Objective:** As a developer, I want all commands executed by the agent (git operations, shell scripts) to be logged, so that I can trace the exact operations the agent performed.

#### Acceptance Criteria

1. When the agent executes a git command, the `aes` logger shall emit a `debug`-level entry containing the command and its arguments.
2. When the agent executes a shell script or subprocess, the `aes` logger shall emit a `debug`-level entry containing the command string and working directory.
3. When an agent command completes successfully, the `aes` logger shall emit a `debug`-level entry recording the exit code or result summary.
4. If an agent command exits with a non-zero code, the `aes` logger shall emit a `warn`-level entry containing the command and exit code.
5. If an agent command throws an exception or cannot be started, the `aes` logger shall emit an `error`-level entry containing the command and exception message.

---

### Requirement 9: Dependency Injection Resolution Logging

**Objective:** As a developer, I want the DI container to log each dependency it resolves, so that I can verify that all dependencies are wired correctly and identify unexpected or stub dependencies.

#### Acceptance Criteria

1. When the DI container resolves a dependency, the `aes` logger shall emit a `debug`-level entry naming the resolved type and its concrete implementation.
2. When a stub or mock implementation is used (e.g., mock LLM provider in `--debug` mode), the `aes` logger shall emit an `info`-level entry clearly indicating that a non-production dependency is active.
3. If a required dependency is not resolved (null or undefined where not expected), the `aes` logger shall emit an `error`-level entry identifying the missing dependency.
4. The `aes` logger shall emit DI resolution entries before the workflow begins, so they appear at the top of the log output for each run.

---

### Requirement 10: Pino Integration (Optional)

**Objective:** As an engineer, I want the logging implementation to optionally use the `pino` library, so that the system benefits from structured, high-performance logging without reinventing serialization.

#### Acceptance Criteria

1. Where `pino` is adopted, the `aes` logger shall map `debug`, `info`, `warn`, and `error` levels directly to the corresponding `pino` log levels.
2. Where `pino` is adopted, the `aes` logger shall use `pino`'s built-in pretty-print transport for TTY output and standard NDJSON output for non-TTY targets.
3. Where `pino` is adopted, the `aes` logger interface shall remain the same from the application layer's perspective; the `pino` dependency shall be an implementation detail confined to the `infra/logger/` directory.
4. If `pino` is not adopted, the `aes` logger shall implement equivalent level filtering, color rendering, and NDJSON serialization natively.
