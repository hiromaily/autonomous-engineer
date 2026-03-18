# Deep Investigation Report: Issue #51 - YAML Workflow Definition Refactoring

## 1. Root Cause Analysis

### 1.1 Phase Definition is Hardcoded as TypeScript Constant

**File:** `src/infra/sdd/cc-sdd-framework-definition.ts` (127 lines)

All 14 phases exactly:
1. SPEC_INIT (llm_slash_command)
2. HUMAN_INTERACTION (human_interaction + approvalGate: "human_interaction")
3. VALIDATE_PREREQUISITES (llm_prompt, outputFile: "prerequisite-check.md")
4. SPEC_REQUIREMENTS (llm_slash_command + approvalGate: "requirements")
5. VALIDATE_REQUIREMENTS (llm_prompt, outputFile: "validation-requirements.md")
6. REFLECT_BEFORE_DESIGN (llm_prompt, outputFile: "reflect-before-design.md")
7. VALIDATE_GAP (llm_slash_command)
8. SPEC_DESIGN (llm_slash_command)
9. VALIDATE_DESIGN (llm_slash_command + approvalGate: "design")
10. REFLECT_BEFORE_TASKS (llm_prompt, outputFile: "reflect-before-tasks.md")
11. SPEC_TASKS (llm_slash_command + approvalGate: "tasks")
12. VALIDATE_TASKS (llm_prompt, outputFile: "validation-tasks.md")
13. IMPLEMENTATION (implementation_loop type)
14. PULL_REQUEST (git_command)

Phase distribution: 6 llm_slash_command, 5 llm_prompt, 1 human_interaction, 1 implementation_loop, 1 git_command.

### 1.2 Types Blocking Extensibility

**`WorkflowPhase` const union** (`src/domain/workflow/types.ts`):
```typescript
export const WORKFLOW_PHASES = Object.freeze([
  "SPEC_INIT", "HUMAN_INTERACTION", ..., "PULL_REQUEST"
] as const);
export type WorkflowPhase = (typeof WORKFLOW_PHASES)[number];
```

**`TypeScriptFrameworkDefinitionLoader`** (`src/infra/sdd/typescript-framework-definition-loader.ts`):
```typescript
const ALL_DEFINITIONS: readonly FrameworkDefinition[] = [CC_SDD_FRAMEWORK_DEFINITION];
```
Adding a new framework requires modifying TypeScript source and recompiling.

---

## 2. WorkflowPhase Type: Full Impact Analysis

### 2.1 All Files Using WorkflowPhase

| File | Change Needed |
|------|--------------|
| `src/domain/workflow/types.ts` | Change type definition + delete WORKFLOW_PHASES |
| `src/domain/workflow/framework.ts` | `PhaseDefinition.phase: string` |
| `src/application/services/workflow/phase-runner.ts` | `execute(phase: string)` |
| `src/application/services/workflow/workflow-engine.ts` | All usages work with `string` |
| `src/application/ports/workflow.ts` | WorkflowEvent `phase: string` |
| `tests/domain/workflow-types.test.ts` | MUST REWRITE — tests WORKFLOW_PHASES const |
| `tests/domain/workflow-engine.test.ts` | UPDATE — remove WORKFLOW_PHASES import |
| `tests/infra/sdd/cc-sdd-framework-definition.test.ts` | DELETE |

### 2.2 State File Compatibility

Phase names already stored as plain strings in JSON. Old state files load correctly with `string` type. However: when resuming, validate that `currentPhase` exists in loaded framework definition.

---

## 3. Approval Gate Hardcoded Switch

**`src/domain/workflow/approval-gate.ts` lines 65–79:**
```typescript
function artifactFilename(phase: ApprovalPhase): string {
  switch (phase) {
    case "human_interaction":
    case "requirements": return "requirements.md";
    case "design": return "design.md";
    case "tasks": return "tasks.md";
  }
}
```

