# Design Document: YAML-Configurable `loop-phases` — Full Execution Model

**Revision**: 2 (full execution model)

---

## 1. Problem Statement

The `implementation_loop` phase type in the YAML workflow definition should drive per-task execution. Currently, the sub-phase sequence (implement → validate → commit) is hardcoded inside `ImplementationLoopService`. This design makes it configurable via `loop-phases` in the YAML file and implements the full execution model.

**Execution model the user expects:**
```
For each task in tasks.md:
  1. llm_slash_command: kiro:spec-impl {taskId}
  2. llm_prompt: validate implementation
  3. git_command: commit
Repeat until all tasks done → exit
```

---

## 2. Domain Model Changes

### File: `orchestrator-ts/src/domain/workflow/framework.ts`

#### 2.1 New type: `LoopPhaseExecutionType`

```typescript
export type LoopPhaseExecutionType =
  | "llm_slash_command"
  | "llm_prompt"
  | "git_command";
```

`human_interaction`, `suspension`, and `implementation_loop` are excluded — meaningless inside a loop iteration.

#### 2.2 New constant: `VALID_LOOP_PHASE_EXECUTION_TYPES`

```typescript
export const VALID_LOOP_PHASE_EXECUTION_TYPES = new Set<string>([
  "llm_slash_command", "llm_prompt", "git_command",
]);
```

#### 2.3 New interface: `LoopPhaseDefinition`

```typescript
/**
 * Definition for a single sub-phase that runs inside each iteration of an implementation_loop.
 * Intentionally minimal — omits orchestration fields (approvalGate, requiredArtifacts, etc.)
 * that have no meaning within a per-task iteration.
 */
export interface LoopPhaseDefinition {
  /** Logical name, e.g. "SPEC_IMPL". Used in logging only. */
  readonly phase: string;
  /** Execution type. Only llm_slash_command, llm_prompt, git_command are valid. */
  readonly type: LoopPhaseExecutionType;
  /**
   * For llm_slash_command: the command name (e.g. "kiro:spec-impl"). Task ID is always
   *   appended automatically as " {taskId}" by the service. Do NOT include {taskId} here.
   * For llm_prompt: the prompt template. Supports {specName}, {specDir}, {language}, {taskId}.
   * For git_command: empty string (commit behavior is hardcoded in the service).
   */
  readonly content: string;
}
```

#### 2.4 Updated interface: `PhaseDefinition`

Add one optional field:

```typescript
export interface PhaseDefinition {
  readonly phase: string;
  readonly type: PhaseExecutionType;
  readonly content: string;
  readonly requiredArtifacts: readonly string[];
  readonly approvalGate?: ApprovalPhase;
  readonly approvalArtifact?: string;
  readonly outputFile?: string;
  /**
   * For implementation_loop phases only: the ordered list of sub-phases to execute
   * in each task iteration. When absent, the service uses its hardcoded default sequence.
   */
  readonly loopPhases?: readonly LoopPhaseDefinition[];
}
```

#### 2.5 Updated validation: `validateFrameworkDefinition`

```typescript
if (p.type === "implementation_loop" && p.loopPhases !== undefined) {
  for (const [i, lp] of p.loopPhases.entries()) {
    if (!lp.phase || lp.phase.trim() === "") {
      throw new Error(
        `Framework "${def.id}" phase "${p.phase}": loop-phases[${i}] is missing a "phase" name`,
      );
    }
    if (!VALID_LOOP_PHASE_EXECUTION_TYPES.has(lp.type)) {
      throw new Error(
        `Framework "${def.id}" phase "${p.phase}": loop-phases[${i}] ("${lp.phase}") has invalid type "${lp.type}". ` +
        `Valid loop phase types: ${[...VALID_LOOP_PHASE_EXECUTION_TYPES].join(", ")}`,
      );
    }
    if ((lp.type === "llm_slash_command" || lp.type === "llm_prompt") && lp.content === "") {
      throw new Error(
        `Framework "${def.id}" phase "${p.phase}": loop-phases[${i}] ("${lp.phase}") ` +
        `(type: ${lp.type}) must have non-empty content`,
      );
    }
  }
}
```

