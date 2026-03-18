# Request

Work on https://github.com/hiromaily/autonomous-engineer/issues/51

## Issue #51: refactor: replace TypeScript framework definitions with YAML workflow files

### Background

The current implementation hardcodes the cc-sdd workflow as a TypeScript constant (`cc-sdd-framework-definition.ts`) loaded via an in-process registry (`TypeScriptFrameworkDefinitionLoader`). Adding a new SDD framework requires writing TypeScript code. This was not the intended design.

The intended design was YAML-based workflow definition files — one file per SDD framework — with a generic loader that reads whichever file matches the configured framework ID.

### Problem

Three specific issues:

1. **`cc-sdd-framework-definition.ts`** — framework identity baked into a TypeScript filename and constant. Not extensible.
2. **`TypeScriptFrameworkDefinitionLoader`** — hardcoded in-process registry; new frameworks require recompilation.
3. **`WorkflowPhase` in `types.ts`** — fixed const union type; a YAML with different phase names cannot be represented.

### Proposed Design

#### File layout

```
.aes/
└── workflow/
    └── cc-sdd.yaml        # ships with the project; read at runtime
                           # openspec.yaml would go here for a second framework
```

The loader resolves `.aes/workflow/{frameworkId}.yaml`. No TypeScript changes needed to add a new framework.

#### YAML schema

```yaml
id: cc-sdd

phases:
  - phase: SPEC_INIT
    type: llm_slash_command
    content: "kiro:spec-init"

  - phase: HUMAN_INTERACTION
    type: suspension
    approval_gate: human_interaction

  - phase: VALIDATE_PREREQUISITES
    type: llm_prompt
    content: |
      Verify that the specification prerequisites are in place for '{specDir}'.
      Check that '{specDir}/requirements.md' exists and is non-empty.
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

  # ... remaining linear phases ...

  - phase: IMPLEMENTATION
    type: loop
    required_artifacts:
      - tasks.md
    steps:
      - type: llm_slash_command
        content: "kiro:spec-impl"
      - type: llm_prompt
        content: "validate implementation..."
        output_file: validate-impl.md
      - type: git_command
        content: commit
      - type: suspension

  - phase: PULL_REQUEST
    type: git_command
```

#### Phase types

| type | description |
|---|---|
| `llm_prompt` | Direct LLM prompt; response written to `output_file` if set |
| `llm_slash_command` | LLM custom slash command (e.g. `kiro:spec-requirements`) |
| `git_command` | Git operation (commit, PR creation) |
| `suspension` | Pause for human interaction or context clear |
| `loop` | Repeating block with nested `steps`; iterates over tasks |

#### Domain type changes

- `WorkflowPhase` in `types.ts`: change from fixed const union to `string`; delete `WORKFLOW_PHASES` const
- `WorkflowState.currentPhase`: becomes `string`
- `ApprovalGate`: remove hardcoded `artifactFilename()` switch; read `approval_artifact` from the phase definition instead
- `FrameworkDefinition` in `domain/workflow/framework.ts`: update to match YAML schema (add `suspension`, `loop` with `steps`)

### Files affected

| File | Action |
|---|---|
| `src/infra/sdd/cc-sdd-framework-definition.ts` | Delete |
| `src/infra/sdd/typescript-framework-definition-loader.ts` | Replace with `yaml-workflow-definition-loader.ts` |
| `src/domain/workflow/types.ts` | `WorkflowPhase` → `string`, remove `WORKFLOW_PHASES` |
| `src/domain/workflow/framework.ts` | Update types for new phase types and loop schema |
| `src/domain/workflow/approval-gate.ts` | Remove hardcoded artifact mapping; read from phase definition |
| `.aes/workflow/cc-sdd.yaml` | New — the cc-sdd workflow definition |

### Acceptance Criteria

- [ ] `.aes/workflow/cc-sdd.yaml` defines the full cc-sdd workflow (all 14 phases)
- [ ] `YamlWorkflowDefinitionLoader` loads a workflow by resolving `.aes/workflow/{id}.yaml`
- [ ] `cc-sdd-framework-definition.ts` and `typescript-framework-definition-loader.ts` are deleted
- [ ] `WorkflowPhase` is no longer a hardcoded enum; phase names are plain strings from the YAML
- [ ] `ApprovalGate` reads approval artifact path from the phase definition, not a hardcoded switch
- [ ] All existing tests pass; new tests cover YAML loading and schema validation
- [ ] Adding a second framework (e.g. `openspec`) requires only a new YAML file, zero TypeScript changes

## Context

- Current branch: main
- Repository: hiromaily/autonomous-engineer
- Working directory: /Users/hiroki.yasui/work/hiromaily/autonomous-engineer
- Workspace: orchestrator-ts/ (TypeScript orchestrator)
