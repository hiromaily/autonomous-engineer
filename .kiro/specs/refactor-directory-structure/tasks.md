# Implementation Plan

## Task Summary

Total: 6 major tasks, 28 sub-tasks covering all 8 requirements.
Migration executes in sequential phases; each phase ends with a typecheck gate before the next begins.

---

- [ ] 1. Move outbound adapters from `src/adapters/` to `src/infra/`

- [x] 1.1 (P) Move LLM adapter files into `src/infra/llm/`
  - Create `src/infra/llm/` directory
  - Move `src/adapters/llm/claude-provider.ts` and `src/adapters/llm/mock-llm-provider.ts` into the new location
  - Move the mock LLM provider alongside the real provider since both are concrete implementations of the LLM port
  - _Requirements: 2.1, 2.8_

- [x] 1.2 (P) Move SDD adapter files into `src/infra/sdd/`
  - Create `src/infra/sdd/` directory
  - Move `src/adapters/sdd/cc-sdd-adapter.ts` and `src/adapters/sdd/mock-sdd-adapter.ts` into the new location
  - _Requirements: 2.3, 2.8_

- [x] 1.3 (P) Move tool adapter files into `src/infra/tools/`
  - Create `src/infra/tools/` directory
  - Move all files from `src/adapters/tools/` (`code-analysis.ts`, `filesystem.ts`, `git.ts`, `knowledge.ts`, `shell.ts`) into the new location
  - _Requirements: 2.4_

- [x] 1.4 (P) Merge git adapter files into the existing `src/infra/git/`
  - Move `src/adapters/git/git-controller-adapter.ts` and `src/adapters/git/github-pr-adapter.ts` into `src/infra/git/` alongside the existing factory file
  - No naming conflict exists; placement is flat within the directory
  - _Requirements: 2.2, 2.7_

- [x] 1.5 (P) Merge safety adapter files into the existing `src/infra/safety/`
  - Move `src/adapters/safety/approval-gateway.ts`, `src/adapters/safety/audit-logger.ts`, and `src/adapters/safety/sandbox-executor.ts` into `src/infra/safety/` alongside the existing factory file
  - _Requirements: 2.5_

- [x] 1.6 Update all import statements across the codebase to reflect the outbound adapter relocations
  - Replace all `@/adapters/llm/...` imports with `@/infra/llm/...`
  - Replace all `@/adapters/sdd/...` imports with `@/infra/sdd/...`
  - Replace all `@/adapters/tools/...` imports with `@/infra/tools/...`
  - Replace all `@/adapters/git/...` imports with `@/infra/git/...`
  - Replace all `@/adapters/safety/...` imports with `@/infra/safety/...`
  - Fix the known violation in `quality-gate-runner.ts`: update its import of `@/adapters/tools/shell` to `@/infra/tools/shell`
  - Update `src/infra/git/create-git-integration-service.ts` to import from `@/infra/git/...` instead of `@/adapters/git/...`
  - Update `src/infra/safety/create-safety-executor.ts` to import from `@/infra/safety/...` instead of `@/adapters/safety/...`
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 8.2_

- [x] 1.7 Verify the codebase compiles cleanly after Phase 1
  - Run `bun run typecheck` and confirm zero errors before proceeding
  - If errors remain, fix all import breakage before moving to Task 2
  - _Requirements: 7.3, 7.4_

---

- [x] 2. Relocate CLI to `src/adapters/cli/` and extract the DI composition root into `src/infra/bootstrap/`

- [x] 2.1 Move all CLI source files to `src/adapters/cli/`
  - Create `src/adapters/cli/` directory
  - Move all files from `src/cli/` (`index.ts`, `renderer.ts`, `config-wizard.ts`, `configure-command.ts`, `debug-log-writer.ts`, `json-log-writer.ts`) to the new location
  - Confirm relative imports between CLI files (e.g., `configure-command.ts` → `config-wizard.ts`) remain correct after relocation
  - _Requirements: 1.1, 1.3, 1.4_

