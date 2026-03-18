# Design Document: YAML Workflow Definition Refactoring (Issue #51)

## 1. Chosen Approach and Rationale

**Runtime YAML loading via `js-yaml`, located at `.aes/workflow/{id}.yaml`**

The existing `TypeScriptFrameworkDefinitionLoader` requires recompilation to add a new SDD framework. The YAML approach separates data from code: a new framework needs only a new YAML file dropped into `.aes/workflow/`. This aligns with the `.aes/state/` convention already in the codebase.

**Why `js-yaml`:** v4 is the industry-standard safe parser, zero runtime dependencies. `js-yaml` v4 ships its own TypeScript declarations — no `@types/js-yaml` needed.

### Key Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| `WorkflowPhase` type | Change to `string` | Compile-time union was fictional safety; `findPhaseDefinition()` throws at runtime for unknown phases |
| `loop` type semantics | Keep `implementation_loop` in YAML; reserve `loop` as future extension | Full declarative loop engine is out of scope |
| `approval_artifact` | Optional with fallback to hardcoded mapping | Backward compat; cc-sdd YAML explicitly sets it for documentation value |
| `ApprovalPhase` | Keep as literal union | Approval gate protocol is stable; `validateFrameworkDefinition()` guards YAML values |

---

## 2. Architectural Changes

### Files to Delete

| File | Reason |
| --- | --- |
| `src/infra/sdd/cc-sdd-framework-definition.ts` | Replaced by `.aes/workflow/cc-sdd.yaml` |
| `src/infra/sdd/typescript-framework-definition-loader.ts` | Replaced by `yaml-workflow-definition-loader.ts` |
| `tests/infra/sdd/typescript-framework-definition-loader.test.ts` | Tests deleted class |
| `tests/infra/sdd/cc-sdd-framework-definition.test.ts` | Tests deleted constant |

### Files to Create

| File | Purpose |
| --- | --- |
| `src/infra/sdd/yaml-workflow-definition-loader.ts` | Runtime YAML loader implementing `FrameworkDefinitionPort` |
| `.aes/workflow/cc-sdd.yaml` | YAML definition for the cc-sdd workflow (14 phases) |
| `tests/infra/sdd/yaml-workflow-definition-loader.test.ts` | Tests for YAML loader |

### Files to Modify

| File | Change |
| --- | --- |
| `src/domain/workflow/types.ts` | Remove `WORKFLOW_PHASES` const; change `WorkflowPhase` to `string` |
| `src/domain/workflow/framework.ts` | Add `suspension` to `PhaseExecutionType`; add `approvalArtifact?: string`; change `phase: string` |
| `src/domain/workflow/approval-gate.ts` | Add optional `approvalArtifact?: string` to `check()`/`checkResume()` |
| `src/application/services/workflow/workflow-engine.ts` | Pass `approvalArtifact` from phase definition to approval gate |
| `src/application/services/workflow/phase-runner.ts` | Add `suspension` case; change `phase: string` |
| `src/application/services/workflow/debug-approval-gate.ts` | Align `check()` signature |
| `src/main/di/run-container.ts` | Replace `TypeScriptFrameworkDefinitionLoader` with `YamlWorkflowDefinitionLoader` |
| `package.json` | Add `js-yaml@^4.1.0` dependency |
| `tests/domain/workflow-types.test.ts` | Remove `WORKFLOW_PHASES` tests |
| `tests/domain/workflow-framework.test.ts` | Add `suspension` case |
| `tests/domain/approval-gate.test.ts` | Add `approvalArtifact` override test |
| `tests/main/run-container-di-logging.test.ts` | Update error message expectation |

---

## 3. YAML Schema — Full cc-sdd.yaml

File path: `orchestrator-ts/.aes/workflow/cc-sdd.yaml`

