# Implementation Plan

- [ ] 1. Create shared infrastructure utility modules
- [x] 1.1 (P) Implement shared error utility functions
  - Create the `infra/utils/errors.ts` module with zero external dependencies
  - Implement a type guard that narrows an unknown caught value to a Node.js errno exception — identical behavior to the four existing private copies
  - Implement an error-message extractor that returns the `.message` string for Error instances and falls back to `String()` for all other values
  - Write unit tests: verify correct narrowing for errno errors, plain errors, and non-error values; verify message extraction for both branches
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4_

- [x] 1.2 (P) Implement shared file I/O utility functions
  - Create the `infra/utils/fs.ts` module importing only Node.js built-in fs/promises
  - Implement an atomic write operation: write content to a temp sibling file, call datasync, close the file descriptor, then rename to the destination — creating parent directories automatically
  - Implement a safe file read that returns null for missing files (ENOENT) and re-throws all other errors
  - Write unit tests: verify atomic write produces correct content and removes the temp file; verify safe read returns null when file is absent and re-throws on permission errors
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7_

- [x] 1.3 (P) Implement shared NDJSON append utility
  - Create the `infra/utils/ndjson.ts` module importing only Node.js built-in fs/promises
  - Implement an async function that accepts a log path and an object entry, creates the parent directory if it does not exist, and appends a JSON-serialized line followed by a newline
  - The function propagates filesystem errors to the caller rather than swallowing them; each logger installs its own error handler
  - Write unit tests: verify a line is appended in correct NDJSON format; verify the parent directory is created when absent; verify the function rejects on simulated write failure
  - _Requirements: 4.1, 4.2, 4.3_

- [ ] 2. Consolidate all logger classes under infra/logger/
- [x] 2.1 (P) Move DebugLogWriter from the CLI adapter layer to infra/logger/
  - Create the `src/infra/logger/` directory and move `DebugLogWriter` into it as the first resident file
  - Update its internal error-handling expression to use the shared error-message extractor from the error utilities module (Task 1.1)
  - Update every import reference to `DebugLogWriter` across the codebase to point to the new location
  - Verify the file compiles cleanly and that debug-log write behavior is unchanged
  - _Requirements: 3.2, 7.1, 7.2, 7.6, 7.7_

- [x] 2.2 (P) Move NdjsonImplementationLoopLogger to infra/logger/
  - Relocate the implementation-loop NDJSON logger file into `src/infra/logger/`
  - Update every import reference to this logger across the codebase
  - The sync I/O methods (`mkdirSync`, `appendFileSync`) will be replaced in Task 4 — this step is a pure file move only
  - _Requirements: 7.3, 7.6, 7.7_

- [x] 2.3 (P) Move NdjsonSelfHealingLoopLogger to infra/logger/
  - Relocate the self-healing NDJSON logger file into `src/infra/logger/`
  - Update every import reference to this logger across the codebase
  - The async append logic will be updated in Task 4 — this step is a pure file move only
  - _Requirements: 7.4, 7.6, 7.7_

- [x] 2.4 (P) Move AuditLogger to infra/logger/
  - Relocate the audit logger file from `infra/safety/` into `src/infra/logger/`
  - Update every import reference to `AuditLogger` (in `create-safety-executor.ts` and any other consumers)
  - `AuditLogger` uses append-open mode with datasync — its internal I/O logic is not changed by this move
  - _Requirements: 7.5, 7.6, 7.7_

- [x] 2.5 Update all consumer import paths after logger moves
  - Verify every file that previously imported from `adapters/cli/debug-log-writer`, `infra/implementation-loop/ndjson-logger`, `infra/self-healing/ndjson-logger`, and `infra/safety/audit-logger` now imports from the corresponding `infra/logger/` paths
  - Run TypeScript compilation to confirm zero broken import errors
  - _Requirements: 7.6, 7.8_

- [ ] 3. Replace duplicate utility code in infrastructure stores and modules
- [ ] 3.1 (P) Update the workflow state store to use shared utilities
  - Replace the inline atomic write implementation in `WorkflowStateStore` with the shared atomic write function (the separate directory-creation call is absorbed into the shared utility)
  - Replace the inline Node error type guard with an import from the shared error utilities module
  - Run existing store round-trip tests to confirm persist/restore behavior is unchanged
  - _Requirements: 1.1, 1.2, 1.7, 2.1, 2.2_

