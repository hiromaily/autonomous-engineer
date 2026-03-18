# Implementation Task List: YAML Workflow Definition Refactoring (Issue #51)

---

## Task 1 — Add `js-yaml` dependency

**Design section:** §1 (Chosen Approach), §5 (`YamlWorkflowDefinitionLoader`)
**Dependencies:** none
**Files to modify:**
- `orchestrator-ts/package.json` — add `"js-yaml": "^4.1.0"` to `dependencies`
- `orchestrator-ts/bun.lock` — updated automatically by `bun install`

**Acceptance criteria:**
- `bun install` resolves `js-yaml@4.x` without errors
- `import { load as yamlLoad } from "js-yaml"` compiles under TypeScript strict mode with no `@types/js-yaml` needed (v4 ships its own declarations)

**Mode:** [sequential] — must complete before Task 4 (YAML loader), which imports `js-yaml`

---

## Task 2 — Widen `WorkflowPhase` to `string` and remove `WORKFLOW_PHASES`

**Design section:** §4 "Type Changes — Exact Before/After" (`src/domain/workflow/types.ts`)
**Dependencies:** none
**Files to modify:**
- `orchestrator-ts/src/domain/workflow/types.ts` — remove `WORKFLOW_PHASES` const; change `WorkflowPhase` from const-union to `string` alias; update `WorkflowState` fields typed as `WorkflowPhase` (they become `string` implicitly, but keep the named alias)

**Acceptance criteria:**
- `WORKFLOW_PHASES` is no longer exported from the module
- `WorkflowPhase` is exported as `export type WorkflowPhase = string`
- `bun run typecheck` passes on this file in isolation (no downstream breakage introduced here that Task 3 does not resolve)

**Mode:** [parallel] — domain type change; no runtime behaviour change; Tasks 3 and 5 depend on it but can start as soon as it lands

---

## Task 3 — Extend `framework.ts` domain types

**Design section:** §4 (`src/domain/workflow/framework.ts`)
**Dependencies:** Task 2 (uses `WorkflowPhase = string`)
**Files to modify:**
- `orchestrator-ts/src/domain/workflow/framework.ts`
  - Add `"suspension"` to `PhaseExecutionType` union
  - Change `PhaseDefinition.phase` from `WorkflowPhase` to `string` (same type after Task 2, but explicit import removal is needed)
  - Add optional `readonly approvalArtifact?: string` field to `PhaseDefinition`
  - Update `findPhaseDefinition()` signature to `(def: FrameworkDefinition, phase: string): PhaseDefinition | undefined`
  - Extend `validateFrameworkDefinition()` to validate `approvalGate` against `VALID_APPROVAL_PHASES` constant (as shown in design §4)

**Acceptance criteria:**
- `PhaseExecutionType` now includes `"suspension"` as a valid literal
- `PhaseDefinition` has `approvalArtifact?: string` field
- `validateFrameworkDefinition()` throws when `approvalGate` is set to an unrecognised value

**Mode:** [sequential] — must follow Task 2; Tasks 4, 5, 6, 7 depend on this

---

## Task 4 — Create `yaml-workflow-definition-loader.ts`

**Design section:** §5 (New `YamlWorkflowDefinitionLoader`)
**Dependencies:** Tasks 1 (js-yaml installed), 3 (domain types updated)
**Files to create:**
- `orchestrator-ts/src/infra/sdd/yaml-workflow-definition-loader.ts` — implement `YamlWorkflowDefinitionLoader` exactly as shown in §5; constructor accepts `workflowDir` for testability; two-phase validation (structural then `validateFrameworkDefinition`)

**Acceptance criteria:**
- `load("cc-sdd")` resolves `.aes/workflow/cc-sdd.yaml` and returns a `FrameworkDefinition` with 14 phases
- `load("unknown")` rejects with a message containing the missing file path and a hint to create the YAML file
- Malformed YAML throws an error referencing the file path

**Mode:** [sequential] — depends on Tasks 1 and 3

---

## Task 5 — Add `suspension` case to `phase-runner.ts` and widen `phase` signature

