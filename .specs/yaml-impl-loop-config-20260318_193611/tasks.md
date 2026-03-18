# Task List: YAML-Configurable `loop-phases` — Full Execution Model

**Feature branch**: `feature/yaml-impl-loop-config`
**Verification command** (after all tasks): `cd orchestrator-ts && bun run typecheck && bun test`

---

## Task 1 — Domain types and validation in `framework.ts` [sequential]

**Design section**: 2 (Domain Model Changes)
**Dependencies**: none

**Files to modify**:
- `orchestrator-ts/src/domain/workflow/framework.ts`

**Changes**:
1. Add `LoopPhaseExecutionType` union type (`"llm_slash_command" | "llm_prompt" | "git_command"`).
2. Add `VALID_LOOP_PHASE_EXECUTION_TYPES` constant as a `Set<string>`.
3. Add `LoopPhaseDefinition` interface with `phase`, `type`, and `content` fields (all `readonly`).
4. Add optional `loopPhases?: readonly LoopPhaseDefinition[]` field to `PhaseDefinition`.
5. Extend `validateFrameworkDefinition` with the loop-phases validation block (iterate entries, check phase name not empty, check type in set, check content non-empty for `llm_slash_command`/`llm_prompt`).

**Acceptance criteria**:
- `LoopPhaseExecutionType`, `VALID_LOOP_PHASE_EXECUTION_TYPES`, and `LoopPhaseDefinition` are exported from `framework.ts`.
- `PhaseDefinition.loopPhases` is typed `readonly LoopPhaseDefinition[] | undefined`.
- `validateFrameworkDefinition` throws a descriptive error for an unknown loop-phase type or missing content, and passes for valid configurations.

---

## Task 2 — Port additions in `implementation-loop.ts` [sequential]

**Design section**: 4 (Port Changes)
**Dependencies**: Task 1

**Files to modify**:
- `orchestrator-ts/src/application/ports/implementation-loop.ts`

**Changes**:
1. Add imports: `LoopPhaseDefinition` from `@/domain/workflow/framework`, `SddFrameworkPort` from `@/application/ports/sdd`, `LlmProviderPort` from `@/application/ports/llm`.
2. Add five new optional fields to `ImplementationLoopOptions`: `loopPhases?`, `sdd?`, `llm?`, `specDir?`, `language?`.
3. Update the JSDoc comment on `ImplementationLoopOptions` to document the new fields.

**Acceptance criteria**:
- `ImplementationLoopOptions` compiles with all five new optional fields present.
- Existing callers that pass only `maxRetriesPerSection` and `qualityGateConfig` continue to compile without changes.
- No circular dependencies introduced.

---

## Task 3 — YAML loader parsing in `yaml-workflow-definition-loader.ts` [parallel]

**Design section**: 3 (YAML Loader Changes)
**Dependencies**: Tasks 1 and 2
**Note**: Independent of Task 4; both can run after Tasks 1 and 2 complete.

**Files to modify**:
- `orchestrator-ts/src/infra/sdd/yaml-workflow-definition-loader.ts`

**Changes**:
1. Add `LoopPhaseDefinition`, `LoopPhaseExecutionType`, `VALID_LOOP_PHASE_EXECUTION_TYPES` to the domain import line.
2. Add private method `toLoopPhaseDefinition(raw, parentPhase, filePath, index)` with full validation and return of a `LoopPhaseDefinition` object.
3. In `toPhaseDefinition`, append the IIFE spread for `loop-phases` after existing optional field spreads. Only parsed for `implementation_loop` phases; silently ignored on others; non-array value throws.

**Acceptance criteria**:
- A YAML with a valid `loop-phases` array on an `implementation_loop` phase produces a `PhaseDefinition` with a populated `loopPhases` array.
- An unknown type in a `loop-phases` entry throws with a message containing the entry index, parent phase name, and the invalid type string.
- Absence of `loop-phases` yields `loopPhases === undefined`.

---

## Task 4 — Threading in `phase-runner.ts` [parallel]

**Design section**: 5 (Phase Runner Changes)
**Dependencies**: Tasks 1 and 2
**Note**: Independent of Task 3; both can run after Tasks 1 and 2 complete.

**Files to modify**:
- `orchestrator-ts/src/application/services/workflow/phase-runner.ts`

**Changes**:
Replace the `case "implementation_loop"` branch body in `execute()`:
1. Build `mergedOptions` spreading in order: `{ specDir: ctx.specDir, language: ctx.language, sdd: this.sdd, llm: this.llm }`, then `...(this.implementationLoopOptions ?? {})`, then `...(phaseDef.loopPhases !== undefined ? { loopPhases: phaseDef.loopPhases } : {})`.
2. Pass merged options to `this.implementationLoop.run(ctx.specName, ...)`.
3. Keep existing stub when `this.implementationLoop` is absent.

