# Workflow Customization

## Overview

This document describes how to adjust the automated workflow that runs via `aes run <spec>`.

Since the implementation of the `custom-sddfw-flow-management` feature, **all phase behavior is defined as data** in a framework definition file rather than hardcoded across multiple source files. To change workflow behavior, you primarily edit the framework definition file for your SDD framework.

Framework definitions are **YAML files** located at `.aes/workflow/<frameworkId>.yaml`. They are loaded at runtime by `YamlWorkflowDefinitionLoader` — no recompilation required.

---

## Quick Reference

| What you want to change | Where to change it |
|---|---|
| Phase list, order, types, prompts, required artifacts, approval gates | Framework definition YAML (e.g. `orchestrator-ts/.aes/workflow/cc-sdd.yaml`) |
| Framework identifier in project config | `.aes/config.json` → `sddFramework` field (defaults to `"cc-sdd"`) |
| Dispatch logic for a new execution type | `orchestrator-ts/src/application/services/workflow/phase-runner.ts` |
| Approval gate logic | `orchestrator-ts/src/application/services/workflow/approval-gate.ts` |
| SDD subprocess commands (for `llm_slash_command` phases) | `orchestrator-ts/src/infra/sdd/cc-sdd-adapter.ts` |
| Framework YAML loader | `orchestrator-ts/src/infra/sdd/yaml-workflow-definition-loader.ts` |
| Terminal output | `orchestrator-ts/src/adapters/cli/renderer.ts` |

---

## Framework Definition Files

Phase behavior for each SDD framework is defined in a single YAML file at `.aes/workflow/<frameworkId>.yaml`, loaded at runtime by `YamlWorkflowDefinitionLoader`.

**Domain interface:** `orchestrator-ts/src/domain/workflow/framework.ts`

```typescript
export interface PhaseDefinition {
  readonly phase: string;               // phase identifier
  readonly type: PhaseExecutionType;    // dispatch type (see below)
  readonly content: string;            // slash command name or inline prompt text
  readonly requiredArtifacts: readonly string[];  // files that must exist before this phase runs
  readonly approvalGate?: ApprovalPhase; // if set, pauses for human approval after this phase
  readonly approvalArtifact?: string;  // artifact path shown in the approval gate message
  readonly outputFile?: string;        // output file name for llm_prompt phases
}

export interface FrameworkDefinition {
  readonly id: string;                  // framework identifier (e.g. "cc-sdd")
  readonly phases: readonly PhaseDefinition[];  // phases in execution order
}
```

**Concrete cc-sdd definition:** `orchestrator-ts/.aes/workflow/cc-sdd.yaml`

This YAML file is the **single source of truth** for the cc-sdd workflow. It replaces the `REQUIRED_ARTIFACTS`, `APPROVAL_GATE_PHASES`, and `WORKFLOW_PHASES` constants that were previously scattered across source files.

---

## Phase Execution Types

Each phase declares a `type` that determines how `PhaseRunner` dispatches it:

| Type | Dispatch behavior |
|---|---|
| `llm_slash_command` | Invokes `SddFrameworkPort.executeCommand(content, ctx)` — runs a cc-sdd slash command as a subprocess |
| `llm_prompt` | Invokes `LlmProviderPort.complete(content)` — sends the inline prompt text directly to the LLM |
| `suspension` | Returns `{ ok: true }` immediately; the approval gate (if set) handles the pause |
| `human_interaction` | Returns `{ ok: true }` immediately; same semantics as `suspension` (legacy alias) |
| `implementation_loop` | Delegates to `IImplementationLoop.run(ctx.specName)`, or returns `{ ok: true }` as a stub if not wired |
| `git_command` | Returns `{ ok: true }` as a stub for future git/PR operations |

---

## cc-sdd Phase Reference

The cc-sdd framework defines 14 phases in order:

| Phase | Type | Content / Behavior |
|---|---|---|
| `SPEC_INIT` | `llm_slash_command` | `kiro:spec-init` |
| `HUMAN_INTERACTION` | `suspension` | Pauses — approval gate waits for user to seed `requirements.md` |
| `VALIDATE_PREREQUISITES` | `llm_prompt` | Verifies `requirements.md` exists and is non-empty |
| `SPEC_REQUIREMENTS` | `llm_slash_command` | `kiro:spec-requirements` |
| `VALIDATE_REQUIREMENTS` | `llm_prompt` | Reviews `requirements.md` for completeness and testability |
| `REFLECT_BEFORE_DESIGN` | `llm_prompt` | Synthesizes constraints and open questions from `requirements.md` |
| `VALIDATE_GAP` | `llm_slash_command` | `kiro:validate-gap` |
| `SPEC_DESIGN` | `llm_slash_command` | `kiro:spec-design` |
| `VALIDATE_DESIGN` | `llm_slash_command` | `kiro:validate-design` |
| `REFLECT_BEFORE_TASKS` | `llm_prompt` | Synthesizes design decisions and patterns from `design.md` |
| `SPEC_TASKS` | `llm_slash_command` | `kiro:spec-tasks` |
| `VALIDATE_TASKS` | `llm_prompt` | Reviews `tasks.md` for completeness and implementation readiness |
| `IMPLEMENTATION` | `implementation_loop` | Delegates to implementation loop service |
| `PULL_REQUEST` | `git_command` | Stub for future git/PR operation |

