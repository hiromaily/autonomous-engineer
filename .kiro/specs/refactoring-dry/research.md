# Research & Design Decisions

---
**Purpose**: Capture discovery findings, architectural investigations, and rationale that inform the technical design.

---

## Summary

- **Feature**: `refactoring-dry`
- **Discovery Scope**: Extension (existing codebase, infra-layer-only refactoring)
- **Key Findings**:
  - `isNodeError` is a 1-line type guard duplicated verbatim in 4 infra files; ideal candidate for a shared `errors.ts` utility
  - `atomicWrite` (temp + datasync + rename pattern) is independently defined in 3 stores; `audit-logger.ts` uses `open("a")` append mode — a different pattern — and is excluded from consolidation
  - The two NDJSON loggers have materially different concurrency models (sync vs async) and different error-reporting policies; only the mkdir+append core is shareable; error handling must remain per-logger
  - `src/infra/utils/` does not yet exist; all three new modules are net-new files

## Research Log

### atomicWrite pattern — exact scope

- **Context**: Requirements identified `audit-logger.ts` as a fourth `atomicWrite` location. Code inspection shows `audit-logger.ts` uses `open(logPath, "a")` (append-open) with `fh.datasync()`, not a temp+rename write. This is an append-idempotency pattern, not atomic replacement.
- **Sources Consulted**: Direct code read of `src/infra/safety/audit-logger.ts`
- **Findings**: Three stores share the identical temp+rename pattern: `WorkflowStateStore.persist()`, `PlanFileStore.atomicWrite()`, `FileMemoryStore.atomicWrite()`. `AuditLogger.appendLine()` is out of scope.
- **Implications**: The shared `atomicWrite` utility signature will be `(destPath: string, content: string): Promise<void>` and will include an implicit `mkdir(dirname(destPath))`. The audit logger is left unchanged.

### readFileSafe — return type discrepancy

- **Context**: `FileMemoryStore.readFileSafe` (line 104) returns `""` (empty string) on ENOENT. `WorkflowStateStore.restore()` and `PlanFileStore.load()` return `null`.
- **Findings**: A unified `readFileSafe` returning `string | null` is correct. `FileMemoryStore` callers must coerce `null → ""` at the call site after migration.
- **Implications**: Minor call-site adjustment needed in `file-memory-store.ts`; behavior is preserved.

### NDJSON loggers — concurrency models

- **Context**: `NdjsonImplementationLoopLogger` uses blocking sync I/O (`mkdirSync`, `appendFileSync`) and logs failures via `console.error`. `NdjsonSelfHealingLoopLogger` uses async fire-and-forget (`mkdir`, `appendFile`) and counts errors in `writeErrorCount`.
- **Findings**: Only the mkdir+appendFile core is structurally identical. Error-handling policies differ by design: implementation loop surfaces errors to console; self-healing loop silently counts them.
- **Implications**: The shared `appendNdjsonLine` helper exposes the core async operation and does **not** swallow errors (it may throw). Each logger's `#append` method retains its own `.catch()` handler — see Decision: NDJSON error handling below. Req 4.3 ("silently swallow") is refined to mean "the helper does not propagate errors to the event loop by default; each caller decides its own error policy."

### LLM provider factory — scope of duplication

- **Context**: Two provider creation points exist in `create-run-dependencies.ts`: (1) `implLlm` (line 69) for the implementation loop, without provider-override support; (2) `createLlmProvider` callback passed to `RunSpecUseCase`, with full provider-override switch.
- **Findings**: These serve different call sites and cannot be collapsed into one function without losing the override capability of (2). The shared extract is the debug-condition check: `debugFlow && debugWriter !== null ? new MockLlmProvider(...) : new ClaudeProvider(...)`.
- **Implications**: Req 5 is satisfied by making `implLlm` call the `createLlmProvider` closure (defined first) rather than repeating the debug condition inline. The factory appears once in the file.

### Architecture linter — `adapters/cli` import restrictions

- **Context**: Issue 1 from design review raised that `debug-log-writer.ts` in `src/adapters/cli/` cannot import from `src/infra/utils/` per the linter rule: `src/adapters/cli/` may only import from `adapters/cli/`, `application/usecases/`, `application/ports/`, and `infra/bootstrap/`.
- **Sources Consulted**: Direct read of `scripts/lint-ts-architecture.sh` — rule array entry for `src/adapters/cli/`
- **Findings**: The restriction is confirmed. No infra subdirectory other than `infra/bootstrap/` is in the allowlist for `adapters/cli`. Moving `DebugLogWriter` to `src/infra/logger/` is the cleanest resolution — it stays an infra concern (file I/O, event formatting) and can import freely from `infra/utils/`.
- **Implications**: `src/infra/logger/` will need its own linter rule entry in `lint-ts-architecture.sh`. Default allow: `infra/logger/`, `infra/utils/`, `application/ports/`, `domain/`. Deny: `application/usecases/`, `application/services/`, `adapters/`.

### No new external dependencies

