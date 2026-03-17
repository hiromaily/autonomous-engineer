# Requirements Document

## Introduction

The orchestrator-ts codebase has been implemented without major refactoring. Following the DRY (Don't Repeat Yourself) principle, this specification identifies concrete duplication patterns across the codebase and establishes requirements for extracting them into shared utilities and abstractions. The goal is to improve maintainability, reduce inconsistency risk, and make future changes easier to apply uniformly. All refactoring must preserve existing behavior and must not violate the Clean Architecture layer boundaries established in the codebase.

## Requirements

### Requirement 1: Shared File I/O Utility Module

**Objective:** As a developer, I want common file I/O operations extracted into a shared utility module, so that atomic write logic and safe-read patterns are maintained in one place.

#### Acceptance Criteria

1. The shared utility module shall provide an `atomicWrite(destPath: string, content: string): Promise<void>` function that consolidates the duplicate implementations currently in `workflow-state-store.ts`, `plan-file-store.ts`, and `file-memory-store.ts`.
2. When `atomicWrite` is called, the Orchestrator shall write content to a `.tmp` sibling file, call `datasync`, close the file descriptor, and rename the temp file to the final path.
3. The shared utility module shall provide a `readFileSafe(filePath: string): Promise<string | null>` function that consolidates the duplicate safe-read pattern in `file-memory-store.ts` and `plan-file-store.ts`.
4. If a file does not exist when `readFileSafe` is called, the Orchestrator shall return `null` without throwing.
5. If a file read fails for a reason other than `ENOENT`, the Orchestrator shall re-throw the error from `readFileSafe`.
6. The shared utility module shall be placed at `src/infra/utils/fs.ts`.
7. When callers are updated to use the shared utility, the Orchestrator shall preserve all existing runtime behavior observable by their callers.

---

### Requirement 2: Shared Node Error Type Guard

**Objective:** As a developer, I want the `isNodeError` type guard extracted into a single shared location, so that changes to the guard need only be applied once.

#### Acceptance Criteria

1. The shared utility module at `src/infra/utils/errors.ts` shall export an `isNodeError(err: unknown): err is NodeJS.ErrnoException` function.
2. The duplicate `isNodeError` definitions in `workflow-state-store.ts`, `plan-file-store.ts`, `file-memory-store.ts`, and `config-loader.ts` shall each be replaced with an import from `src/infra/utils/errors.ts`.
3. When `isNodeError` is called with a value that is an `Error` instance with a `code` property, the Orchestrator shall return `true`.
4. If `isNodeError` is called with a value that is not an `Error` instance or lacks a `code` property, the Orchestrator shall return `false`.

---

### Requirement 3: Shared Error Message Extraction Utility

**Objective:** As a developer, I want the repeated error-to-string pattern extracted into a named utility function, so that error message extraction is consistent across all infra modules.

#### Acceptance Criteria

1. The shared utility module at `src/infra/utils/errors.ts` shall export a `getErrorMessage(err: unknown): string` function.
2. All occurrences of the inline expression `err instanceof Error ? err.message : String(err)` in `create-run-dependencies.ts`, `file-memory-store.ts`, `claude-provider.ts`, and in the logger files consolidated under `src/infra/logger/` shall be replaced with a call to `getErrorMessage`.
3. When `getErrorMessage` is called with an `Error` instance, the Orchestrator shall return its `.message` property.
4. When `getErrorMessage` is called with a non-`Error` value, the Orchestrator shall return `String(err)`.

---

### Requirement 4: Unified NDJSON Append Logic

**Objective:** As a developer, I want the near-identical NDJSON append patterns in the two logger implementations unified into a shared helper, so that logging behavior is consistent and maintained in one place.

#### Acceptance Criteria

1. A shared helper function `appendNdjsonLine(logPath: string, entry: object): Promise<void>` shall be extracted and placed in `src/infra/utils/ndjson.ts`.
2. When `appendNdjsonLine` is called, the Orchestrator shall create the parent directory of `logPath` recursively if it does not exist, then append the JSON-serialized entry followed by a newline character.
3. `appendNdjsonLine` may throw on filesystem errors; callers are responsible for installing their own error handlers.
4. `NdjsonImplementationLoopLogger` shall replace its `#append` method with a call to the shared helper, retaining its existing error handler.
5. `NdjsonSelfHealingLoopLogger` shall replace its `#append` method with a call to the shared helper, retaining its `writeErrorCount` increment behavior.
6. The public method signatures of both `NdjsonImplementationLoopLogger` and `NdjsonSelfHealingLoopLogger` shall remain unchanged after the refactoring.

---

### Requirement 5: Consolidated LLM Provider Factory

**Objective:** As a developer, I want the duplicated LLM provider selection logic within the bootstrap module consolidated into a single factory function, so that provider instantiation is defined in one place.

#### Acceptance Criteria

1. A `createLlmProvider` factory function shall be extracted within `src/infra/bootstrap/create-run-dependencies.ts`, replacing all inline provider selection expressions.
2. When `createLlmProvider` is called with `debugFlow: true` and a non-null `debugWriter`, the Orchestrator shall return a `MockLlmProvider` instance.
3. When `createLlmProvider` is called without debug mode or with a null `debugWriter`, the Orchestrator shall return a `ClaudeProvider` instance.
4. After the consolidation, provider instantiation logic shall appear in exactly one location within the bootstrap module.

---

### Requirement 6: Behavioral Preservation and Architectural Integrity

**Objective:** As a developer, I want all existing tests to continue passing and architectural layer boundaries to be preserved after the DRY refactoring, so that no regressions or structural violations are introduced.

#### Acceptance Criteria

1. When the refactoring is complete, the Orchestrator shall pass the full test suite (`bun test` from `orchestrator-ts/`) without any new failures.
2. The Orchestrator shall pass TypeScript type checking (`bun run typecheck`) with zero type errors after the refactoring.
3. If a refactoring step introduces a test failure, the Orchestrator shall fix the regression before proceeding to the next step.
4. The shared utility modules (`src/infra/utils/`) shall only be imported by other `src/infra/` modules; `domain/`, `application/`, and `adapters/` layers shall not depend on them.
5. The Orchestrator shall not alter any externally observable behavior — return values, thrown errors, log output, and file formats shall remain identical to pre-refactoring behavior.
6. The architecture linter (`scripts/lint-ts-architecture.sh`) shall report zero violations after the refactoring.

---

### Requirement 7: Logger Consolidation in `src/infra/logger/`

**Objective:** As a developer, I want all logger implementations consolidated under `src/infra/logger/`, so that logger files can import shared infra utilities without violating layer boundaries.

#### Acceptance Criteria

1. A new directory `src/infra/logger/` shall be created to own all logger class implementations.
2. `DebugLogWriter` shall be moved from `src/adapters/cli/debug-log-writer.ts` to `src/infra/logger/debug-log-writer.ts`.
3. `NdjsonImplementationLoopLogger` shall be moved from `src/infra/implementation-loop/ndjson-logger.ts` to `src/infra/logger/ndjson-impl-loop-logger.ts`.
4. `NdjsonSelfHealingLoopLogger` shall be moved from `src/infra/self-healing/ndjson-logger.ts` to `src/infra/logger/ndjson-self-healing-logger.ts`.
5. `AuditLogger` shall be moved from `src/infra/safety/audit-logger.ts` to `src/infra/logger/audit-logger.ts`.
6. All import paths in files that reference the moved logger classes shall be updated to the new paths.
7. The public class interfaces and exported types of all moved loggers shall remain unchanged.
8. `src/infra/logger/` modules shall be permitted to import from `src/infra/utils/` without architecture linter violations.