Approval gates pause after: `HUMAN_INTERACTION`, `SPEC_REQUIREMENTS`, `VALIDATE_DESIGN`, `SPEC_TASKS`.

Required artifacts are declared per-phase in the YAML file. For example, `VALIDATE_DESIGN` requires `design.md` to exist before it can run.

---

## Adding a New SDD Framework

To add support for a new SDD framework (e.g. `open-spec`) without modifying any orchestrator source files:

1. Create a YAML definition file: `orchestrator-ts/.aes/workflow/open-spec.yaml`
2. Implement the schema with your framework's phases (see `cc-sdd.yaml` as a reference).
3. Set `"sddFramework": "open-spec"` in `.aes/config.json`.

If an unknown framework identifier is configured, the orchestrator will fail at startup with an error indicating the missing YAML file path.

---

## Modifying cc-sdd Phase Behavior

**To change a prompt** for an `llm_prompt` phase, edit the `content` field in `.aes/workflow/cc-sdd.yaml`. The content supports `{specDir}` as a runtime placeholder.

**To add or remove required artifacts**, update `required_artifacts` for the relevant phase.

**To add or remove an approval gate**, set or clear `approval_gate` on the phase entry. Valid values are: `"human_interaction"`, `"requirements"`, `"design"`, `"tasks"`. Optionally set `approval_artifact` to specify which file is shown in the approval message.

**To reorder phases**, change the array order in the `phases` field. `WorkflowEngine` drives execution order from this array.

After editing the YAML, run the test suite (`bun test`) to verify structural validity — `validateFrameworkDefinition()` is called at load time and will surface issues such as duplicate phases, empty `content` on `llm_slash_command`/`llm_prompt` phases, or unknown `approval_gate` values.

---

## Approval Gate Logic

**`orchestrator-ts/src/application/services/workflow/approval-gate.ts`**

The `check()` method reads `spec.json` and looks for `approvals[phase].approved === true`. Modify here to:
- Change the approval key structure
- Add alternative approval mechanisms (e.g., environment variable bypass, time-based auto-approval)

---

## Wiring Optional Services

**`orchestrator-ts/src/main/di/run-container.ts`**

The DI container builds all dependencies and injects them into `RunSpecUseCase`. Edit here to:
- Wire in the `implementationLoop` (currently optional)
- Wire in the self-healing loop service
- Swap framework adapters

---

## Terminal Output

**`orchestrator-ts/src/adapters/cli/renderer.ts`**

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
SPEC_INIT → llm_slash_command (kiro:spec-init)
  ↓
HUMAN_INTERACTION → suspension → [PAUSED: user must seed requirements.md]
  ↓ (on approval)
VALIDATE_PREREQUISITES → llm_prompt (verify requirements.md)
  ↓
SPEC_REQUIREMENTS → llm_slash_command (kiro:spec-requirements) → [PAUSED if not approved]
  ↓ (on approval)
VALIDATE_REQUIREMENTS → llm_prompt (review requirements.md)
  ↓
REFLECT_BEFORE_DESIGN → llm_prompt (synthesize constraints)
  ↓
VALIDATE_GAP → llm_slash_command (kiro:validate-gap)
  ↓
SPEC_DESIGN → llm_slash_command (kiro:spec-design)
  ↓
VALIDATE_DESIGN → llm_slash_command (kiro:validate-design) → [PAUSED if not approved]
  ↓ (on approval)
REFLECT_BEFORE_TASKS → llm_prompt (synthesize design decisions)
  ↓
SPEC_TASKS → llm_slash_command (kiro:spec-tasks) → [PAUSED if not approved]
  ↓ (on approval)
VALIDATE_TASKS → llm_prompt (review tasks.md)
  ↓
IMPLEMENTATION → implementation_loop
  ↓
PULL_REQUEST → git_command stub
  ↓
[workflow:complete]
```

State is persisted to `.aes/state/<spec>.json` before each phase for crash recovery.
