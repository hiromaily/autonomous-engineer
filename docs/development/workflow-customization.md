# Workflow Customization

## Overview

This document describes which files to modify when adjusting the automated workflow that runs via `aes run <spec>`.

---

## Quick Reference

| What you want to change | File |
|---|---|
| Phase list / order | `orchestrator-ts/src/domain/workflow/types.ts` |
| Phase sequencing, gates, artifact checks | `orchestrator-ts/src/domain/workflow/workflow-engine.ts` |
| What each phase runs | `orchestrator-ts/src/domain/workflow/phase-runner.ts` |
| Approval gate logic | `orchestrator-ts/src/domain/workflow/approval-gate.ts` |
| SDD subprocess commands | `orchestrator-ts/src/adapters/sdd/cc-sdd-adapter.ts` |
| Dependency wiring | `orchestrator-ts/src/application/usecases/run-spec.ts` |
| Terminal output | `orchestrator-ts/src/cli/renderer.ts` |

---

## Phase Sequence

The phases are defined as a frozen const array. To add, remove, or reorder phases, edit:

**`orchestrator-ts/src/domain/workflow/types.ts`**

```typescript
export const WORKFLOW_PHASES = [
  "SPEC_INIT",
  "REQUIREMENTS",
  "DESIGN",
  "VALIDATE_DESIGN",
  "TASK_GENERATION",
  "IMPLEMENTATION",
  "PULL_REQUEST",
] as const;
```

The `WorkflowPhase` type is derived from this array, so TypeScript exhaustiveness checks across the codebase will catch any phase references that need updating.

---

## Phase Sequencing, Gates, and Artifact Checks

The core state machine loop is in:

**`orchestrator-ts/src/domain/workflow/workflow-engine.ts`**

Key constants to modify:

```typescript
// Which files must exist before a phase can run
REQUIRED_ARTIFACTS: Partial<Record<WorkflowPhase, readonly string[]>> = {
  DESIGN:           ["requirements.md"],
  VALIDATE_DESIGN:  ["design.md"],
  TASK_GENERATION:  ["design.md"],
  IMPLEMENTATION:   ["tasks.md"],
}

// Which phases trigger a human approval pause after completing
APPROVAL_GATE_PHASES: Partial<Record<WorkflowPhase, ApprovalPhase>> = {
  REQUIREMENTS:    "requirements",
  VALIDATE_DESIGN: "design",
  TASK_GENERATION: "tasks",
}
```

An additional gate before IMPLEMENTATION reads `spec.json` for `ready_for_implementation === true` in `checkReadyForImplementation()`. Modify or remove that method to change this behavior.

---

## What Each Phase Runs

Individual phase behavior is routed in:

**`orchestrator-ts/src/domain/workflow/phase-runner.ts`**

The `execute()` method switches on phase name:

| Phase | Current behavior |
|---|---|
| `SPEC_INIT` | Stub — returns success immediately |
| `REQUIREMENTS` | `sdd.generateRequirements(ctx)` |
| `DESIGN` | `sdd.generateDesign(ctx)` |
| `VALIDATE_DESIGN` | `sdd.validateDesign(ctx)` |
| `TASK_GENERATION` | `sdd.generateTasks(ctx)` |
| `IMPLEMENTATION` | `implementationLoop.run(ctx.specName)` (stub if not wired) |
| `PULL_REQUEST` | Stub — returns success immediately |

**Lifecycle hooks** on this class are called at every phase boundary:
- `onEnter(phase)` — currently clears the LLM context to prevent cross-phase bleed
- `onExit(phase)` — currently a no-op; available as an extension point

---

## Approval Gate Logic

**`orchestrator-ts/src/domain/workflow/approval-gate.ts`**

The `check()` method reads `spec.json` and looks for `approvals[phase].approved === true`.
Modify here to:
- Change the approval key structure
- Add alternative approval mechanisms (e.g., environment variable bypass, time-based auto-approval)
- Add or remove which phases require approval

---

## SDD Subprocess Commands

**`orchestrator-ts/src/adapters/sdd/cc-sdd-adapter.ts`**

Each `SddFrameworkPort` method maps to a cc-sdd CLI subprocess invocation. Edit here to:
- Change CLI arguments passed to cc-sdd
- Add support for a different SDD framework
- Change how artifacts are parsed or validated after generation

---

## Wiring Optional Services

**`orchestrator-ts/src/application/usecases/run-spec.ts`**

The `run()` method constructs all dependencies and passes them to `WorkflowEngine`. Edit here to:
- Wire in the `implementationLoop` (currently optional)
- Wire in the self-healing loop service
- Swap adapters (e.g., replace `CcSddAdapter` with a different SDD adapter)

---

## Terminal Output

**`orchestrator-ts/src/cli/renderer.ts`**

Handles how workflow events are displayed in the terminal. Edit here to change:
- Phase start/complete messages
- Approval gate instructions shown to the user
- Error and failure formatting

Event type definitions are in:
**`orchestrator-ts/src/application/ports/workflow.ts`**

---

## Workflow State Flow

```
[Initial State]
  ↓
SPEC_INIT → (stub)
  ↓
REQUIREMENTS → sdd.generateRequirements → [PAUSED if not approved]
  ↓ (on approval)
DESIGN → sdd.generateDesign → [PAUSED if not approved]
  ↓ (on approval)
VALIDATE_DESIGN → sdd.validateDesign
  ↓
TASK_GENERATION → sdd.generateTasks → [PAUSED if not approved]
  ↓ (on approval, + spec.json ready_for_implementation check)
IMPLEMENTATION → implementationLoop.run
  ↓
PULL_REQUEST → (stub)
  ↓
[workflow:complete]
```

State is persisted to `.aes/state/<spec>.json` before each phase for crash recovery.