- **Context**: All changes are within `src/infra/`. No new npm packages are introduced; all I/O is via Node.js built-in `node:fs/promises`.
- **Findings**: No dependency compatibility check needed.
- **Implications**: No version pinning or lock-file changes required.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Shared `infra/utils/` + `infra/logger/` | Utilities in `fs.ts`, `errors.ts`, `ndjson.ts`; all logger classes in `infra/logger/` | Stays within infra layer; resolves linter boundary for `DebugLogWriter`; no import restriction concern | Requires moving 4 files; linter needs a new rule for `infra/logger/` | **Selected approach** |
| Shared `infra/utils/` only (no logger move) | Keep `DebugLogWriter` in `adapters/cli/`; use `getErrorMessage` only in infra files | Fewer file moves | `adapters/cli/` cannot import `infra/utils/`; linter violation unresolved | Rejected — violates linter rule |
| Base class for stores | Abstract base class providing `atomicWrite` and `readFileSafe` | Groups store behavior | Requires class inheritance; incompatible with non-class patterns (standalone functions) | Rejected — stores have no other shared behavior |
| Shared utility at `domain/` or `application/` | Expose fs helpers to all layers | Wider reuse | Violates layer boundary; domain must not depend on Node.js fs | Rejected |

## Design Decisions

### Decision: `src/infra/logger/` as the single logger home

- **Context**: `DebugLogWriter` in `src/adapters/cli/` needed `getErrorMessage` from `infra/utils/errors.ts`, which the architecture linter prohibits. Three options existed: exclude `DebugLogWriter` from Req 3, add a special linter exception, or relocate it.
- **Alternatives Considered**:
  1. Exclude `debug-log-writer.ts` from the `getErrorMessage` refactoring — leaves one inline ternary unreplaced; inconsistent
  2. Add a linter exception for `adapters/cli/ → infra/utils/` — weakens the boundary for the whole CLI adapter layer
  3. Move `DebugLogWriter` and all other loggers to `src/infra/logger/` — natural grouping; no linter exception needed
- **Selected Approach**: Create `src/infra/logger/` and consolidate all logger class files there. Add a linter rule for `infra/logger/` permitting `infra/utils/` imports.
- **Rationale**: `DebugLogWriter` is fundamentally an I/O component (writes files, formats events) — it belongs in infra, not in the CLI adapter whose role is to be a thin command dispatcher. Moving it clarifies responsibilities.
- **Trade-offs**: 4 file moves with import path updates in consumer files. Linter script needs one new rule entry. All existing class interfaces and test coverage remain valid.
- **Follow-up**: Verify `create-safety-executor.ts` and `create-git-integration-service.ts` import paths for `AuditLogger` after the move.

### Decision: NDJSON error handling — helper throws; callers own `.catch()`

- **Context**: The two NDJSON loggers have different error policies: implementation loop surfaces failures via `console.error`; self-healing loop increments `writeErrorCount`. Req 4.3 (original) said "helper swallows", which would destroy `writeErrorCount` semantics.
- **Alternatives Considered**:
  1. Helper swallows all errors — callers lose the ability to react per their own policy; `writeErrorCount` becomes unmaintainable
  2. Helper throws; each logger's `#append` installs its own `.catch()` — each logger retains its policy
- **Selected Approach**: `appendNdjsonLine` is `async` and may throw. Each logger's `#append` handles errors with its own `.catch()`. Req 4.3 is updated to reflect this.
- **Rationale**: Preserves `writeErrorCount` semantics on `NdjsonSelfHealingLoopLogger` and `console.error` on `NdjsonImplementationLoopLogger`.
- **Trade-offs**: Each logger retains a `.catch()` line vs a fully opaque helper. Accepted given the behavioral divergence.

### Decision: `appendNdjsonLine(logPath, entry)` — drop redundant `logDir` parameter

- **Context**: Original draft had `appendNdjsonLine(logDir, logPath, entry)`. Both callers always have `logDir === dirname(logPath)`, making `logDir` redundant and creating a silent inconsistency risk if mismatched.
- **Selected Approach**: `appendNdjsonLine(logPath: string, entry: object): Promise<void>` — internally computes `dirname(logPath)` for `mkdir`.
- **Rationale**: Simpler interface; one fewer invariant callers must manually uphold. `dirname` is a pure, zero-cost operation.
- **Trade-offs**: None — callers already hold `this.#logPath` directly.

### Decision: `implLlm` reuses `createLlmProvider` closure

- **Context**: `implLlm` and the `createLlmProvider` callback both contain the debug-condition check. They cannot share the same function signature, but `implLlm` can simply call `createLlmProvider(config)` without a provider override.
- **Selected Approach**: Define `createLlmProvider` first in the function body, then assign `const implLlm = createLlmProvider(config)`.
- **Rationale**: Eliminates the second debug-condition branch with a one-line change. Satisfies Req 5.4.
- **Trade-offs**: `implLlm` now goes through the provider-override switch even though it doesn't need override support — the default path is taken (no override arg). Negligible runtime cost.

## Risks & Mitigations

- **Sync-to-async migration in `NdjsonImplementationLoopLogger`** — switching from `appendFileSync` to `appendFile` changes timing; log entries may appear slightly out of order relative to synchronous caller code. Mitigation: existing tests cover log output; verify with `bun test` after change.
- **`readFileSafe` return-type coercion in `FileMemoryStore`** — callers that relied on `""` must explicitly handle `null`. Mitigation: TypeScript strict mode + `noUncheckedIndexedAccess` will surface any missed call sites at type-check time.
- **`src/infra/utils/` becoming a grab-bag** — future contributors may add arbitrary helpers. Mitigation: document the three specific files in `src/README.md` and enforce via architecture linter rules if needed.

## References

- TypeScript strict mode options: `orchestrator-ts/tsconfig.json`
- Architecture linting script: `scripts/lint-ts-architecture.sh`
- Clean Architecture layer rules: `orchestrator-ts/src/README.md`
