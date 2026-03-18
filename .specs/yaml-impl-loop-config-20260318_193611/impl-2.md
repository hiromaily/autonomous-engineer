# Task 2 Implementation Summary: Port Additions in `implementation-loop.ts`

## Changes Made

### `orchestrator-ts/src/application/ports/implementation-loop.ts`

1. **Added three new imports** at the top of the file:
   - `import type { LlmProviderPort } from "@/application/ports/llm";`
   - `import type { SddFrameworkPort } from "@/application/ports/sdd";`
   - `import type { LoopPhaseDefinition } from "@/domain/workflow/framework";`

2. **Added five new optional fields** to `ImplementationLoopOptions`:
   - `loopPhases?: readonly LoopPhaseDefinition[]` — sub-phases from YAML; when absent, hardcoded default runs
   - `sdd?: SddFrameworkPort` — required for `llm_slash_command` loop-phases
   - `llm?: LlmProviderPort` — required for `llm_prompt` loop-phases
   - `specDir?: string` — spec directory for `SpecContext` construction
   - `language?: string` — language code for `SpecContext` and interpolation

3. **Updated JSDoc** on `ImplementationLoopOptions` to document the five new fields and their relationship to YAML-configured execution.

### `orchestrator-ts/src/application/services/implementation-loop/implementation-loop-service.ts`

- Updated `DEFAULT_OPTIONS` to include the five new fields (`loopPhases`, `sdd`, `llm`, `specDir`, `language`) using `undefined as never` — consistent with the existing convention for optional service dependencies. This was required to satisfy the `Required<ImplementationLoopOptions>` type constraint.

## Typecheck Result

`bun run typecheck` passes with zero new errors. The sole remaining error (`tests/application/memory-port.test.ts:173`) is pre-existing and unrelated to this task.

## Export Names Verified

- `SddFrameworkPort` — exported from `@/application/ports/sdd` (confirmed)
- `LlmProviderPort` — exported from `@/application/ports/llm` (confirmed)
- `LoopPhaseDefinition` — to be exported from `@/domain/workflow/framework` (Task 1 scope)