---

## 3. YAML Loader Changes

### File: `orchestrator-ts/src/infra/sdd/yaml-workflow-definition-loader.ts`

#### 3.1 Import additions

Add `LoopPhaseDefinition`, `LoopPhaseExecutionType`, and `VALID_LOOP_PHASE_EXECUTION_TYPES` to the domain import.

**Note on `VALID_EXECUTION_TYPES` consistency**: The loader currently has its own file-local `VALID_EXECUTION_TYPES` constant. The new `VALID_LOOP_PHASE_EXECUTION_TYPES` lives in `framework.ts` and is imported. Moving `VALID_EXECUTION_TYPES` to `framework.ts` is a separate refactor outside this scope.

#### 3.2 New private method: `toLoopPhaseDefinition`

```typescript
private toLoopPhaseDefinition(
  raw: unknown,
  parentPhase: string,
  filePath: string,
  index: number,
): LoopPhaseDefinition {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(
      `loop-phases[${index}] in phase "${parentPhase}" of "${filePath}" is not an object`,
    );
  }
  const lp = raw as Record<string, unknown>;
  if (typeof lp["phase"] !== "string" || lp["phase"].trim() === "") {
    throw new Error(
      `loop-phases[${index}] in phase "${parentPhase}" of "${filePath}" is missing a "phase" name`,
    );
  }
  const type = lp["type"] as string;
  if (!VALID_LOOP_PHASE_EXECUTION_TYPES.has(type)) {
    throw new Error(
      `loop-phases[${index}] ("${lp["phase"]}") in phase "${parentPhase}" of "${filePath}" ` +
      `has unknown type "${type}". Valid types: ${[...VALID_LOOP_PHASE_EXECUTION_TYPES].join(", ")}`,
    );
  }
  return {
    phase: lp["phase"] as string,
    type: type as LoopPhaseExecutionType,
    content: typeof lp["content"] === "string" ? lp["content"] : "",
  };
}
```

#### 3.3 Updated `toPhaseDefinition`

Add `loop-phases` parsing after existing optional field spreads:

```typescript
...((() => {
  if (type !== "implementation_loop") return {};
  const raw = p["loop-phases"];
  if (raw === undefined) return {};
  if (!Array.isArray(raw)) {
    throw new Error(
      `Phase "${p["phase"]}" in "${filePath}": "loop-phases" must be an array`,
    );
  }
  return {
    loopPhases: raw.map((lp, i) =>
      this.toLoopPhaseDefinition(lp, p["phase"] as string, filePath, i),
    ),
  };
})()),
```

`loop-phases` on non-`implementation_loop` phases is silently ignored.

---

## 4. Port Changes

### File: `orchestrator-ts/src/application/ports/implementation-loop.ts`

Add five new optional fields to `ImplementationLoopOptions`. These follow the existing pattern of injecting optional service instances via options:

```typescript
import type { LoopPhaseDefinition } from "@/domain/workflow/framework";
import type { SddFrameworkPort } from "@/application/ports/sdd";
import type { LlmProviderPort } from "@/application/ports/llm";

export type ImplementationLoopOptions = Readonly<{
  maxRetriesPerSection: number;
  qualityGateConfig: QualityGateConfig;
  /** Sub-phases to execute in each task iteration. When absent, uses hardcoded default sequence. */
  loopPhases?: readonly LoopPhaseDefinition[];
  /** SDD adapter for executing llm_slash_command loop-phases. Required when loopPhases includes llm_slash_command. */
  sdd?: SddFrameworkPort;
  /** LLM provider for executing llm_prompt loop-phases. Required when loopPhases includes llm_prompt. */
  llm?: LlmProviderPort;
  /** Spec directory path for SpecContext construction inside the loop. */
  specDir?: string;
  /** Language code for SpecContext construction and interpolation. */
  language?: string;
  selfHealingLoop?: ISelfHealingLoop;
  eventBus?: IImplementationLoopEventBus;
  logger?: IImplementationLoopLogger;
  contextEngine?: IContextEngine;
  agentEventBus?: IAgentEventBus;
}>;
```