```yaml
id: cc-sdd

phases:
  - phase: SPEC_INIT
    type: llm_slash_command
    content: "kiro:spec-init"
    required_artifacts: []

  - phase: HUMAN_INTERACTION
    type: suspension
    content: ""
    required_artifacts: []
    approval_gate: human_interaction

  - phase: VALIDATE_PREREQUISITES
    type: llm_prompt
    content: |
      Verify that the specification prerequisites are in place for '{specDir}'.
      Check that '{specDir}/requirements.md' exists and is non-empty.
      If the file is missing or empty, report what is missing and stop.
      If the file exists and has content, confirm that prerequisites are satisfied.
    required_artifacts:
      - requirements.md
    output_file: prerequisite-check.md

  - phase: SPEC_REQUIREMENTS
    type: llm_slash_command
    content: "kiro:spec-requirements"
    required_artifacts:
      - requirements.md
    approval_gate: requirements
    approval_artifact: requirements.md

  - phase: VALIDATE_REQUIREMENTS
    type: llm_prompt
    content: |
      Review the requirements document at '{specDir}/requirements.md' for completeness and testability.
      Check that each requirement is unambiguous, measurable, and independently testable.
      Identify any gaps, contradictions, or requirements that cannot be verified by tests.
      Provide a structured review report; flag any items that need revision before design begins.
    required_artifacts:
      - requirements.md
    output_file: validation-requirements.md

  - phase: REFLECT_BEFORE_DESIGN
    type: llm_prompt
    content: |
      Before starting the technical design for '{specDir}', synthesize the key constraints and open questions from '{specDir}/requirements.md'.
      Identify the top architectural drivers, non-functional requirements, and any requirements that introduce design risk.
      List open questions that the design must resolve, and note any assumptions being made.
      This reflection will be used as context when generating the design document.
    required_artifacts:
      - requirements.md
    output_file: reflect-before-design.md

  - phase: VALIDATE_GAP
    type: llm_slash_command
    content: "kiro:validate-gap"
    required_artifacts:
      - requirements.md

  - phase: SPEC_DESIGN
    type: llm_slash_command
    content: "kiro:spec-design"
    required_artifacts:
      - requirements.md

  - phase: VALIDATE_DESIGN
    type: llm_slash_command
    content: "kiro:validate-design"
    required_artifacts:
      - design.md
    approval_gate: design
    approval_artifact: design.md

  - phase: REFLECT_BEFORE_TASKS
    type: llm_prompt
    content: |
      Before generating the implementation task breakdown for '{specDir}', synthesize the key design decisions and patterns from '{specDir}/design.md'.
      Identify the major components, interfaces, and their responsibilities as established by the design.
      Note any design patterns, constraints, or ordering dependencies that will affect how tasks must be sequenced.
      This reflection will be used as context when generating the tasks document.
    required_artifacts:
      - design.md
    output_file: reflect-before-tasks.md

  - phase: SPEC_TASKS
    type: llm_slash_command
    content: "kiro:spec-tasks"
    required_artifacts:
      - design.md
    approval_gate: tasks
    approval_artifact: tasks.md

  - phase: VALIDATE_TASKS
    type: llm_prompt
    content: |
      Review the implementation task breakdown at '{specDir}/tasks.md' for completeness and implementation readiness.
      Check that every requirement from '{specDir}/requirements.md' is covered by at least one task.
      Verify that task dependencies are correctly ordered and that no task depends on an unimplemented component.
      Confirm that each task is small enough to implement and test independently.
      Provide a structured review report; flag any gaps or sequencing issues before implementation begins.
    required_artifacts:
      - tasks.md
    output_file: validation-tasks.md

  - phase: IMPLEMENTATION
    type: implementation_loop
    content: ""
    required_artifacts:
      - tasks.md

  - phase: PULL_REQUEST
    type: git_command
    content: ""
    required_artifacts: []
```

---

## 4. Type Changes — Exact Before/After

### `src/domain/workflow/types.ts`

**Before:**

```typescript
export const WORKFLOW_PHASES = Object.freeze([
  "SPEC_INIT", "HUMAN_INTERACTION", ..., "PULL_REQUEST"
] as const);
export type WorkflowPhase = (typeof WORKFLOW_PHASES)[number];
```

