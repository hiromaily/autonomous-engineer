# Implementation Plan

- [x] 1. Establish domain schema and application port foundation
- [x] 1.1 Create domain layer types for framework phase configuration
  - Define `PhaseExecutionType` as a discriminated literal union covering all five execution modes: `llm_slash_command`, `llm_prompt`, `human_interaction`, `git_command`, `implementation_loop`
  - Define `PhaseDefinition` interface with `phase`, `type`, `content`, `requiredArtifacts`, and optional `approvalGate` fields
  - Define `FrameworkDefinition` interface with `id` and ordered `phases` list
  - File must live in the domain layer with zero imports from application or infrastructure layers
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [x] 1.2 (P) Add runtime validation for framework definition correctness
  - Export a `validateFrameworkDefinition(def)` function from the same domain file as the type definitions
  - Validate that all `phase` values within `FrameworkDefinition.phases` are distinct (no duplicates)
  - Validate that `content` is non-empty when `type` is `llm_slash_command` or `llm_prompt`
  - Throw a descriptive error on violation; no return value on success
  - _Requirements: 1.6_

- [x] 1.3 (P) Define the framework definition loading port in the application layer
  - Create a `FrameworkDefinitionPort` interface in the application ports directory
  - Expose a `load(frameworkId: string): Promise<FrameworkDefinition>` method that throws when no matching definition is found
  - The port may only import domain types; no infra imports
  - _Requirements: 5.1, 5.2, 5.3_

- [x] 2. Create the cc-sdd framework definition data file
  - Create a typed constant `CC_SDD_FRAMEWORK_DEFINITION` in the infrastructure SDD directory that satisfies `FrameworkDefinition`
  - Define all 14 phases in execution order, each with correct `type` and `content`: 6 `llm_slash_command`, 5 `llm_prompt`, 1 `human_interaction`, 1 `implementation_loop`, 1 `git_command`
  - Provide non-empty inline prompt text for each of the 5 `llm_prompt` phases; each prompt may use `{specDir}`, `{specName}`, and `{language}` placeholders where runtime values are needed
  - `VALIDATE_PREREQUISITES` prompt: instruct the LLM to verify `{specDir}/requirements.md` exists and is non-empty
  - `VALIDATE_REQUIREMENTS` prompt: instruct the LLM to review `{specDir}/requirements.md` for completeness and testability
  - `REFLECT_BEFORE_DESIGN` prompt: instruct the LLM to synthesize key constraints and open questions from `{specDir}/requirements.md` before design begins
  - `REFLECT_BEFORE_TASKS` prompt: instruct the LLM to synthesize design decisions and patterns from `{specDir}/design.md` before task breakdown begins
  - `VALIDATE_TASKS` prompt: instruct the LLM to review `{specDir}/tasks.md` for completeness and implementation readiness
  - Mirror `requiredArtifacts` and `approvalGate` values from the existing `REQUIRED_ARTIFACTS` and `APPROVAL_GATE_PHASES` constants in `workflow-engine.ts`
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9_

- [x] 3. Implement the framework definition loader
  - Create `TypeScriptFrameworkDefinitionLoader` in the infrastructure config directory, implementing `FrameworkDefinitionPort`
  - Build an internal registry `Map` keyed by framework identifier string; register `"cc-sdd"` pointing to `CC_SDD_FRAMEWORK_DEFINITION`
  - In `load()`, look up the identifier; if not found, throw with a message listing all available framework names
  - Call `validateFrameworkDefinition()` on the loaded definition before returning it
  - _Requirements: 5.4, 5.5_

- [x] 4. Simplify the SDD framework execution interface and update adapters
- [x] 4.1 Replace the named-method SDD port with a single executeCommand interface
  - Update `SddFrameworkPort` in application ports to replace all 11 named methods (`initSpec`, `validatePrerequisites`, `generateRequirements`, `validateRequirements`, `reflectBeforeDesign`, `validateGap`, `generateDesign`, `validateDesign`, `reflectBeforeTasks`, `generateTasks`, `validateTasks`) with one method: `executeCommand(commandName: string, ctx: SpecContext): Promise<SddOperationResult>`
  - _Requirements: 3.4_