**Acceptance criteria**:
- When `phaseDef.loopPhases` is defined, merged options contain `loopPhases` from YAML, `specDir`/`language` from `ctx`, `sdd`/`llm` from `this`.
- When DI `implementationLoopOptions` also contains `loopPhases`, the YAML value wins (spread last).
- The existing no-loop stub path is unchanged.

---

## Task 5 — Execution logic in `implementation-loop-service.ts` [sequential]

**Design section**: 6 (Implementation Loop Service Changes)
**Dependencies**: Tasks 1 and 2
**Note**: Does not require Tasks 3 or 4 to be complete.

**Files to modify**:
- `orchestrator-ts/src/application/services/implementation-loop/implementation-loop-service.ts`

**Changes**:
1. Add module-level `interpolateLoopPhase(template, vars)` helper.
2. Add private method `#executeConfiguredPhases(loopPhases, task, plan, options)`:
   - `llm_slash_command`: call `options.sdd.executeCommand(content + " " + task.id, specCtx)`; on failure extract error as `stderr.trim() || "SDD adapter failed (exit N)"`.
   - `llm_prompt`: call `options.llm.complete(interpolated prompt)`; on failure return `{ ok: false, error: result.error.message }`.
   - `git_command`: `detectChanges()` then `stageAndCommit(files, "feat: " + task.title)`; return `commitSha` on success.
   - Return `{ ok: true, commitSha? }` or `{ ok: false, error }`.
3. In `#executeSection`, add `const useConfiguredPhases = options.loopPhases !== undefined && options.loopPhases.length > 0` before the `while(true)` loop.
4. Add `if (useConfiguredPhases)` branch inside `while(true)`: call `#executeConfiguredPhases`, handle success/failure/retry/escalation.
5. Move `contextProvider` construction inside the `else` (hardcoded) branch only.
6. Update `DEFAULT_OPTIONS` to include the five new fields as `undefined as never`.

**Acceptance criteria**:
- When `loopPhases` is populated and all sub-phases succeed, section returns `status === "completed"`.
- When any sub-phase fails, `retryCount` increments; `#escalateSection` is called when `maxRetriesPerSection` is reached.
- When `loopPhases` is `undefined` or empty, existing `agentLoop.run` path runs unchanged.

---

## Task 6 — YAML file update and integration test assertion [sequential]

**Design section**: 7 (YAML Example) and 11.2 (integration test)
**Dependencies**: Tasks 3 and 5

**Files to modify**:
- `orchestrator-ts/.aes/workflow/cc-sdd.yaml`
- `orchestrator-ts/tests/infra/sdd/yaml-workflow-definition-loader.test.ts`

**Changes**:
1. In `cc-sdd.yaml`, add `loop-phases` block to the IMPLEMENTATION phase: 4 entries — `SPEC_IMPL` (llm_slash_command, `"kiro:spec-impl"`), `VALIDATE_IMPL` (llm_prompt, prompt template with `{taskId}`, `{specName}`), `COMMIT` (git_command, `""`), `CLEAR_CONTEXT` (llm_slash_command, `"clear"`).
2. In the integration test suite (real `cc-sdd.yaml` tests), add one assertion: load `cc-sdd`, find IMPLEMENTATION phase, assert `loopPhases` has length 4 and verify `phase` and `type` of each entry.

**Acceptance criteria**:
- `cc-sdd.yaml` parses through `YamlWorkflowDefinitionLoader.load("cc-sdd")` without errors.
- Integration test asserts IMPLEMENTATION phase has exactly 4 `loopPhases` entries with correct types.
- YAML change and integration test assertion are in the same commit.

---

## Task 7 — Test helper update in `tests/helpers/workflow.ts` [sequential]

**Design section**: 11.5 (Test helper)
**Dependencies**: Task 1

**Files to modify**:
- `orchestrator-ts/tests/helpers/workflow.ts`

**Changes**:
1. Import `LoopPhaseDefinition` from `@/domain/workflow/framework`.
2. Change `makeFrameworkDef()` signature to `makeFrameworkDef(options?: { loopPhases?: readonly LoopPhaseDefinition[] }): FrameworkDefinition`.
3. Spread `{ loopPhases: options.loopPhases }` into the IMPLEMENTATION phase definition when `options?.loopPhases` is defined.

**Acceptance criteria**:
- `makeFrameworkDef()` (no args) returns an identical definition to the current version.
- `makeFrameworkDef({ loopPhases: [...] })` returns a definition where the IMPLEMENTATION phase has `loopPhases` populated.
- All existing callers with no args continue to compile and pass without modification.

---

## Task 8a — Domain validation tests: `tests/domain/framework.test.ts` [parallel]

**Design section**: 11.1
**Dependencies**: Tasks 1 and 7

**Files to create**:
- `orchestrator-ts/tests/domain/framework.test.ts`

