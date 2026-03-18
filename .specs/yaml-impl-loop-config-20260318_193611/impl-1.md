# Task 1 Implementation Summary: Domain types and validation in `framework.ts`

## File Modified

`orchestrator-ts/src/domain/workflow/framework.ts`

## Changes Made

### 1. Added `LoopPhaseExecutionType` union type (exported)

A new union type restricting loop sub-phase execution to the three meaningful types for per-task iteration: `"llm_slash_command" | "llm_prompt" | "git_command"`. Types only meaningful at the orchestration level (`human_interaction`, `suspension`, `implementation_loop`) are intentionally excluded.

### 2. Added `VALID_LOOP_PHASE_EXECUTION_TYPES` constant (exported)

An exported `Set<string>` containing the same three strings. Used in runtime validation inside `validateFrameworkDefinition` to check that loop sub-phase types are valid without relying on TypeScript's compile-time narrowing.

### 3. Added `LoopPhaseDefinition` interface (exported)

A minimal interface with three `readonly` fields:
- `phase: string` — logical name used in logging
- `type: LoopPhaseExecutionType` — execution type
- `content: string` — command name, prompt template, or empty string (for `git_command`)

JSDoc from design Section 2.3 is included verbatim, explaining the content field semantics per type.

### 4. Added optional `loopPhases?` field to `PhaseDefinition`

`readonly loopPhases?: readonly LoopPhaseDefinition[]` added as the last field of `PhaseDefinition`. JSDoc from design Section 2.4 documents that this field is meaningful only for `implementation_loop` phases and that absence causes the service to use its hardcoded default sequence.

### 5. Extended `validateFrameworkDefinition` with loop-phases validation

Added a validation block (from design Section 2.5) that runs when `p.type === "implementation_loop"` and `p.loopPhases !== undefined`. Per sub-phase it checks:
1. `phase` name must be non-empty (trimmed).
2. `type` must be in `VALID_LOOP_PHASE_EXECUTION_TYPES`.
3. `content` must be non-empty for `llm_slash_command` and `llm_prompt` types.

## Type Check Result

The pre-existing type error in `tests/application/memory-port.test.ts:173` was confirmed present before this task's changes (verified via `git stash` + typecheck). No new type errors were introduced by these changes.