- [x] 2.2 Extract dependency injection wiring from the CLI entry point into `src/infra/bootstrap/`
  - Create `src/infra/bootstrap/` directory and a `create-run-dependencies.ts` file
  - Move all DI wiring logic (instantiating concrete infra implementations and assembling the `RunSpecUseCase`) out of `src/adapters/cli/index.ts` into the new bootstrap factory
  - The bootstrap factory function accepts parsed configuration flags and returns `RunDependencies` with typed interfaces for the use case, event bus, log writer, and debug writer — using `IJsonLogWriter` from `application/ports/logging.ts` and `IDebugEventSink` from `application/ports/debug.ts` (not concrete types)
  - `src/adapters/cli/index.ts` is slimmed to: argument parsing, calling the bootstrap factory, attaching the renderer to the event bus, and managing process exit
  - The CLI entry point imports only from the bootstrap factory and CLI-local helpers — no direct infra imports except via bootstrap
  - _Requirements: 5.3, 8.3_

- [x] 2.3 Update configuration files for the new CLI path
  - Update `package.json` `bin.aes` to point to the new CLI entry path
  - Update `package.json` scripts (`aes`, `aes:dev`, `build`) to use the new path
  - Update `tsconfig.json` `include` array: replace `src/cli/**/*` with `src/adapters/**/*` (or verify the existing `src/adapters/**/*` glob already covers it)
  - _Requirements: 1.1, 7.5_

- [x] 2.4 Verify the codebase compiles cleanly after Phase 2
  - Run `bun run typecheck` and confirm zero errors before proceeding
  - If errors remain, fix all import and path breakage before moving to Task 3
  - _Requirements: 7.3, 7.4_

---

- [ ] 3. Reorganize the application layer into `usecases/`, `services/`, and `ports/` sub-directories

- [ ] 3.1 Audit all `@/application/` import sites before making any moves
  - Run a grep across `src/` and `tests/` for all TypeScript files importing from `@/application/` and record the full list and count
  - This list is the verification baseline — after moves, a re-run must show zero stale paths remaining
  - _Requirements: 3.5_

- [ ] 3.2 Create `application/services/` sub-directories and move all orchestration service files
  - Create `src/application/services/` with sub-directories: `agent/`, `context/`, `git/`, `implementation-loop/`, `planning/`, `self-healing-loop/`, `tools/`, `workflow/`
  - Move all files from the corresponding `src/application/<subdir>/` directories into `src/application/services/<subdir>/`
  - No files are renamed; only the path prefix changes
  - _Requirements: 3.1, 3.2_

- [ ] 3.3 Move safety service and port files to their respective new locations
  - Create `src/application/services/safety/` and move `emergency-stop-handler.ts` and `guarded-executor.ts` into it
  - Move `src/application/safety/ports.ts` to `src/application/ports/safety.ts`
  - Remove the now-empty `src/application/safety/` directory
  - _Requirements: 3.3, 3.4_

- [ ] 3.4 Create the logging port interface file
  - Add `src/application/ports/logging.ts` defining `IJsonLogWriter` (write + close for `WorkflowEvent`)
  - Update `src/adapters/cli/json-log-writer.ts` to implement `IJsonLogWriter` from this new port
  - Update `src/infra/bootstrap/create-run-dependencies.ts` to type `logWriter` as `IJsonLogWriter | null` using the port interface, not the concrete class
  - _Requirements: 3.5, 8.3, 8.4_

- [ ] 3.5 Update all application import paths across the codebase
  - Replace all `@/application/<subdir>/...` imports (for the 9 service directories) with `@/application/services/<subdir>/...`
  - Replace all `@/application/safety/ports` imports with `@/application/ports/safety`
  - Cover both `src/` and `tests/` directories
  - Re-run the grep from Task 3.1 to confirm zero remaining stale `@/application/` paths outside `ports/`, `usecases/`, and `services/`
  - _Requirements: 3.5, 8.2_