Also update the JSDoc comment on the type to reflect that `loopPhases`, `sdd`, `llm`, `specDir`, and `language` are user-facing optional fields, not just service instances.

---

## 5. Phase Runner Changes

### File: `orchestrator-ts/src/application/services/workflow/phase-runner.ts`

The `PhaseRunner` already has `this.sdd` and `this.llm` as fields (used for `llm_slash_command` and `llm_prompt` phases). These must be threaded into the merged options for the `implementation_loop` case alongside `loopPhases`, `specDir`, and `language`.

Updated `case "implementation_loop"` in `execute()`:

```typescript
case "implementation_loop": {
  if (this.implementationLoop) {
    // DI-provided options win on most fields, but loopPhases from YAML must NOT be
    // overridden by DI (DI containers never carry loopPhases intentionally; if they did
    // it would silently discard the user's YAML configuration). loopPhases is therefore
    // spread AFTER the DI options so it always takes final precedence.
    const mergedOptions: Partial<ImplementationLoopOptions> = {
      // Thread SpecContext fields and service adapters from PhaseRunner's own deps
      specDir: ctx.specDir,
      language: ctx.language,
      sdd: this.sdd,
      llm: this.llm,
      // DI-provided options take precedence over the above defaults
      ...(this.implementationLoopOptions ?? {}),
      // YAML-configured loop phases always win — spread last so DI cannot accidentally
      // override the user's explicit YAML configuration
      ...(phaseDef.loopPhases !== undefined ? { loopPhases: phaseDef.loopPhases } : {}),
    };
    const result = await this.implementationLoop.run(
      ctx.specName,
      Object.keys(mergedOptions).length > 0 ? mergedOptions : undefined,
    );
    if (result.outcome === "completed") {
      return { ok: true, artifacts: [] };
    }
    return { ok: false, error: result.haltReason ?? result.outcome };
  }
  return { ok: true, artifacts: [] };
}
```

---

## 6. Implementation Loop Service Changes

### File: `orchestrator-ts/src/application/services/implementation-loop/implementation-loop-service.ts`

#### 6.1 New module-level helper: `interpolateLoopPhase`

```typescript
function interpolateLoopPhase(template: string, vars: {
  specName: string;
  specDir: string;
  language: string;
  taskId: string;
}): string {
  return template
    .replaceAll("{specName}", vars.specName)
    .replaceAll("{specDir}", vars.specDir)
    .replaceAll("{language}", vars.language)
    .replaceAll("{taskId}", vars.taskId);
}
```

This is called inside the implementation loop where `task.id` is known, not in `phase-runner.ts`.

**Convention for `llm_slash_command`**: The `content` field holds only the command name (e.g. `"kiro:spec-impl"`). The task ID is always appended as `" " + task.id` by the service after interpolation. `{taskId}` should NOT appear in `llm_slash_command` content — it is meaningful only in `llm_prompt` content.

#### 6.2 New private method: `#executeConfiguredPhases`

```typescript
private async #executeConfiguredPhases(
  loopPhases: readonly LoopPhaseDefinition[],
  task: Task,
  plan: TaskPlan,
  options: Required<ImplementationLoopOptions>,
): Promise<{ ok: true; commitSha?: string } | { ok: false; error: string }>
```

Inside the method, `plan.id` is used as `specName` when constructing `SpecContext`.

Behavior per sub-phase type:

**`llm_slash_command`:**
- If `options.sdd` is undefined, return `{ ok: false, error: "SDD adapter not configured for llm_slash_command loop-phase \"${lp.phase}\"" }`.
- Build `specCtx = { specName: plan.id, specDir: options.specDir ?? "", language: options.language ?? "en" }`.
- Build full command string: `interpolateLoopPhase(lp.content, vars) + " " + task.id`. This combined string is passed as the `commandName` argument — e.g. `"kiro:spec-impl task-3"`.
- Call `options.sdd.executeCommand(commandName, specCtx)`.
- If result is `{ ok: false }`, return `{ ok: false, error: result.error.stderr.trim() || "SDD adapter failed (exit " + result.error.exitCode + ")" }`. (Mirrors the extraction pattern in `PhaseRunner.mapSddResult`.)