**Design section:** §7 (Phase Runner Changes)
**Dependencies:** Task 3 (domain types: `"suspension"` in union, `phase: string` in `execute`)
**Files to modify:**
- `orchestrator-ts/src/application/services/workflow/phase-runner.ts`
  - Change `execute(phase: WorkflowPhase, …)` to `execute(phase: string, …)` to match updated types
  - Add `case "suspension":` alongside `case "human_interaction":` returning `{ ok: true, artifacts: [] }`
  - Remove the `never` exhaustive check compile error that would appear from the new union member

**Acceptance criteria:**
- `"suspension"` phase type is handled without throwing
- TypeScript exhaustiveness check in the `default` branch compiles cleanly after adding `"suspension"` to the union
- `bun run typecheck` passes

**Mode:** [parallel with Task 6] — both modify independent application-layer files; both depend on Task 3

---

## Task 6 — Add `approvalArtifact` override to `approval-gate.ts` and `debug-approval-gate.ts`

**Design section:** §4 (`src/domain/workflow/approval-gate.ts`), §2 Files to Modify (`debug-approval-gate.ts`)
**Dependencies:** Task 3 (domain types: `PhaseDefinition.approvalArtifact`)
**Files to modify:**
- `orchestrator-ts/src/domain/workflow/approval-gate.ts`
  - Add optional `approvalArtifact?: string` parameter to `check()` and `checkResume()` signatures
  - In `pending()`: use `approvalArtifact ?? artifactFilename(phase)` to resolve artifact path
  - Keep `artifactFilename()` switch as a fallback (do not delete)
- `orchestrator-ts/src/application/services/workflow/debug-approval-gate.ts`
  - Update `check()` override signature to include `approvalArtifact?: string` so it matches the new base-class signature

**Acceptance criteria:**
- `check(specDir, "requirements", "custom-req.md")` uses `custom-req.md` as the artifact path
- `check(specDir, "requirements")` (no third argument) falls back to the hardcoded `artifactFilename()` result
- `DebugApprovalGate.check()` signature aligns with the updated base class

**Mode:** [parallel with Task 5] — independent application-layer change; depends on Task 3

---

## Task 7 — Pass `approvalArtifact` from phase definition in `workflow-engine.ts`

**Design section:** §2 Files to Modify (`workflow-engine.ts`)
**Dependencies:** Tasks 5, 6 (approval-gate signature updated, phase types widened)
**Files to modify:**
- `orchestrator-ts/src/application/services/workflow/workflow-engine.ts`
  - At the approval gate check call (step 9 in `runPendingPhases`): read `approvalArtifact` from the `PhaseDefinition` and pass it to `approvalGate.check(specDir, approvalType, approvalArtifact)`
  - In `advancePausedPhase`: similarly pass `approvalArtifact` to `approvalGate.checkResume()`
  - Update `pendingPhases()` and `checkRequiredArtifacts()` return/parameter types to use `string` instead of `WorkflowPhase` where needed

**Acceptance criteria:**
- When a phase definition has `approvalArtifact` set, that path is forwarded to the gate
- When `approvalArtifact` is absent, behaviour is unchanged (falls back to hardcoded mapping)
- `bun run typecheck` passes

**Mode:** [sequential] — depends on Tasks 5 and 6

---

## Task 8 — Create `.aes/workflow/cc-sdd.yaml`

**Design section:** §3 (YAML Schema — Full cc-sdd.yaml)
**Dependencies:** none (data file; does not depend on any TypeScript changes)
**Files to create:**
- `orchestrator-ts/.aes/workflow/cc-sdd.yaml` — all 14 phases exactly as specified in §3, including `approval_artifact` fields for `SPEC_REQUIREMENTS`, `VALIDATE_DESIGN`, and `SPEC_TASKS` phases; `suspension` type for `HUMAN_INTERACTION`

**Acceptance criteria:**
- File contains exactly 14 entries under `phases:`
- `id: cc-sdd` at the top level
- Every `llm_prompt` phase has an `output_file` field
- Every phase with an `approval_gate` also has an `approval_artifact` field