**Changes**: New test file with 6 tests for `validateFrameworkDefinition` with `loopPhases`:
1. Accepts valid `loop-phases`.
2. Throws on unknown loop-phase type.
3. Throws on `llm_slash_command` with empty content.
4. Throws on `llm_prompt` with empty content.
5. Accepts `git_command` with empty content.
6. Accepts absence of `loop-phases`.

**Acceptance criteria**:
- All 6 tests pass.
- Error messages in throw cases match the exact wording from `validateFrameworkDefinition`.

---

## Task 8b — YAML loader unit tests [parallel]

**Design section**: 11.2
**Dependencies**: Tasks 3, 6, and 7 (Task 6 writes to the same test file; must complete first)

**Files to modify**:
- `orchestrator-ts/tests/infra/sdd/yaml-workflow-definition-loader.test.ts`

**Changes**: Add 7 new unit `it` cases in the existing `"unit (tmpdir)"` describe block:
1. Parses `loop-phases` into `loopPhases` on the `PhaseDefinition`.
2. Entries have correct `phase`, `type`, `content`.
3. Throws when `loop-phases` is not an array.
4. Throws on unknown type in an entry.
5. Throws on missing `phase` name.
6. Absence → `loopPhases === undefined`.
7. `loop-phases` on non-`implementation_loop` phase → silently ignored.

**Acceptance criteria**:
- All 7 new tests pass.
- No existing tests broken.

---

## Task 8c — Phase Runner tests [parallel]

**Design section**: 11.3
**Dependencies**: Tasks 4 and 7

**Files to modify**:
- `orchestrator-ts/tests/domain/phase-runner.test.ts`

**Changes**: Add 7 new `it` cases inside the existing `"execute - IMPLEMENTATION phase with IImplementationLoop"` describe block:
1. `phaseDef.loopPhases` threaded into `implementationLoop.run` options.
2. Absent `phaseDef.loopPhases` → `run` called without `loopPhases`.
3. YAML `loopPhases` wins when DI options also has `loopPhases`.
4. `ctx.specDir` threaded as `specDir`.
5. `ctx.language` threaded as `language`.
6. `this.sdd` threaded as `sdd`.
7. `this.llm` threaded as `llm`.

**Acceptance criteria**:
- All 7 new tests pass.
- No existing phase-runner tests broken.

---

## Task 8d — Implementation Loop Service tests [parallel]

**Design section**: 11.4
**Dependencies**: Tasks 5 and 7

**Files to modify**:
- `orchestrator-ts/tests/application/services/implementation-loop/implementation-loop-service.test.ts`

**Changes**: Add a new `describe("configured loop-phases path")` block with 16 tests covering:
- Happy path: all sub-phases succeed → `"completed"`.
- `llm_slash_command` dispatched with `content + " " + task.id`.
- `SpecContext` fields correct.
- `llm_prompt` dispatched with interpolated content (including `{taskId}`).
- `git_command` dispatched via `stageAndCommit`.
- Failure paths for each sub-phase type.
- Fallback: `loopPhases` absent → `agentLoop.run` called.
- Fallback: `loopPhases` empty array → `agentLoop.run` called.
- `maxRetriesPerSection` respected.
- Missing `sdd` with `llm_slash_command` → descriptive error.
- Missing `llm` with `llm_prompt` → descriptive error.
- Commit SHA in `SectionExecutionRecord.commitSha`.

**Acceptance criteria**:
- All 16 new tests pass.
- No existing implementation-loop-service tests broken.

---

## Task 9 — Typecheck and full test suite [sequential]

**Dependencies**: All preceding tasks (1–8d)

**Actions**:
```bash
cd orchestrator-ts && bun run typecheck && bun test
```

**Acceptance criteria**:
- `bun run typecheck` exits 0 with no type errors.
- `bun test` exits 0; all pre-existing tests pass; all new tests in tasks 8a–8d pass.

---

## Execution Order Summary

```
Task 1 (framework.ts)
    └─> Task 2 (port)
            ├─> Task 3 (loader)    [parallel with Tasks 4, 5]
            ├─> Task 4 (runner)    [parallel with Tasks 3, 5]
            └─> Task 5 (service)   [parallel with Tasks 3, 4]

Task 1 ─> Task 7 (test helper)

After Tasks 3 + 7:  Task 8b (loader tests)    [parallel with 8a, 8c, 8d]
After Tasks 4 + 7:  Task 8c (runner tests)    [parallel with 8a, 8b, 8d]
After Tasks 5 + 7:  Task 8d (service tests)   [parallel with 8a, 8b, 8c]
After Tasks 1 + 7:  Task 8a (framework tests) [parallel with 8b, 8c, 8d]

Tasks 3 + 5 ─> Task 6 (cc-sdd.yaml + integration test)

All tasks ─> Task 9 (typecheck + test)
```
