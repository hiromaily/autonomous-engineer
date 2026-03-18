# Research & Design Decisions

---
**Purpose**: Capture discovery findings, architectural investigations, and rationale that inform the technical design.

---

## Summary
- **Feature**: `custom-sddfw-flow-management`
- **Discovery Scope**: Extension — modifying existing workflow engine and phase dispatch infrastructure
- **Key Findings**:
  - Phase behavior is hardcoded across exactly 4 files: `domain/workflow/types.ts`, `workflow-engine.ts`, `phase-runner.ts`, and `cc-sdd-adapter.ts`
  - Five phases currently designated as LLM operations (`VALIDATE_PREREQUISITES`, `VALIDATE_REQUIREMENTS`, `REFLECT_BEFORE_DESIGN`, `REFLECT_BEFORE_TASKS`, `VALIDATE_TASKS`) are silently routed through the SDD adapter with no prompt text defined anywhere
  - The config system already reads `sddFramework` from `aes.config.json` and `AES_SDD_FRAMEWORK` env var (defaulting to `cc-sdd`), but this value is never used to select a framework definition — it is only passed through

## Research Log

### Hardcoded Phase Dispatch in PhaseRunner

- **Context**: Determine the full scope of the switch statement and which operations are truly SDD-backed vs. LLM-only
- **Findings**:
  - `phase-runner.ts` has an 11-branch switch statement; all branches delegate to `this.sdd.*()` named methods
  - The 5 reflection/validation phases (`VALIDATE_PREREQUISITES`, `VALIDATE_REQUIREMENTS`, `REFLECT_BEFORE_DESIGN`, `REFLECT_BEFORE_TASKS`, `VALIDATE_TASKS`) call `sdd.validatePrerequisites()`, `sdd.validateRequirements()`, etc.
  - In `CcSddAdapter`, all 11 named methods call the same `cc-sdd <subcommand>` binary pattern; the `cc-sdd` binary does not exist (confirmed in prior sessions — it was removed when the real slash commands replaced it)
  - `MockSddAdapter` stubs these methods with no-op file writes and `sdd:operation` debug events
  - There is no path in the current code where `LlmProviderPort.complete()` is called during workflow phase execution
- **Implications**: All 5 "LLM prompt" phases are effectively no-ops today; the new design must wire `llm.complete(promptText)` for these phases

### WorkflowEngine Hardcoded Constants

- **Context**: Identify what must be extracted into `FrameworkDefinition`
- **Findings**:
  - `REQUIRED_ARTIFACTS: Partial<Record<WorkflowPhase, readonly string[]>>` — 11 entries hardcoded
  - `APPROVAL_GATE_PHASES: Partial<Record<WorkflowPhase, ApprovalPhase>>` — 4 entries hardcoded
  - `WORKFLOW_PHASES` from domain types — 14-element ordered array used for phase iteration order and index-based next-phase lookup in `advancePausedPhase()`
- **Implications**: All three must be derivable from `FrameworkDefinition`; `WORKFLOW_PHASES` constant must remain in `domain/workflow/types.ts` as it defines the `WorkflowPhase` type

### Existing Config System

- **Context**: Understand how `sddFramework` from config reaches the DI container
- **Findings**:
  - `ConfigLoader` reads `sddFramework` and validates it against `["cc-sdd", "openspec", "speckit"]`
  - `AesConfig.sddFramework` field carries the value into the DI container
  - `RunContainer` currently ignores `config.sddFramework` entirely — it always constructs `CcSddAdapter` (or `MockSddAdapter` in debug mode)
  - The `TypeScriptFrameworkDefinitionLoader` does not exist yet
- **Implications**: The config infrastructure is ready; only the DI wiring and loader need to be added

### SddFrameworkPort Interface Change

- **Context**: Determine whether to keep named methods or switch to generic `executeCommand`
- **Findings**:
  - The current 11-method port maps 1:1 to cc-sdd subcommands; any new framework would need to implement all 11 methods even if it uses a different model
  - `PhaseRunner` needs to pass `content` (command name) from the framework definition to the adapter; named methods cannot accept a dynamic command name
  - Tests in `phase-runner.test.ts` mock all 11 named methods; these will be entirely replaced
- **Implications**: The port should be simplified to `executeCommand(commandName: string, ctx: SpecContext): Promise<SddOperationResult>`. All named methods in `CcSddAdapter` and `MockSddAdapter` are removed.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Named-method SddFrameworkPort (keep) | Keep 11 methods; PhaseRunner maps command name to method via reflection | Minimal interface change | Ties PhaseRunner to cc-sdd method names; requires mapping layer | Rejected — adds coupling |
| Generic executeCommand (selected) | Single `executeCommand(commandName, ctx)` method | Clean; any adapter handles any command name | Test doubles must map command names to stubs | Aligns with data-driven philosophy |
| Dynamic definition loading | Load `.ts` files from disk using `import()` | Supports user-defined frameworks | Security risk; requires build pipeline or Bun-specific APIs | Deferred: built-in registry is sufficient for now |

