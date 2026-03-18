# Requirements Document

## Project Description (Input)

custom-sddfw-flow-management

Implement [GitHub Issue #49](https://github.com/hiromaily/autonomous-engineer/issues/49): SDD framework phase behavior is currently hardcoded across multiple files. Phase execution order, execution type (slash command vs. LLM prompt), and execution content (command name or prompt text) must be extracted into a data-driven, framework-neutral configuration so that multiple SDD frameworks (cc-sdd, OpenSpec, etc.) can be supported without modifying orchestrator source code.

## Introduction

The SDD workflow orchestrator (`aes` CLI) currently hardcodes all phase behavior across four disconnected files: phase enum in `domain/workflow/types.ts`, artifact and approval gate metadata in `workflow-engine.ts`, dispatch logic in `phase-runner.ts`, and command names in `cc-sdd-adapter.ts`. Additionally, five phases designated as `llm_prompt` type have no prompt text defined anywhere in the codebase, making them silent no-ops. This specification defines the requirements to replace all hardcoded phase configuration with a data-driven, per-framework definition system.

## Requirements

### Requirement 1: Framework Phase Definition Schema

**Objective:** As an orchestrator developer, I want a typed schema that fully describes each workflow phase for a given SDD framework, so that phase behavior is defined as data rather than embedded in source code.

#### Acceptance Criteria

1. The Orchestrator shall define a `FrameworkDefinition` TypeScript interface in the domain layer that describes: framework identifier, ordered list of phases, and per-phase attributes including `phase` (WorkflowPhase), `type` (`llm_slash_command` | `llm_prompt` | `human_interaction` | `git_command` | `implementation_loop`), `content` (slash command name or inline prompt text), `requiredArtifacts` (list of filenames), and optional `approvalGate` (ApprovalPhase).
2. The Orchestrator shall enforce that the `FrameworkDefinition` interface is defined in the domain layer with no imports from infrastructure or application layers.
3. When a phase definition has `type: "llm_prompt"`, the Orchestrator shall require `content` to be a non-empty string containing the literal prompt text.
4. When a phase definition has `type: "llm_slash_command"`, the Orchestrator shall require `content` to be a non-empty string containing the slash command name.
5. When a phase definition has `type: "human_interaction"` or `type: "git_command"`, the Orchestrator shall allow `content` to be empty or contain operational metadata.
6. The Orchestrator shall validate at load time that every phase listed in the `FrameworkDefinition`'s ordered phase list has a corresponding phase definition entry with no gaps or duplicates.

---

### Requirement 2: cc-sdd Framework Definition File

**Objective:** As an orchestrator developer, I want a concrete cc-sdd framework definition file that specifies all 14 phases with correct types and content, so that the cc-sdd adapter has a single source of truth.

#### Acceptance Criteria

1. The Orchestrator shall provide a `cc-sdd` framework definition TypeScript file that defines all 14 phases from `WORKFLOW_PHASES` with explicit `type` and `content` per phase.
2. When the `cc-sdd` framework definition is loaded, the Orchestrator shall classify phases as follows:
   - `llm_slash_command` (6 phases): `SPEC_INIT`, `SPEC_REQUIREMENTS`, `VALIDATE_GAP`, `SPEC_DESIGN`, `VALIDATE_DESIGN`, `SPEC_TASKS`
   - `llm_prompt` (5 phases): `VALIDATE_PREREQUISITES`, `VALIDATE_REQUIREMENTS`, `REFLECT_BEFORE_DESIGN`, `REFLECT_BEFORE_TASKS`, `VALIDATE_TASKS`
   - `human_interaction` (1 phase): `HUMAN_INTERACTION` (pause point handled by the approval gate; no LLM or subprocess invocation)
   - `implementation_loop` (1 phase): `IMPLEMENTATION` (delegates to the orchestrator's internal implementation loop service)
   - `git_command` (1 phase): `PULL_REQUEST` (git/PR operation, stubbed for future implementation)
3. The `cc-sdd` framework definition shall provide non-empty inline prompt text for each of the 5 `llm_prompt` phases: `VALIDATE_PREREQUISITES`, `VALIDATE_REQUIREMENTS`, `REFLECT_BEFORE_DESIGN`, `REFLECT_BEFORE_TASKS`, and `VALIDATE_TASKS`.
4. The `VALIDATE_PREREQUISITES` phase content shall instruct the LLM to verify that `requirements.md` exists and is non-empty in the spec directory.
5. The `VALIDATE_REQUIREMENTS` phase content shall instruct the LLM to review `requirements.md` and improve it for completeness and testability.
6. The `REFLECT_BEFORE_DESIGN` phase content shall instruct the LLM to synthesize key constraints and open questions from `requirements.md` before design begins.
7. The `REFLECT_BEFORE_TASKS` phase content shall instruct the LLM to synthesize design decisions and patterns from `design.md` before task breakdown begins.
8. The `VALIDATE_TASKS` phase content shall instruct the LLM to review `tasks.md` for completeness and implementation readiness.
9. The cc-sdd framework definition shall include `requiredArtifacts` and `approvalGate` fields consistent with the values currently hardcoded in `REQUIRED_ARTIFACTS` and `APPROVAL_GATE_PHASES` in `workflow-engine.ts`.

---

### Requirement 3: Data-Driven PhaseRunner

**Objective:** As an orchestrator developer, I want `PhaseRunner` to dispatch phases based on a loaded framework definition rather than a hardcoded switch statement, so that adding a new framework requires no changes to the runner.

#### Acceptance Criteria

1. When `PhaseRunner` is constructed, the Orchestrator shall accept a `FrameworkDefinition` (or equivalent port) as a required dependency alongside `SddFrameworkPort` and `LlmProviderPort`.
2. When `PhaseRunner.execute(phase, ctx)` is called and the phase definition has `type: "llm_prompt"`, the Orchestrator shall call `LlmProviderPort.complete(prompt)` with the phase's inline prompt text as the argument.
3. When `PhaseRunner.execute(phase, ctx)` is called and `LlmProviderPort.complete()` returns `{ ok: false }`, the Orchestrator shall propagate the error as a `PhaseResult` failure with the LLM error message.
4. When `PhaseRunner.execute(phase, ctx)` is called and the phase definition has `type: "llm_slash_command"`, the Orchestrator shall delegate to the `SddFrameworkPort` using the command name from `content`.
5. When `PhaseRunner.execute(phase, ctx)` is called and the phase definition has `type: "human_interaction"`, the Orchestrator shall return `{ ok: true, artifacts: [] }` (pause is handled by the approval gate, not PhaseRunner).
6. When `PhaseRunner.execute(phase, ctx)` is called and the phase definition has `type: "implementation_loop"`, the Orchestrator shall delegate to the `IImplementationLoop` service when wired, or return `{ ok: true, artifacts: [] }` as a stub when not wired.
7. When `PhaseRunner.execute(phase, ctx)` is called and the phase definition has `type: "git_command"`, the Orchestrator shall return `{ ok: true, artifacts: [] }` as a stub for future extension.
8. If `PhaseRunner` receives a phase not present in the loaded framework definition, the Orchestrator shall throw an explicit error identifying the unregistered phase name.
9. The Orchestrator shall remove the hardcoded `switch` statement from `PhaseRunner` after migration to the data-driven approach.

---

### Requirement 4: Framework-Neutral WorkflowEngine Configuration

**Objective:** As an orchestrator developer, I want `WorkflowEngine` to derive required artifacts and approval gate mappings from the framework definition rather than hardcoded constants, so that workflow metadata is co-located with phase definitions.

#### Acceptance Criteria

1. When `WorkflowEngine` checks required artifacts before entering a phase, the Orchestrator shall read `requiredArtifacts` from the phase definition rather than from the `REQUIRED_ARTIFACTS` constant.
2. When `WorkflowEngine` checks the approval gate after a phase completes, the Orchestrator shall read `approvalGate` from the phase definition rather than from the `APPROVAL_GATE_PHASES` constant.
3. When `WorkflowEngine` iterates pending phases, the Orchestrator shall use the phase order from the framework definition rather than the hardcoded `WORKFLOW_PHASES` array.
4. The Orchestrator shall remove the `REQUIRED_ARTIFACTS` and `APPROVAL_GATE_PHASES` constants from `workflow-engine.ts` after migration.
5. The `WorkflowPhase` enum in `domain/workflow/types.ts` shall remain as the canonical type definition; the framework definition references it — the enum is not removed.

---

### Requirement 5: Framework Definition Loading Port

**Objective:** As an orchestrator developer, I want a port interface for loading framework definitions, so that definitions can be loaded from TypeScript files, JSON files, or any other source without changing orchestrator core logic.

#### Acceptance Criteria

1. The Orchestrator shall define a `FrameworkDefinitionPort` interface in the application layer that exposes a method to load a `FrameworkDefinition` by framework identifier string.
2. When a framework identifier is requested and a definition file exists, the Orchestrator shall return the fully-hydrated `FrameworkDefinition` object.
3. If a framework identifier is requested and no matching definition is found, the Orchestrator shall throw an error identifying the unknown framework name.
4. The Orchestrator shall provide a concrete `TypeScriptFrameworkDefinitionLoader` implementation in the infra layer that loads framework definitions from in-repo `.ts` definition files.
5. Where the runtime is Bun, the `TypeScriptFrameworkDefinitionLoader` shall import framework definition files using native Bun TypeScript execution without requiring a separate build step.

---

### Requirement 6: Updated MockSddAdapter for Two Execution Types

**Objective:** As a test author, I want `MockSddAdapter` (or an equivalent test double) to correctly distinguish between `llm_slash_command` and `llm_prompt` phase execution types, so that tests can verify the correct dispatch path without masking the type distinction.

#### Acceptance Criteria

1. The Orchestrator shall provide test doubles for both execution paths: a `MockSddAdapter` for `llm_slash_command` phases (simulating SDD subprocess behavior) and a mock `LlmProviderPort` for `llm_prompt` phases (simulating LLM responses).
2. When a phase runs as `llm_prompt` type in tests, the test suite shall be able to assert that `LlmProviderPort.complete()` was called with the expected prompt text from the framework definition.
3. When a phase runs as `llm_slash_command` type in tests, the test suite shall be able to assert that `SddFrameworkPort` was invoked with the expected command name from the framework definition.
4. The Orchestrator shall update existing `PhaseRunner` tests to construct `PhaseRunner` with a framework definition rather than relying on the removed hardcoded switch statement.
5. The `MockSddAdapter` shall emit `sdd:operation` debug events only for `llm_slash_command` phases; `llm_prompt` phases are owned by the LLM port and shall not produce `sdd:operation` events.

---

### Requirement 7: Multi-Framework Support

**Objective:** As an operator deploying the `aes` CLI, I want to configure which SDD framework the orchestrator uses via configuration, so that switching from cc-sdd to OpenSpec requires only a config change.

#### Acceptance Criteria

1. When the `aes run` command is invoked, the Orchestrator shall read the target SDD framework identifier from the project configuration (e.g. `aes.config.ts` or `.aes/config.json`).
2. When the framework identifier is set to `cc-sdd`, the Orchestrator shall load the cc-sdd framework definition and configure `PhaseRunner` and `WorkflowEngine` accordingly.
3. Where a second SDD framework definition (e.g. `open-spec`) is installed, the Orchestrator shall load it without modifying any orchestrator source files.
4. If the configured framework identifier has no matching definition, the Orchestrator shall fail at startup with a clear error message listing available frameworks.
5. The Orchestrator shall default to `cc-sdd` if no framework identifier is specified in configuration.

---

### Requirement 8: Documentation Updates

**Objective:** As a contributor reading project documentation, I want the architecture and workflow docs to reflect the framework-neutral phase definition model, so that the documented design matches the implemented behavior.

#### Acceptance Criteria

1. When the implementation is complete, `docs/_partials/sdd-workflow-summary.md` shall document the two phase execution types (`llm_slash_command` and `llm_prompt`) with examples of each.
2. The Orchestrator's architecture documentation (`docs/architecture/architecture.md` EN + JA) shall describe the `FrameworkDefinitionPort` and the data-driven dispatch model.
3. The `.kiro/steering/` directory shall include a note on the framework-neutral phase definition contract that future framework authors must follow.
4. The `orchestrator-ts/src/` README or equivalent source-level documentation shall reflect the new configurable phase model and updated Clean Architecture layers.
