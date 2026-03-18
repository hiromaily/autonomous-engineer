# Task 11 Implementation Summary — Update domain-layer tests

## Files modified

### `orchestrator-ts/tests/domain/workflow-types.test.ts`
- Removed the entire `describe("WORKFLOW_PHASES", …)` block (two tests: length/order check and frozen-array check).
- Removed `WORKFLOW_PHASES` from the import line (kept `WorkflowPhase`, `WorkflowState`, `WorkflowStatus`).
- Replaced the `completedPhases: [...WORKFLOW_PHASES]` usage in the "accepts a completed state" test with a plain `string[]` literal of all 14 phase names.
- Replaced the "IMPLEMENTATION is in WORKFLOW_PHASES" test with a simpler string-assignment type-level check that no longer references the deleted constant.

### `orchestrator-ts/tests/domain/workflow-framework.test.ts`
- Added `case "suspension": return "suspension";` to the `_exhaustivePhaseTypeCheck` compile-time switch.
- Updated the "accepts all five execution type literal values" test to include `"suspension"` and assert `toHaveLength(6)`.
- Added two new tests to the `validateFrameworkDefinition` describe block:
  - `"throws when a phase has an unknown approvalGate value"` — exercises the new `VALID_APPROVAL_PHASES` runtime guard (casts invalid value to bypass TS compile-time check).
  - `"allows empty content for suspension phase"` — verifies the `suspension` type is treated like `human_interaction` and `git_command` (empty content permitted).

### `orchestrator-ts/tests/domain/approval-gate.test.ts`
- Added a new `describe("approvalArtifact override", …)` block with two tests:
  - `check(specDir, "requirements", "custom.md")` — verifies the returned `artifactPath` contains `"custom.md"` (override path used).
  - `check(specDir, "requirements")` (no third argument) — verifies the returned `artifactPath` contains `"requirements.md"` (hardcoded fallback preserved).

### `orchestrator-ts/tests/domain/workflow-engine.test.ts` (unplanned but required)
- This file also imported `WORKFLOW_PHASES`, causing a module-load error that prevented the entire domain test suite from running.
- Removed the `WORKFLOW_PHASES` import.
- Added a local `CC_SDD_PHASES` constant derived from `CC_SDD_FRAMEWORK_DEFINITION.phases.map(p => p.phase)` (the framework definition was already imported throughout the file).
- Replaced all 16 occurrences of `WORKFLOW_PHASES` with `CC_SDD_PHASES`.

## Result

`bun test tests/domain/` — **603 pass, 0 fail** (previously 1 error + 1 fail due to the `WORKFLOW_PHASES` module export removal).

## Acceptance criteria status

- No test imports `WORKFLOW_PHASES`: satisfied
- `_exhaustivePhaseTypeCheck` switch covers `"suspension"` without TypeScript error: satisfied
- New `approvalArtifact` override tests pass: satisfied
- Domain test suite passes: satisfied (603/603)