## Design Decisions

### Decision: Simplify SddFrameworkPort to Single executeCommand Method

- **Context**: PhaseRunner must dispatch to the SDD port using a command name from the framework definition, but the current port has 11 named methods with no way to accept a dynamic name.
- **Alternatives Considered**:
  1. Keep 11 named methods; add a static name→method dispatch map in PhaseRunner
  2. Replace with `executeCommand(commandName: string, ctx: SpecContext): Promise<SddOperationResult>`
- **Selected Approach**: Option 2 — single generic method
- **Rationale**: The 11-method model was designed for cc-sdd specifically. A generic `executeCommand` is naturally extensible: any future framework adapter receives the exact command identifier from the definition and decides how to run it.
- **Trade-offs**: Breaking change to the port interface — all existing tests and adapters must be updated. This is acceptable because the change is internal (no public API).
- **Follow-up**: Update all `SddFrameworkPort` mock instances in tests

### Decision: FrameworkDefinition Injected at Construction Time (not loaded per-run)

- **Context**: `PhaseRunner` and `WorkflowEngine` both need `FrameworkDefinition`. Two options: inject at construction, or load per-run via the port.
- **Alternatives Considered**:
  1. Accept `FrameworkDefinitionPort` as a dep; call `load()` inside `execute()`
  2. Accept `FrameworkDefinition` (already loaded value) as a dep
- **Selected Approach**: Option 2 — inject the loaded value
- **Rationale**: Framework selection is a startup-time decision (from config). Loading per-run adds async complexity for no benefit; the definition never changes mid-run.
- **Trade-offs**: `RunContainer` must load the definition before constructing `PhaseRunner` and `WorkflowEngine`.

### Decision: TypeScriptFrameworkDefinitionLoader as Built-in Registry

- **Context**: Requirement 5.5 says Bun can import TypeScript files natively. We could use dynamic `import()` from disk, but this adds complexity and security surface.
- **Alternatives Considered**:
  1. Dynamic `import()` of `.ts` files from a well-known directory (e.g., `infra/sdd/definitions/`)
  2. Static registry: a Map from framework ID to the imported definition module
- **Selected Approach**: Option 2 — static registry in `TypeScriptFrameworkDefinitionLoader`
- **Rationale**: The loader satisfies the port contract while being simple and safe. Built-in definitions are the primary use case. If third-party definitions are needed in the future, a dynamic loading layer can be added without changing the port contract.
- **Trade-offs**: New frameworks must be added to the loader's registry. Acceptable given that adding a framework is an intentional, reviewed operation.

### Decision: LLM Prompt Phases Return Empty Artifacts

- **Context**: `PhaseResult.artifacts` is an array of artifact paths produced by a phase. LLM prompt phases (reflection, validation) do not write artifact files.
- **Selected Approach**: Return `{ ok: true, artifacts: [] }` for successful `llm_prompt` phases.
- **Rationale**: These phases produce LLM responses (text in memory), not disk artifacts. The `phase:complete` event still fires with `artifacts: []`, which is accurate.
- **Follow-up**: If future specs need to capture LLM output to disk, a separate `llm_prompt_with_artifact` phase type can be added.

## Risks & Mitigations

- Breaking change to `SddFrameworkPort` affects all test files that mock named methods — mitigate by updating all test doubles as part of the same PR
- `WorkflowEngine.advancePausedPhase()` uses index-based next-phase lookup via `WORKFLOW_PHASES.indexOf()` — must migrate to framework definition's phase list to avoid desync
- `llm_prompt` phases now call `llm.complete()` in production for the first time — any LLM connectivity issue will fail these phases; mitigate with clear error propagation in `PhaseResult`
- Mock adapter must distinguish command-name-based stubs correctly — document internal command→stub map clearly to avoid test drift

## References

- `orchestrator-ts/src/application/services/workflow/phase-runner.ts` — current switch statement
- `orchestrator-ts/src/application/services/workflow/workflow-engine.ts` — hardcoded constants
- `orchestrator-ts/src/domain/workflow/types.ts` — `WORKFLOW_PHASES` and `WorkflowPhase` type
- `orchestrator-ts/src/infra/sdd/cc-sdd-adapter.ts` — current named-method adapter
- `orchestrator-ts/src/infra/config/config-loader.ts` — `sddFramework` config field (already present)
- `orchestrator-ts/tests/domain/phase-runner.test.ts` — tests to be migrated to data-driven construction