**`llm_prompt`:**
- If `options.llm` is undefined, return `{ ok: false, error: "LLM provider not configured for llm_prompt loop-phase \"${lp.phase}\"" }`.
- Call `options.llm.complete(interpolateLoopPhase(lp.content, vars))`.
- If result is `{ ok: false }`, return `{ ok: false, error: result.error.message }`.
- On ok, the response content is discarded (no debug logging — `IImplementationLoopLogger` has no debug method). The `ok` status of the LLM call is the sole pass/fail signal.

**`git_command`:**
- Call `this.#gitController.detectChanges()` then `this.#gitController.stageAndCommit(files, "feat: " + task.title)`.
- If commit fails, return `{ ok: false, error: ... }`.
- On success, return `{ ok: true, commitSha: result.sha }`.

If all sub-phases succeed, return `{ ok: true, commitSha }` where `commitSha` comes from the `git_command` sub-phase (if any).

#### 6.3 Branch in `#executeSection`

At the top of `#executeSection`, before the `while(true)` loop:

```typescript
const useConfiguredPhases =
  options.loopPhases !== undefined && options.loopPhases.length > 0;
```

Inside the `while(true)` loop body:

```typescript
if (useConfiguredPhases) {
  const result = await this.#executeConfiguredPhases(options.loopPhases!, task, plan, options);
  if (result.ok) {
    return buildSectionRecord(task, plan.id, "completed", retryCount, iterations, sectionStartAt, result.commitSha, undefined);
  } else {
    retryCount++;
    const feedback: ReviewFeedbackItem[] = [{
      category: "requirement-alignment",
      description: result.error,
      severity: "blocking",
    }];
    // ... build iteration record, push to iterations, check maxRetriesPerSection, escalate if needed
    continue;
  }
} else {
  // Existing hardcoded path — UNCHANGED
  ...
}
```

#### 6.4 `contextEngine.resetTask()` and `contextProvider`

At the start of each section (before the while loop), `options.contextEngine?.resetTask(task.id)` must still be called regardless of which path is active. This provides task context isolation for LLM calls.

However, `contextProvider` (built from the context engine to pass to `#agentLoop.run()`) must **only be built in the hardcoded path**. The configured-phases path does not call `#agentLoop.run()`, so constructing the `contextProvider` adapter would be wasted work. The `contextProvider` construction line must be moved to inside the `else` (hardcoded) branch, after the `useConfiguredPhases` branch check.

#### 6.5 `DEFAULT_OPTIONS` update

```typescript
const DEFAULT_OPTIONS: Required<ImplementationLoopOptions> = {
  maxRetriesPerSection: 3,
  qualityGateConfig: { checks: [] },
  loopPhases: undefined as never,
  sdd: undefined as never,
  llm: undefined as never,
  specDir: undefined as never,
  language: undefined as never,
  selfHealingLoop: undefined as never,
  eventBus: undefined as never,
  logger: undefined as never,
  contextEngine: undefined as never,
  agentEventBus: undefined as never,
};
```

(`undefined as never` is the existing convention in this file for optional service dependencies.)

---

## 7. YAML Example

```yaml
- phase: IMPLEMENTATION
  type: implementation_loop
  content: ""
  required_artifacts:
    - tasks.md
  loop-phases:
    - phase: SPEC_IMPL
      type: llm_slash_command
      content: "kiro:spec-impl"
    - phase: VALIDATE_IMPL
      type: llm_prompt
      content: |
        Review the implementation of task {taskId} in spec {specName}.
        Check that the implementation satisfies the requirements and follows the design.
        Identify any gaps, errors, or quality issues.
    - phase: COMMIT
      type: git_command
      content: ""
    - phase: CLEAR_CONTEXT
      type: llm_slash_command
      content: "clear"
```