**ApprovalGate integration points:**
- `src/domain/workflow/approval-gate.ts` — calls `artifactFilename()`
- `src/application/services/workflow/workflow-engine.ts` line 121 — calls `approvalGate.check()`
- `src/application/services/workflow/debug-approval-gate.ts` line 34 — hardcodes requirements.md

**Fix:** Add `approval_artifact?: string` to `PhaseDefinition`. Pass it through `workflow-engine.ts` to `approvalGate.check()`.

---

## 4. DI Container Wiring

**`src/main/di/run-container.ts`:**
- Lines 316–321: lazy getter creates `new TypeScriptFrameworkDefinitionLoader()`
- Lines 382–385: `build()` calls `this.frameworkDefinitionLoader.load(this.config.sddFramework)`

Change: Replace with `new YamlWorkflowDefinitionLoader()`.

---

## 5. YAML Library

**No YAML library in `package.json` currently.**

Must add: `js-yaml@^4.1.0` and `@types/js-yaml@^4.0.0`.

---

## 6. Edge Cases and Risks

### 6.1 Runtime Type Safety Loss
Compile-time safety of `WorkflowPhase` const union is lost.
**Mitigation:** `findPhaseDefinition()` throws if phase not found. State validation on resume.

### 6.2 Loop Type Semantics
IMPLEMENTATION is currently `type: "implementation_loop"` — a single monolithic call to `this.implementationLoop.run()`.

The YAML proposal shows `type: loop` with `steps`. This represents a **different semantic** — nested declarative steps vs. the existing implementation loop service.

**Decision needed:** Keep `implementation_loop` as-is (map to new `type: loop` in YAML but keep existing handling), OR support fully generic loop with nested steps. The simpler approach: the cc-sdd YAML uses `type: implementation_loop` directly (preserve existing), and `loop` is a new extension point for future use.

### 6.3 Approval Artifact Fallback
If YAML specifies `approval_gate: requirements` but omits `approval_artifact`, the system needs a fallback. Options:
- A) Require `approval_artifact` when `approval_gate` is set (strict)
- B) Fall back to hardcoded mapping (backward compat)

Recommendation: B for initial migration (keeps cc-sdd.yaml simpler), A for strict new frameworks.

---

## 7. Test Coupling

**92 references to CC_SDD_FRAMEWORK_DEFINITION** across codebase (mostly tests).

**5 files import WORKFLOW_PHASES:**
- `src/domain/workflow/types.ts` (definition) — delete
- `tests/domain/workflow-types.test.ts` — rewrite
- `tests/domain/workflow-engine.test.ts` — update
- `tests/infra/sdd/cc-sdd-framework-definition.test.ts` — delete

**Key helper already exists:** `tests/helpers/workflow.ts` contains `makeFrameworkDef()` with all 14 phases as a test framework. This is the blueprint for post-refactoring tests.

---

## 8. Open Questions

| # | Question | Recommendation |
|---|----------|---------------|
| 1 | `loop` type semantics — generic nested steps or preserve `implementation_loop`? | Keep `implementation_loop` in cc-sdd YAML; reserve `loop` as future extension |
| 2 | `approval_artifact` optional or required? | Optional with fallback to hardcoded mapping initially |
| 3 | YAML file location — `.aes/workflow/` relative to `process.cwd()`? | Yes, matches existing `.aes/state/` convention |
| 4 | `ApprovalPhase` type stay as literal union or change to `string`? | Keep literal union for now — approval gate types are still fixed in current design |

---

## 9. Implementation Scope

| Category | Lines | Complexity |
|----------|-------|-----------|
| New YAML file (cc-sdd.yaml) | ~150 | Low |
| Type changes (types.ts, framework.ts) | ~50 | Low |
| YamlWorkflowDefinitionLoader | ~80 | Medium |
| Phase runner updates | ~20 | Low |
| Approval gate refactoring | ~50 | Medium |
| DI wiring update | ~10 | Low |
| Test rewrites/updates | ~500+ | High |
| **Total** | **~860** | |
