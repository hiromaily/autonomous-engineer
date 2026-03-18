# Task 5 Implementation Summary

## Changes made

**File**: `orchestrator-ts/src/application/services/implementation-loop/implementation-loop-service.ts`

### 1. Added import

Added `import type { LoopPhaseDefinition } from "@/domain/workflow/framework"` at the top of the file.

### 2. Added `interpolateLoopPhase` module-level helper (Section 6.1)

A new pure function added before `DEFAULT_OPTIONS`. Replaces `{specName}`, `{specDir}`, `{language}`, and `{taskId}` placeholders in a template string using `.replaceAll()`.

### 3. `DEFAULT_OPTIONS` verification

The five new fields (`loopPhases`, `sdd`, `llm`, `specDir`, `language`) were already present from Task 2. No change needed.

### 4. Added `#executeConfiguredPhases` private method (Section 6.2)

Placed before the closing brace of `ImplementationLoopService` class, after `#buildHaltResult`. The method:

- Iterates each `LoopPhaseDefinition` in `loopPhases`
- For `llm_slash_command`: checks `options.sdd` is present, builds `specCtx`, calls `options.sdd.executeCommand(interpolatedContent + " " + task.id, specCtx)`, returns error on failure
- For `llm_prompt`: checks `options.llm` is present, calls `options.llm.complete(interpolatedPrompt)`, returns error on failure (response content discarded)
- For `git_command`: calls `detectChanges()` then `stageAndCommit(files, "feat: " + task.title)`, returns error on failure, sets `commitSha` on success
- Returns `{ ok: true, commitSha? }` when all sub-phases succeed

### 5. Updated `#executeSection` (Sections 6.3 and 6.4)

- `options.contextEngine?.resetTask(task.id)` is still called unconditionally (both paths)
- Added `const useConfiguredPhases = options.loopPhases !== undefined && options.loopPhases.length > 0` before the `while(true)` loop
- Moved `contextProvider` construction into the `else` (hardcoded) branch only, with guard: `!useConfiguredPhases && options.contextEngine ? ...`
- Inside the `while(true)` loop, added `if (useConfiguredPhases) { ... } else { ... }` structure:
  - **Configured path**: calls `#executeConfiguredPhases`, on success updates section status to `"completed"` and returns; on failure increments `retryCount`, builds a `ReviewResult` for the iteration record, pushes to `iterations`, calls `#escalateSection` if `retryCount >= maxRetriesPerSection`
  - **Hardcoded path**: all existing agent loop code preserved unchanged

## Verification

- `bun run typecheck`: only pre-existing error in `tests/application/memory-port.test.ts` (not related to these changes)
- `bun test --filter "implementation-loop"`: 257 tests pass, 0 fail