When `loop-phases` is absent, the existing IMPLEMENTATION phase continues to work identically (hardcoded path, no behavioral change).

---

## 8. Retry Logic

When using configured loop-phases, the entire sub-phase sequence for a task counts as one attempt. If any sub-phase fails, `retryCount` increments. When `retryCount >= maxRetriesPerSection`, `#escalateSection` is called exactly as in the hardcoded path. The sequence is retried from the first sub-phase (no "improve prompt" concept in the configured path — the feedback is the sub-phase error message).

---

## 9. Fallback Behavior (No Regression)

`useConfiguredPhases = false` when `options.loopPhases` is `undefined` or empty. The hardcoded path runs unchanged. All existing tests continue to pass.

---

## 10. Backward Compatibility

| Scenario | Behavior |
|---|---|
| Existing YAML without `loop-phases` | `useConfiguredPhases = false`; all existing behavior unchanged |
| New YAML with `loop-phases` | Configured execution path activated |
| `loopPhases` present but `sdd` not wired | Fails with descriptive error only if an `llm_slash_command` sub-phase is reached |
| Persisted workflow state | State stores only phase names — no migration needed |
| `makeFrameworkDef()` called with no args | Returns same definition as before (zero-arg backward compat) |

---

## 11. Test Strategy

### 11.1 Domain layer — `framework.ts`

File: `orchestrator-ts/tests/domain/framework.test.ts`

| Test | Verifies |
|---|---|
| Accepts valid `loop-phases` in `validateFrameworkDefinition` | Happy path |
| Throws on unknown loop-phase type | Type restriction |
| Throws on `llm_slash_command` with empty content | Required content |
| Throws on `llm_prompt` with empty content | Required content |
| Accepts `git_command` with empty content | Empty content allowed |
| Accepts absence of `loop-phases` | Backward compat |

### 11.2 Infrastructure — YAML loader

File: `orchestrator-ts/tests/infra/sdd/yaml-workflow-definition-loader.test.ts`

| Test | Verifies |
|---|---|
| Parses `loop-phases` array into `loopPhases` on parsed `PhaseDefinition` | Happy path |
| Entries have correct `phase`, `type`, `content` | Field mapping |
| Throws when `loop-phases` is not an array | Type validation |
| Throws on unknown type in loop-phases entry | Type restriction |
| Throws on missing `phase` name | Required field |
| Absence → `loopPhases === undefined` | Backward compat |
| `loop-phases` on non-`implementation_loop` phase → silently ignored | Forward compat |
| Integration: real `cc-sdd.yaml` IMPLEMENTATION phase has 4 loopPhases (must land same commit as YAML change) | End-to-end |

### 11.3 Application — Phase Runner

File: `orchestrator-ts/tests/domain/phase-runner.test.ts` (add inside existing `"IMPLEMENTATION phase"` describe block)

| Test | Verifies |
|---|---|
| `phaseDef.loopPhases` threaded into `implementationLoop.run` options | Core threading |
| Absent `phaseDef.loopPhases` → `run` called without `loopPhases` in options | Backward compat |
| YAML `loopPhases` wins even when DI `implementationLoopOptions` also contains `loopPhases` | Merge precedence: YAML loopPhases is spread last |
| `ctx.specDir` threaded as `specDir` | SpecContext threading |
| `ctx.language` threaded as `language` | SpecContext threading |
| `this.sdd` threaded as `sdd` | Adapter threading |
| `this.llm` threaded as `llm` | Adapter threading |

### 11.4 Implementation Loop Service

File: `orchestrator-ts/tests/application/services/implementation-loop/implementation-loop-service.test.ts`