**After:**

```typescript
// WORKFLOW_PHASES const removed entirely
export type WorkflowPhase = string;
```

`WorkflowPhase = string` is kept as a named type alias (not inlined to `string`) to preserve semantic intent in signatures and IDE hover text.

### `src/domain/workflow/framework.ts`

**Before:**

```typescript
export type PhaseExecutionType =
  | "llm_slash_command" | "llm_prompt" | "human_interaction"
  | "git_command" | "implementation_loop";

export interface PhaseDefinition {
  readonly phase: WorkflowPhase;   // was const union
  readonly approvalGate?: ApprovalPhase;
  // ...
}
```

**After:**

```typescript
export type PhaseExecutionType =
  | "llm_slash_command" | "llm_prompt" | "human_interaction"
  | "suspension"                    // new canonical pause type
  | "git_command" | "implementation_loop";

export interface PhaseDefinition {
  readonly phase: string;           // no longer const union
  readonly approvalGate?: ApprovalPhase;
  readonly approvalArtifact?: string;  // new: overrides hardcoded artifact mapping
  // ...
}
```

`findPhaseDefinition()` signature: `(def: FrameworkDefinition, phase: string): PhaseDefinition | undefined`

`validateFrameworkDefinition()` addition:

```typescript
const VALID_APPROVAL_PHASES: readonly string[] = ["human_interaction", "requirements", "design", "tasks"];
if (p.approvalGate !== undefined && !VALID_APPROVAL_PHASES.includes(p.approvalGate)) {
  throw new Error(`Framework "${def.id}" phase "${p.phase}" has unknown approvalGate: "${p.approvalGate}"`);
}
```

### `src/domain/workflow/approval-gate.ts`

`check()` and `checkResume()` gain an optional `approvalArtifact?: string` parameter:

```typescript
async check(specDir: string, phase: ApprovalPhase, approvalArtifact?: string): Promise<ApprovalCheckResult>
```

In `pending()`: `const artifactPath = join(specDir, approvalArtifact ?? artifactFilename(phase));`

`artifactFilename()` hardcoded switch is **kept as a fallback** — not deleted.

---

## 5. New `YamlWorkflowDefinitionLoader`

File: `src/infra/sdd/yaml-workflow-definition-loader.ts`

