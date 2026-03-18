# Task 7: Test Helper Update — impl-7.md

## File Modified

`orchestrator-ts/tests/helpers/workflow.ts`

## Changes Made

1. **Added `LoopPhaseDefinition` to the import** from `@/domain/workflow/framework` (alongside the existing `FrameworkDefinition` import).

2. **Updated `makeFrameworkDef` signature** from the zero-arg form to:
   ```typescript
   export function makeFrameworkDef(options?: { loopPhases?: readonly LoopPhaseDefinition[] }): FrameworkDefinition
   ```
   The parameter is optional with an implicit default of `undefined`, so all existing zero-arg callers continue to work without modification.

3. **Added conditional spreading** into the `IMPLEMENTATION` phase definition object:
   ```typescript
   ...(options?.loopPhases !== undefined ? { loopPhases: options.loopPhases } : {})
   ```
   When `options` is omitted or `options.loopPhases` is `undefined`, the `loopPhases` property is absent from the phase object (matching the original structure exactly). When provided, `loopPhases` is included so tests can exercise the configured-phases code path.

## Verification

- Ran `bun test tests/helpers/ tests/domain/ tests/application/` — **1928 tests pass, 0 fail** (2.47 s).
- All existing callers were left unmodified (zero-arg calls continue to work identically).