- [ ] 3.2 (P) Update the plan file store to use shared utilities
  - Replace the private `atomicWrite` method in `PlanFileStore` with the shared atomic write function
  - Replace the private safe-read pattern in the `load` method with the shared safe-read function
  - Replace the private Node error type guard with an import from the shared error utilities module
  - Run existing plan store round-trip tests to confirm save/load behavior is unchanged
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.7, 2.1, 2.2_

- [ ] 3.3 (P) Update the file memory store to use shared utilities
  - Replace the private `atomicWrite` method with the shared atomic write function
  - Replace the private safe-read helper with the shared safe-read function, coercing its `null` return to an empty string at the call site
  - Replace the private Node error type guard with an import from shared error utilities
  - Replace the inline error-message extraction expression with the shared extractor function
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.7, 2.1, 2.2, 3.1, 3.2_

- [ ] 3.4 (P) Update the config loader to use the shared error type guard
  - Replace the file-local `isNodeError` definition with an import from the shared error utilities module
  - Confirm ENOENT handling for missing config files remains correct after the change
  - _Requirements: 2.1, 2.2_

- [ ] 3.5 (P) Update the Claude LLM provider to use the shared error extractor
  - Replace the inline error-message extraction expression in the provider with a call to the shared extractor
  - _Requirements: 3.1, 3.2_

- [ ] 4. Update logger classes to use shared NDJSON and error utilities
- [ ] 4.1 (P) Migrate NdjsonImplementationLoopLogger from sync to async append
  - Replace the synchronous `mkdirSync` + `appendFileSync` call in the `#append` method with the shared async NDJSON append function (Task 1.3)
  - Attach an error handler that logs failures to console, preserving the existing failure-logging behavior
  - Verify that log entries appear in the output file and that the logger's public interface is unchanged
  - _Requirements: 4.4, 4.6_

- [ ] 4.2 (P) Update NdjsonSelfHealingLoopLogger to use shared append
  - Replace the inline `mkdir` + `appendFile` chain in the `#append` method with the shared async NDJSON append function (Task 1.3)
  - Attach an error handler that increments `writeErrorCount`, preserving the diagnostic counter semantics
  - Verify that `writeErrorCount` increments correctly when a write fails
  - _Requirements: 4.5, 4.6_

- [ ] 5. (P) Refactor the bootstrap dependency factory
  - Define the LLM provider factory closure once in the `createRunDependencies` function, before the implementation-loop LLM is assigned
  - Assign the implementation-loop LLM by calling the factory with no provider override, removing the second inline debug-condition ternary
  - Replace the inline error-message extraction expression in the event-bus error handler with the shared extractor from the error utilities module
  - Confirm provider selection (mock vs real) is correct in both debug and production modes
  - _Requirements: 3.2, 5.1, 5.2, 5.3, 5.4_

- [ ] 6. Register infra/logger/ in the architecture linter
  - Add an allowlist rule for `src/infra/logger/` to the architecture linting shell script, permitting imports from `infra/utils/`, `application/ports/`, and `domain/`, while denying imports from `application/usecases/`, `application/services/`, and `adapters/`
  - Run the architecture linter and confirm zero violations for the new directory and all modified callers
  - _Requirements: 6.4, 6.6, 7.8_

- [ ] 7. Integration verification
- [ ] 7.1 Run the full test suite and fix regressions
  - Execute `bun test` from the `orchestrator-ts/` directory
  - Investigate and fix any test failures introduced by the refactoring before proceeding
  - _Requirements: 6.1, 6.3, 6.5_

- [ ] 7.2 (P) Run TypeScript type checking and fix errors
  - Execute `bun run typecheck` from the `orchestrator-ts/` directory
  - Resolve any type errors caused by changed import paths, coerced null returns, or updated function signatures
  - _Requirements: 6.2_

- [ ] 7.3 (P) Run the architecture linter and verify zero violations
  - Execute `bash scripts/lint-ts-architecture.sh` and confirm no violations remain
  - Confirm that `infra/utils/` is not imported by `domain/`, `application/`, or `adapters/` layers
  - Confirm that `infra/logger/` files do not import from prohibited layers
  - _Requirements: 6.4, 6.6_