**Mode:** [parallel] — pure data file; can be authored in parallel with any task; only needed before Task 10 (integration test)

---

## Task 9 — Replace `TypeScriptFrameworkDefinitionLoader` with `YamlWorkflowDefinitionLoader` in DI

**Design section:** §6 (DI Wiring Change)
**Dependencies:** Tasks 4, 8 (loader exists; YAML file exists so `build()` can resolve it at test time)
**Files to modify:**
- `orchestrator-ts/src/main/di/run-container.ts`
  - Replace `import { TypeScriptFrameworkDefinitionLoader } …` with `import { YamlWorkflowDefinitionLoader } …`
  - In the `frameworkDefinitionLoader` lazy getter: instantiate `YamlWorkflowDefinitionLoader(join(process.cwd(), ".aes", "workflow"))` instead of `TypeScriptFrameworkDefinitionLoader`

**Acceptance criteria:**
- `RunContainer.build()` with `sddFramework: "cc-sdd"` resolves without error (YAML file found)
- `RunContainer.build()` with `sddFramework: "openspec"` rejects with a file-not-found message containing `"openspec"`
- No reference to `TypeScriptFrameworkDefinitionLoader` or `CC_SDD_FRAMEWORK_DEFINITION` remains in production code

**Mode:** [sequential] — depends on Tasks 4 and 8

---

## Task 10 — Delete obsolete source files

**Design section:** §2 "Files to Delete" (production files)
**Dependencies:** Task 9 (DI no longer imports the deleted files; no production import chain references them)
**Files to delete:**
- `orchestrator-ts/src/infra/sdd/cc-sdd-framework-definition.ts`
- `orchestrator-ts/src/infra/sdd/typescript-framework-definition-loader.ts`

**Acceptance criteria:**
- `bun run typecheck` passes after deletion (no remaining import of these modules)
- `bun test` suite passes (no test imports these modules through a live path)

**Mode:** [sequential] — must follow Task 9 to avoid broken imports

---

## Task 11 — Update domain-layer tests

**Design section:** §8 "Tests to Update" (domain tests)
**Dependencies:** Tasks 2, 3, 6 (source under test has changed)
**Files to modify:**
- `orchestrator-ts/tests/domain/workflow-types.test.ts`
  - Remove the entire `describe("WORKFLOW_PHASES", …)` block (two tests) and any reference to `WORKFLOW_PHASES` import
  - Remove the test that uses `WORKFLOW_PHASES` to build a completed-phases array; replace with a plain `string[]` literal of 14 phase names or remove the exact-count assertion
- `orchestrator-ts/tests/domain/workflow-framework.test.ts`
  - Add `"suspension"` to the exhaustive compile-time switch check (`_exhaustivePhaseTypeCheck`)
  - Update the `"accepts all five execution type literal values"` test to assert 6 types (add `"suspension"`)
  - Add a test that `validateFrameworkDefinition` throws on an invalid `approvalGate` value
- `orchestrator-ts/tests/domain/approval-gate.test.ts`
  - Add a test: `check(specDir, "requirements", "custom.md")` returns `artifactPath` containing `"custom.md"` (override path)
  - Add a test: `check(specDir, "requirements")` (no override) still resolves to `"requirements.md"` (fallback)

**Acceptance criteria:**
- No test imports `WORKFLOW_PHASES`
- `_exhaustivePhaseTypeCheck` switch covers `"suspension"` without TypeScript error
- New `approvalArtifact` override tests pass

**Mode:** [parallel with Task 12] — test files are independent of each other; both depend on completed production changes (Tasks 2, 3, 6)

---

## Task 12 — Delete obsolete infra test files

**Design section:** §8 "Tests to Delete"
**Dependencies:** Task 10 (production files deleted)
**Files to delete:**
- `orchestrator-ts/tests/infra/sdd/typescript-framework-definition-loader.test.ts`
- `orchestrator-ts/tests/infra/sdd/cc-sdd-framework-definition.test.ts`

**Acceptance criteria:**
- `bun test` no longer references `TypeScriptFrameworkDefinitionLoader` or `CC_SDD_FRAMEWORK_DEFINITION`
- Total test count decreases by the number of removed tests; no test failure introduced