- [x] 4.2 (P) Update the cc-sdd adapter to implement the simplified interface
  - Replace all 11 named method implementations with a single `executeCommand` method
  - Add a private 6-entry map from `commandName` to `{ subcommand: string, artifactFile: string }`, covering only the `llm_slash_command` phases: `kiro:spec-init`, `kiro:spec-requirements`, `kiro:validate-gap`, `kiro:spec-design`, `kiro:validate-design`, `kiro:spec-tasks`
  - Retain the existing `private run()` execution primitive unchanged
  - Return `{ ok: false, error: { exitCode: 1, stderr: "Unknown command: <commandName>" } }` for unrecognized command names
  - _Requirements: 2.1, 3.4_

- [x] 4.3 (P) Update the mock SDD adapter to implement the simplified interface
  - Replace all 11 named method stubs with a single `executeCommand` method using an internal 6-entry command-to-stub mapping (same `kiro:` command names as the cc-sdd adapter)
  - Retain artifact stub creation: commands that generate content (`kiro:spec-requirements`, `kiro:spec-design`, `kiro:spec-tasks`) write stub file content; validation-only commands do not write
  - When `kiro:spec-tasks` completes successfully, continue to call `setReadyForImplementation()` and `writeStubTaskPlan()` as before
  - Emit `sdd:operation` debug events only from `executeCommand`; `llm_prompt` phases are dispatched through the LLM port and must not produce `sdd:operation` events
  - Retain `setReadyForImplementation()` and `writeStubTaskPlan()` private helpers unchanged
  - _Requirements: 6.1, 6.3, 6.5_

- [x] 4.4 Restore build validity after port simplification
  - Update `PhaseRunner.mapSddResult()`'s parameter type from `Awaited<ReturnType<SddFrameworkPort["generateRequirements"]>>` to `SddOperationResult` directly
  - This is a type-only change with no behavioral impact; it resolves the broken type reference that Task 4.1 introduces when named methods are removed from the port
  - _Requirements: 3.9_

- [x] 5. Refactor PhaseRunner with data-driven dispatch
- [x] 5.1 Add framework definition as a required PhaseRunner dependency
  - Add `frameworkDefinition: FrameworkDefinition` to `PhaseRunnerDeps` and store it on the instance
  - At the start of `execute(phase, ctx)`, look up the matching `PhaseDefinition` in `frameworkDefinition.phases`; if not found, throw `Error("Unregistered workflow phase: ${phase} in framework ${frameworkDefinition.id}")`
  - Verify that `onEnter()` still calls `this.llm.clearContext()` unchanged — this behavior must be preserved through the refactoring
  - _Requirements: 3.1, 3.8_

- [x] 5.2 Implement type-based dispatch and remove the hardcoded switch statement
  - For `llm_slash_command`: interpolate `{specDir}`, `{specName}`, `{language}` placeholders in `content` using `ctx`, then call `sdd.executeCommand(interpolatedContent, ctx)` and map the result through `mapSddResult()`
  - For `llm_prompt`: apply the same placeholder interpolation on `content`, call `llm.complete(interpolatedPrompt)`, and return `{ ok: true, artifacts: [] }` on success or `{ ok: false, error: llmError.message }` on failure
  - For `human_interaction` and `git_command`: return `{ ok: true, artifacts: [] }` without calling any external port
  - For `implementation_loop`: delegate to `IImplementationLoop.run()` if wired; otherwise return `{ ok: true, artifacts: [] }` as a stub
  - Remove the entire hardcoded switch statement; no `WorkflowPhase` literal strings shall appear in the dispatch logic
  - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.9_

- [x] 6. Refactor WorkflowEngine for framework-neutral configuration
  _(Task 6 works on a different file from Tasks 4 and 5 and can be started in parallel with them after Task 1 is complete.)_
- [x] 6.1 Replace hardcoded phase ordering with framework definition phase list
  - Add `frameworkDefinition: FrameworkDefinition` to `WorkflowEngineDeps`
  - In `pendingPhases()`, derive the ordered phase list from `frameworkDefinition.phases.map(p => p.phase)` instead of importing and iterating `WORKFLOW_PHASES`
  - In `advancePausedPhase()`, find the current phase index using `frameworkDefinition.phases.findIndex(p => p.phase === pausedPhase)` and read `frameworkDefinition.phases[idx + 1]?.phase` for the next phase, replacing the `WORKFLOW_PHASES.indexOf()` call
  - Retain the `WorkflowPhase` type import from the domain layer for type annotations; do not remove the enum from domain
  - _Requirements: 4.3, 4.5_