| Test | Verifies |
|---|---|
| `llm_slash_command` sub-phase calls `sdd.executeCommand` with `content + " " + task.id` | Slash command dispatch |
| Slash command receives correct `SpecContext` (specName, specDir, language) | Context construction |
| `llm_prompt` sub-phase calls `llm.complete` with interpolated prompt | LLM prompt dispatch |
| `{taskId}` in `llm_prompt` content replaced with `task.id` | Task ID interpolation |
| `{specName}`, `{specDir}`, `{language}` replaced correctly in `llm_prompt` | Other interpolations |
| `git_command` sub-phase calls `gitController.stageAndCommit` | Git dispatch |
| All sub-phases succeed → section `"completed"` | Happy path |
| `llm_slash_command` fails → `retryCount` increments | Failure path |
| `llm_prompt` fails → `retryCount` increments | Failure path |
| `git_command` fails → section fails | Git failure |
| `loopPhases` absent → `agentLoop.run` is called (no regression) | Fallback |
| `loopPhases` empty array → `agentLoop.run` is called (no regression) | Empty array fallback |
| `maxRetriesPerSection` respected with configured phases | Retry logic |
| `sdd` absent with `llm_slash_command` sub-phase → descriptive error | Missing dependency |
| `llm` absent with `llm_prompt` sub-phase → descriptive error | Missing dependency |
| Commit SHA from `git_command` sub-phase appears in `SectionExecutionRecord.commitSha` | Commit SHA propagation |

### 11.5 Test helper

File: `orchestrator-ts/tests/helpers/workflow.ts`

Update `makeFrameworkDef` to accept optional `loopPhases`:
```typescript
function makeFrameworkDef(options?: { loopPhases?: readonly LoopPhaseDefinition[] }): FrameworkDefinition
```
Zero-arg call must remain valid. All 6+ existing callers must NOT be modified.

---

## 12. File Change Summary

| File | Change | Description |
|---|---|---|
| `src/domain/workflow/framework.ts` | Modify | Add `LoopPhaseExecutionType`, `LoopPhaseDefinition`, `VALID_LOOP_PHASE_EXECUTION_TYPES`; `loopPhases?` on `PhaseDefinition`; loop-phases validation in `validateFrameworkDefinition` |
| `src/infra/sdd/yaml-workflow-definition-loader.ts` | Modify | Add `toLoopPhaseDefinition`; parse `loop-phases` in `toPhaseDefinition` |
| `src/application/ports/implementation-loop.ts` | Modify | Add `loopPhases?`, `sdd?`, `llm?`, `specDir?`, `language?` to `ImplementationLoopOptions`; update JSDoc; add imports |
| `src/application/services/workflow/phase-runner.ts` | Modify | Thread `loopPhases`, `specDir`, `language`, `sdd`, `llm` into merged options for `implementation_loop` case |
| `src/application/services/implementation-loop/implementation-loop-service.ts` | Modify | Add `interpolateLoopPhase` helper; add `#executeConfiguredPhases` method; add `useConfiguredPhases` branch; update `DEFAULT_OPTIONS` |
| `.aes/workflow/cc-sdd.yaml` | Modify | Add `loop-phases` block to IMPLEMENTATION phase (same commit as integration test) |
| `tests/domain/framework.test.ts` | New/modify | Validation tests for loop-phases |
| `tests/infra/sdd/yaml-workflow-definition-loader.test.ts` | Modify | `loop-phases` parsing tests |
| `tests/domain/phase-runner.test.ts` | Modify | Add tests for all newly threaded fields |
| `tests/helpers/workflow.ts` | Modify | Update `makeFrameworkDef` with optional `loopPhases` param |
| `tests/application/services/implementation-loop/implementation-loop-service.test.ts` | Modify | All behavioral tests for `#executeConfiguredPhases` |

---

## 13. Implementation Sequence

1. `framework.ts` — domain types and constants
2. `implementation-loop.ts` — port interface additions + imports
3. `yaml-workflow-definition-loader.ts` — parsing and validation
4. `phase-runner.ts` — threading of all new fields
5. `implementation-loop-service.ts` — `interpolateLoopPhase`, `#executeConfiguredPhases`, branch logic, `DEFAULT_OPTIONS`
6. `cc-sdd.yaml` + integration test assertion — must land in same commit
7. `tests/helpers/workflow.ts` — `makeFrameworkDef` signature update
8. All test files — in the same order as source changes
9. `cd orchestrator-ts && bun run typecheck && bun test`