**Mode:** [parallel with Task 11] — independent file deletions

---

## Task 13 — Create `yaml-workflow-definition-loader.test.ts`

**Design section:** §8 "Tests to Create"
**Dependencies:** Tasks 4, 8 (loader and YAML file exist)
**Files to create:**
- `orchestrator-ts/tests/infra/sdd/yaml-workflow-definition-loader.test.ts`

Test cases to include:
- **Integration — happy path:** `load("cc-sdd")` (uses real `.aes/workflow/cc-sdd.yaml`) returns a definition with `id === "cc-sdd"` and exactly 14 phases
- **Integration — type distribution:** all `llm_prompt` phases have a non-undefined `outputFile`; all phases with `approvalGate` have `approvalArtifact`
- **Integration — unknown framework:** `load("unknown")` rejects with a message containing the expected file path and a creation hint
- **Unit (tmpdir) — missing file:** loader instantiated with a temp dir that has no file rejects with file-not-found error
- **Unit (tmpdir) — malformed YAML:** file with invalid YAML throws parse error referencing the file path
- **Unit (tmpdir) — duplicate phase:** YAML with two phases sharing the same name throws
- **Unit (tmpdir) — unknown execution type:** phase with `type: not_a_type` throws listing valid types
- **Unit (tmpdir) — missing `id`:** YAML without top-level `id` throws
- **Unit (tmpdir) — `approvalArtifact` override preserved:** phase definition with `approval_artifact: custom.md` maps to `approvalArtifact === "custom.md"` in the returned `PhaseDefinition`

**Acceptance criteria:**
- All 9+ test cases pass under `bun test`
- No test modifies the real `.aes/workflow/cc-sdd.yaml`; tmpdir-based tests are fully isolated

**Mode:** [sequential] — depends on Tasks 4 and 8

---

## Task 14 — Update `run-container-di-logging.test.ts`

**Design section:** §8 "Tests to Update" (`tests/main/run-container-di-logging.test.ts`)
**Dependencies:** Task 9 (DI container now uses `YamlWorkflowDefinitionLoader`)
**Files to modify:**
- `orchestrator-ts/tests/main/run-container-di-logging.test.ts`
  - The test `"build() rejects with unknown-framework error when sddFramework is not registered"` currently expects a message containing `"openspec"`. After the change the error message originates from `YamlWorkflowDefinitionLoader` (file-not-found message). Verify the assertion still matches — if the error message format changes (e.g. adds the file path), update the `.toThrow("openspec")` matcher to match the new text
  - Update the comment `"framework definition loading (Task 7)"` to reference `YamlWorkflowDefinitionLoader`

**Acceptance criteria:**
- All existing tests in this file continue to pass
- The `"rejects with unknown-framework error"` test assertion matches the actual error message emitted by `YamlWorkflowDefinitionLoader`

**Mode:** [sequential] — depends on Task 9

---

## Task Dependency Summary

```
Task 1 (js-yaml) ──────────────────────────┐
Task 2 (WorkflowPhase = string) ───────────┤
                                            ▼
                                       Task 3 (framework.ts types)
                                       ┌────┤
                                       │    ├──► Task 4 (YAML loader) ◄── Task 1
                                       │    ├──► Task 5 (phase-runner)
                                       │    └──► Task 6 (approval-gate)
                                       │                │
Task 8 (cc-sdd.yaml, parallel) ────────┼────────────────┼──► Task 9 (DI wiring) ◄── Task 4
                                       │                │              │
                                       │                └──► Task 7    │
                                       │                (workflow-eng) │
                                       │                               ├──► Task 10 (delete src)
                                       │                               │         │
                                       │                               │         └──► Task 12 (delete tests)
                                       │                               │
Tasks 2,3,6 ───────────────────────────┴──► Task 11 (update domain tests) [parallel with Task 12]
Tasks 4,8 ─────────────────────────────────► Task 13 (new YAML loader test)
Task 9 ─────────────────────────────────────► Task 14 (update DI logging test)
```