```typescript
import { load as yamlLoad } from "js-yaml";
import type { FrameworkDefinitionPort } from "@/application/ports/framework";
import {
  type FrameworkDefinition,
  type PhaseDefinition,
  type PhaseExecutionType,
  validateFrameworkDefinition,
} from "@/domain/workflow/framework";
import type { ApprovalPhase } from "@/domain/workflow/approval-gate";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const VALID_EXECUTION_TYPES = new Set<string>([
  "llm_slash_command", "llm_prompt", "human_interaction",
  "suspension", "git_command", "implementation_loop",
]);

export class YamlWorkflowDefinitionLoader implements FrameworkDefinitionPort {
  constructor(
    private readonly workflowDir: string = join(process.cwd(), ".aes", "workflow"),
  ) {}

  async load(frameworkId: string): Promise<FrameworkDefinition> {
    const filePath = join(this.workflowDir, `${frameworkId}.yaml`);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch {
      throw new Error(
        `Framework definition file not found: "${filePath}". ` +
        `Create ".aes/workflow/${frameworkId}.yaml" to register this framework.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = yamlLoad(raw);
    } catch (err) {
      throw new Error(`Failed to parse YAML at "${filePath}": ${String(err)}`);
    }
    const def = this.toFrameworkDefinition(parsed, filePath);
    validateFrameworkDefinition(def);
    return def;
  }

  private toFrameworkDefinition(raw: unknown, filePath: string): FrameworkDefinition {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`Invalid YAML structure in "${filePath}": expected an object at top level`);
    }
    const obj = raw as Record<string, unknown>;
    if (typeof obj["id"] !== "string" || obj["id"].trim() === "") {
      throw new Error(`YAML at "${filePath}" is missing a non-empty "id" field`);
    }
    if (!Array.isArray(obj["phases"])) {
      throw new Error(`YAML at "${filePath}" is missing a "phases" array`);
    }
    const phases = (obj["phases"] as unknown[]).map((p, i) => this.toPhaseDefinition(p, filePath, i));
    return { id: obj["id"] as string, phases };
  }

  private toPhaseDefinition(raw: unknown, filePath: string, index: number): PhaseDefinition {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`Phase at index ${index} in "${filePath}" is not an object`);
    }
    const p = raw as Record<string, unknown>;
    if (typeof p["phase"] !== "string" || p["phase"].trim() === "") {
      throw new Error(`Phase at index ${index} in "${filePath}" is missing a "phase" name`);
    }
    const type = p["type"] as string;
    if (!VALID_EXECUTION_TYPES.has(type)) {
      throw new Error(
        `Phase "${p["phase"]}" in "${filePath}" has unknown type "${type}". ` +
        `Valid types: ${[...VALID_EXECUTION_TYPES].join(", ")}`,
      );
    }
    return {
      phase: p["phase"] as string,
      type: type as PhaseExecutionType,
      content: typeof p["content"] === "string" ? p["content"] : "",
      requiredArtifacts: Array.isArray(p["required_artifacts"])
        ? (p["required_artifacts"] as string[])
        : [],
      approvalGate: typeof p["approval_gate"] === "string"
        ? p["approval_gate"] as ApprovalPhase
        : undefined,
      approvalArtifact: typeof p["approval_artifact"] === "string"
        ? p["approval_artifact"]
        : undefined,
      outputFile: typeof p["output_file"] === "string" ? p["output_file"] : undefined,
    };
  }
}
```

Key design points:

- `workflowDir` injected in constructor — unit tests write a temp YAML and pass the tmpdir
- Two-phase validation: structural guards in `toPhaseDefinition()`, then domain validation via `validateFrameworkDefinition()`
- No caching — `load()` is called once per process run

---

## 6. DI Wiring Change

`src/main/di/run-container.ts`:

```typescript
// Import change:
import { YamlWorkflowDefinitionLoader } from "@/infra/sdd/yaml-workflow-definition-loader";

// Lazy getter:
private get frameworkDefinitionLoader(): FrameworkDefinitionPort {
  if (!this._frameworkDefinitionLoader) {
    this._frameworkDefinitionLoader = new YamlWorkflowDefinitionLoader(
      join(process.cwd(), ".aes", "workflow"),
    );
  }
  return this._frameworkDefinitionLoader;
}
```

---

## 7. Phase Runner Changes

New switch cases:

```typescript
case "human_interaction":
case "suspension":
  return { ok: true, artifacts: [] };
```

Signature: `execute(phase: string, ctx: SpecContext): Promise<PhaseResult>`

---

## 8. Test Strategy

### Tests to Delete

- `tests/infra/sdd/typescript-framework-definition-loader.test.ts`
- `tests/infra/sdd/cc-sdd-framework-definition.test.ts`

### Tests to Create

`tests/infra/sdd/yaml-workflow-definition-loader.test.ts`:

- Integration: `load("cc-sdd")` returns 14-phase definition with correct type distribution
- Integration: all `llm_prompt` phases have `outputFile`; all `approvalGate` phases have `approvalArtifact`
- Integration: `load("unknown")` rejects with file-not-found error
- Unit (tmpdir): missing file, malformed YAML, duplicate phase, empty content, unknown type, missing `id`, `approval_artifact` override persisted

### Tests to Update

- `tests/domain/workflow-types.test.ts` — remove `WORKFLOW_PHASES` tests
- `tests/domain/workflow-framework.test.ts` — add `suspension` to exhaustiveness check
- `tests/domain/approval-gate.test.ts` — add `approvalArtifact` override test
- `tests/main/run-container-di-logging.test.ts` — update error message expectation for YAML loader
