# Current State Analysis: Issue #51 - YAML Workflow Definition Refactoring

## Overview

The task is to replace hardcoded TypeScript framework definitions with YAML workflow files, making the system extensible to multiple SDD frameworks without code changes. The current implementation is TypeScript-based and non-extensible.

---

## 1. Relevant Files and Directories

### Core Files to be Modified/Deleted

| File | Purpose | Status |
|---|---|---|
| `src/infra/sdd/cc-sdd-framework-definition.ts` | Hardcoded cc-sdd workflow as TypeScript constant (127 lines) | TO DELETE |
| `src/infra/sdd/typescript-framework-definition-loader.ts` | In-process registry loader (32 lines) | TO REPLACE |
| `src/domain/workflow/types.ts` | `WorkflowPhase` fixed const union, `WORKFLOW_PHASES` const | TO MODIFY |
| `src/domain/workflow/framework.ts` | Type definitions for phases and framework | TO EXTEND |
| `src/domain/workflow/approval-gate.ts` | Hardcoded artifact mapping via `artifactFilename()` | TO MODIFY |
| `src/application/ports/sdd.ts` | SDD framework port interface | OK AS-IS |
| `src/application/ports/framework.ts` | `FrameworkDefinitionPort` interface | OK AS-IS |
| `src/application/services/workflow/phase-runner.ts` | Executes phases; uses `PhaseDefinition` | OK AS-IS |
| `src/application/services/workflow/workflow-engine.ts` | Orchestrates workflow; uses framework definition | OK AS-IS |

### New Files to be Created

| Path | Purpose |
|---|---|
| `.aes/workflow/cc-sdd.yaml` | YAML workflow definition for cc-sdd framework (14 phases) |
| `src/infra/sdd/yaml-workflow-definition-loader.ts` | YAML loader implementation |

### Test Files (Existing)

| Test File | Coverage |
|---|---|
| `tests/infra/sdd/typescript-framework-definition-loader.test.ts` | Tests TypeScript loader (34 lines) - TO DELETE |
| `tests/infra/sdd/cc-sdd-framework-definition.test.ts` | Tests cc-sdd constant (255 lines) - TO REPLACE |
| `tests/domain/workflow-framework.test.ts` | Tests framework types (241 lines) - UPDATE |
| `tests/domain/approval-gate.test.ts` | Tests approval gate logic (191 lines) - UPDATE |
| `tests/domain/workflow-engine.test.ts` | Tests workflow engine - UPDATE |
| `tests/integration/workflow-engine.integration.test.ts` | E2E workflow tests - UPDATE |
| `tests/main/run-container-di-logging.test.ts` | Tests DI container loading - UPDATE |

---

## 2. Key Interfaces, Types, and Data Flows

### Current Type Hierarchy

```typescript
// types.ts
export const WORKFLOW_PHASES = ["SPEC_INIT", "HUMAN_INTERACTION", ..., "PULL_REQUEST"];
export type WorkflowPhase = typeof WORKFLOW_PHASES[number]; // Fixed const union

export interface WorkflowState {
  currentPhase: WorkflowPhase;        // HARDCODED to const union
  completedPhases: readonly WorkflowPhase[];
}
```

### Framework Definition (Current)

```typescript
// framework.ts
export type PhaseExecutionType =
  | "llm_slash_command"
  | "llm_prompt"
  | "human_interaction"
  | "git_command"
  | "implementation_loop";

export interface PhaseDefinition {
  phase: WorkflowPhase;              // Uses const union type
  type: PhaseExecutionType;
  content: string;
  requiredArtifacts: readonly string[];
  approvalGate?: ApprovalPhase;
  outputFile?: string;
}
```

### Approval Gate (Current)

```typescript
// approval-gate.ts
export type ApprovalPhase = "human_interaction" | "requirements" | "design" | "tasks";

function artifactFilename(phase: ApprovalPhase): string {
  // HARDCODED SWITCH - maps phase to filename
  case "requirements": return "requirements.md";
  case "design": return "design.md";
  case "tasks": return "tasks.md";
}
```

### DI Container Wiring

`src/main/di/run-container.ts` wires `TypeScriptFrameworkDefinitionLoader`, called in `build()` with `this.config.sddFramework`.

### Data Flow: Phase Execution

```
WorkflowEngine
  ├─ loads FrameworkDefinition via FrameworkDefinitionPort
  ├─ pendingPhases() iterates over framework.phases
  ├─ PhaseRunner.execute(phase)
  │   ├─ findPhaseDefinition(framework, phase)
  │   ├─ switch(phaseDef.type) to handle phase type
  │   └─ writes outputFile if llm_prompt
  └─ checkApprovalGate(phase) via ApprovalGate.check()
      └─ artifactFilename(phase) — HARDCODED MAPPING
```

---

## 3. Technical Constraints and Debt

1. `WorkflowPhase` const union — compile-time safety will be lost when switching to `string`
2. `artifactFilename()` hardcoded switch — cannot map arbitrary YAML phase names to artifacts
3. No `loop` or `suspension` types in current `PhaseExecutionType`
4. No `approval_artifact` field in current `PhaseDefinition`
5. Tests couple to TypeScript constants (CC_SDD_FRAMEWORK_DEFINITION) and WORKFLOW_PHASES

---

## 4. Summary

### What Needs to Change

1. Delete TypeScript constant and loader
2. Create YAML workflow file with all 14 phases
3. Create YAML loader that reads `.aes/workflow/{id}.yaml`
4. Change `WorkflowPhase` from const union to `string`
5. Remove `WORKFLOW_PHASES` const
6. Extend `FrameworkDefinition` types to include `loop` and `suspension` phases
7. Update `ApprovalGate` to read `approval_artifact` from phase definition instead of hardcoded mapping
8. Update all tests to work with dynamic phase names and YAML loading
9. Update DI container to wire `YamlWorkflowDefinitionLoader`