- [x] 6.2 Replace hardcoded artifact and approval gate constants with phase definition lookups
  - In `checkRequiredArtifacts(phase)`, read `requiredArtifacts` from `frameworkDefinition.phases.find(p => p.phase === phase)?.requiredArtifacts ?? []` instead of `REQUIRED_ARTIFACTS[phase]`
  - In the approval gate lookup (both in `runPendingPhases` and `advancePausedPhase`), read `approvalGate` from `frameworkDefinition.phases.find(p => p.phase === phase)?.approvalGate` instead of `APPROVAL_GATE_PHASES[phase]`
  - Remove the `REQUIRED_ARTIFACTS` and `APPROVAL_GATE_PHASES` constants from the file once all usages have been migrated
  - _Requirements: 4.1, 4.2, 4.4_

- [x] 7. Wire framework selection into the DI container
  - Add `frameworkDefinitionLoader: TypeScriptFrameworkDefinitionLoader` and a cached `frameworkDefinition: FrameworkDefinition` lazy getter to `RunContainer`
  - In `build()` or an async initialization step, call `frameworkDefinitionLoader.load(config.sddFramework)` to load the configured framework; if the identifier is unknown, let the loader's error propagate to fail startup with the available-frameworks list
  - Pass the loaded `frameworkDefinition` to the `PhaseRunner` and `WorkflowEngine` constructors
  - Verify that `ConfigLoader.parseSddFramework` default of `"cc-sdd"` is preserved when `sddFramework` is absent from config
  - Ensure debug mode also selects the framework via `config.sddFramework` before constructing mock adapters
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

- [ ] 8. Update and add tests for all modified components
- [ ] 8.1 (P) Update PhaseRunner tests for data-driven dispatch
  - Reconstruct `PhaseRunner` in all existing tests to include a stub `frameworkDefinition` dependency
  - Add a test asserting `sdd.executeCommand()` is called with the correct command name for a representative `llm_slash_command` phase
  - Add a test asserting `llm.complete()` is called with the correct interpolated prompt text for a representative `llm_prompt` phase
  - Add a test asserting `PhaseResult { ok: false, error: ... }` when `llm.complete()` returns a failure
  - Add a test asserting `{ ok: true, artifacts: [] }` for `human_interaction` and `git_command` phases with no sdd or llm calls
  - Add a test asserting an explicit error is thrown when `execute()` is called with a phase not present in the framework definition
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_

- [ ] 8.2 (P) Update WorkflowEngine tests for framework definition configuration
  - Update `WorkflowEngineDeps` construction in all existing tests to include a stub `frameworkDefinition`
  - Add a test asserting `pendingPhases()` returns phases in the order defined by `frameworkDefinition.phases`
  - Add a test asserting `checkRequiredArtifacts()` reads from `phaseDefinition.requiredArtifacts`
  - Add a test asserting the approval gate lookup reads from `phaseDefinition.approvalGate`
  - Add a test asserting `advancePausedPhase()` determines the next phase from the framework definition index
  - Confirm that no references to `REQUIRED_ARTIFACTS` or `APPROVAL_GATE_PHASES` remain in the production file
  - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [ ] 8.3 (P) Add unit tests for the framework definition types and loader
  - Test `validateFrameworkDefinition` directly: assert it throws when two `PhaseDefinition` entries have the same `phase` value (covers duplicate check)
  - Test `validateFrameworkDefinition` directly: assert it throws when `content` is empty and `type` is `llm_slash_command` or `llm_prompt`
  - Test that `load("cc-sdd")` returns a validated `FrameworkDefinition` with exactly 14 phases
  - Test that `load("unknown-fw")` throws with a message containing `"cc-sdd"` in the available frameworks list
  - _Requirements: 1.6, 5.1, 5.2, 5.3, 5.4, 5.5_

- [ ] 8.4 (P) Update adapter tests for the simplified interface
  - Add a test asserting `CcSddAdapter.executeCommand("kiro:spec-requirements", ctx)` spawns the correct subcommand and returns an artifact path pointing to `requirements.md`
  - Add a test asserting `CcSddAdapter.executeCommand("unknown-command", ctx)` returns `{ ok: false }` without spawning a subprocess
  - Add tests asserting `MockSddAdapter.executeCommand()` records invocations so tests can assert the correct `kiro:` command name was used for an `llm_slash_command` phase
  - Add a test asserting `MockLlmProvider.complete()` is called with the exact prompt text from the cc-sdd framework definition for a representative `llm_prompt` phase (verifying the correct dispatch path and prompt content)
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

---

> **Intentionally deferred**: Requirement 8 (documentation updates to `docs/_partials/`, `docs/architecture/`, and `.kiro/steering/`) is excluded from implementation tasks per the code-only focus rule. Documentation can be updated after implementation is validated.