- [ ] 3.6 Verify the codebase compiles cleanly after Phase 3
  - Run `bun run typecheck` and confirm zero errors before proceeding
  - _Requirements: 7.3, 7.4_

---

- [ ] 4. Remove the empty `src/domain/engines/` directory
  - Verify no source or test file imports from `@/domain/engines/` by running a grep across the codebase
  - Delete the empty `src/domain/engines/` directory
  - Run `bun run typecheck` to confirm zero errors after the removal
  - _Requirements: 4.1, 4.2, 4.3_

---

- [ ] 5. Mirror the refactored source structure in the `tests/` directory

- [ ] 5.1 (P) Move CLI tests to `tests/adapters/cli/`
  - Move all files from `tests/cli/` into `tests/adapters/cli/`
  - Update any import paths within the moved test files to reflect the new source location
  - _Requirements: 6.1, 6.4_

- [ ] 5.2 (P) Move adapter test files to their corresponding `tests/infra/` locations
  - Move LLM-related test files (`claude-provider.test.ts`, `mock-llm-provider.test.ts`) to `tests/infra/llm/`
  - Move `tests/adapters/git/` test files to `tests/infra/git/`
  - Move `tests/adapters/sdd/` test files to `tests/infra/sdd/`
  - Move `tests/adapters/tools/` test files to `tests/infra/tools/`
  - Move `tests/adapters/safety/` test files to `tests/infra/safety/`
  - _Requirements: 6.2, 6.4, 6.5_

- [ ] 5.3 (P) Move application service test files to mirror the new `services/` structure
  - Move `tests/application/agent/`, `context/`, `git/`, `implementation-loop/`, `planning/`, `self-healing-loop/`, `tools/`, `workflow/` into `tests/application/services/*/`
  - Move `tests/application/safety/` (service files) to `tests/application/services/safety/`
  - Move any safety port tests to `tests/application/ports/`
  - _Requirements: 6.3, 6.4_

- [ ] 5.4 Update import paths in all moved test files
  - After moves in 5.1–5.3, update all import statements in moved test files to use the new source paths
  - Verify no test files remain under the old paths (`tests/cli/`, `tests/adapters/llm/`, `tests/adapters/git/`, etc.)
  - _Requirements: 6.4_

- [ ] 5.5 Verify the codebase compiles cleanly after Phase 5
  - Run `bun run typecheck` and confirm zero errors before proceeding to final validation
  - _Requirements: 7.3, 7.4_

---

- [ ] 6. Final validation: confirm zero behavioral change and full compliance

- [ ] 6.1 Run the full test suite and verify all tests pass
  - Execute `bun test` and confirm all existing tests pass without modification to test logic
  - Any failure indicates a missed import update or logic change — fix it without changing test assertions
  - _Requirements: 7.1, 7.2_

- [ ] 6.2 Smoke test the CLI
  - Run `bun run aes --help` to confirm the `aes` command resolves and outputs correctly from its new path
  - _Requirements: 7.1_

- [ ] 6.3 Verify no orphaned files remain in old directory paths
  - Confirm `src/cli/` no longer exists
  - Confirm `src/adapters/` contains only `cli/`
  - Confirm `tests/adapters/` contains only `cli/` (no LLM, git, SDD, tools, or safety test directories)
  - Confirm all 9 service directories exist under `src/application/services/` and under `tests/application/services/`
  - _Requirements: 1.2, 6.4, 6.5_

- [ ] 6.4 Perform a dependency direction audit
  - Confirm `domain/` files have no imports from `application/`, `adapters/`, or `infra/`
  - Confirm `application/` files import only from `domain/` or within `application/`
  - Confirm `adapters/cli/` files (except `index.ts`) do not import from `infra/` directly
  - Confirm `adapters/cli/index.ts` imports only from `infra/bootstrap/` and CLI-local helpers
  - Confirm `infra/` modules implement interfaces defined in `application/ports/`
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_
