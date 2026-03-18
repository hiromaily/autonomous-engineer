# Current State Analysis: YAML Implementation Loop Configuration

## Overview

This report describes the current state of the codebase as it relates to making the `implementation_loop` phase type configurable via the YAML workflow definition file. Currently, the YAML file has an empty `content` field for the implementation loop phase, and all loop behavior is hardcoded in the orchestrator.

---

## 1. Relevant Files and Directories

### Workflow Definition Files
- **`orchestrator-ts/.aes/workflow/cc-sdd.yaml`** (14 phases defined)
  - Line 108-112: IMPLEMENTATION phase with `type: implementation_loop`, empty `content: ""`, and `required_artifacts: [tasks.md]`
  - No configuration options currently supported in YAML

### Domain Layer (Clean Architecture)
- **`orchestrator-ts/src/domain/workflow/framework.ts`** — Framework definition types
  - `PhaseExecutionType` enum (lines 3-9): includes `"implementation_loop"` as a valid type
  - `PhaseDefinition` interface (lines 11-23): has fields for `phase`, `type`, `content`, `requiredArtifacts`, `approvalGate`, `approvalArtifact`, `outputFile`
  - **GAP**: No field currently for phase-specific configuration or parameters
  - Validation function `validateFrameworkDefinition()` (lines 42-64) checks content non-emptiness for `llm_slash_command` and `llm_prompt` only; does not validate `implementation_loop` content

- **`orchestrator-ts/src/domain/workflow/types.ts`** — Workflow state and phase tracking
  - `WorkflowPhase`: simple string type (line 1)
  - `WorkflowState` interface: tracks current phase, completed phases, status, failure details
  - **NOTE**: Workflow state is stateless with respect to phase configuration

- **`orchestrator-ts/src/domain/implementation-loop/types.ts`** — Domain types for implementation loop execution
  - Domain models for section execution, iterations, review results, escalation events
  - No configuration structures exposed at domain layer

### Infrastructure Layer (YAML Loader)
- **`orchestrator-ts/src/infra/sdd/yaml-workflow-definition-loader.ts`** (97 lines)
  - `toPhaseDefinition()` method (lines 60-96): parses YAML phase objects
    - Extracts: `phase` (name), `type`, `content`, `required_artifacts`, `approval_gate`, `approval_artifact`, `output_file`
    - Validates phase name, type (against `VALID_EXECUTION_TYPES` Set line 13-16), and artifacts array
    - **GAP**: Does NOT parse any configuration-related fields beyond the 6 above
    - No handling for nested config objects or type-specific parameters

### Application Layer (Service and Port Interfaces)
- **`orchestrator-ts/src/application/ports/implementation-loop.ts`** (345 lines)
  - `ImplementationLoopOptions` type (lines 259-284): defines runtime configuration passed to `IImplementationLoop.run()`
    - Current fields: `maxRetriesPerSection` (number), `qualityGateConfig` (QualityGateConfig), `selfHealingLoop?`, `eventBus?`, `logger?`, `contextEngine?`, `agentEventBus?`
    - **DESIGN NOTE**: All options come from DI at runtime, not from YAML phase definition
  - `QualityGateConfig` type (lines 61-63): structure for quality gate checks with `checks` array
  - All ports are well-defined and stable

- **`orchestrator-ts/src/application/services/workflow/phase-runner.ts`** (111 lines)
  - Lines 72-82: IMPLEMENTATION phase handling
  - Checks if `implementationLoop` service is provided (line 73)
  - Calls `implementationLoop.run(ctx.specName, this.implementationLoopOptions)` (line 74)
  - **KEY INSIGHT**: Options passed here come from `PhaseRunnerDeps.implementationLoopOptions` (line 21), which is injected at DI construction time, not from phase definition
  - No mechanism to override or configure from YAML

- **`orchestrator-ts/src/application/services/implementation-loop/implementation-loop-service.ts`** (843 lines)
  - Lines 42-56: `resolveOptions()` function applies defaults to partial options
  - Lines 104-125: `run()` and `resume()` methods accept `options?: Partial<ImplementationLoopOptions>`
  - **OBSERVATION**: Service is designed to accept runtime options but currently no path exists to populate them from YAML phase definition

- **`orchestrator-ts/src/application/usecases/run-spec.ts`** (115 lines)
  - Lines 74-77: `implementationLoopOptions` passed from DI container to PhaseRunner
  - Line 42: `RunOptions` type does not include implementation loop configuration
  - **FLOW**: Config flows: DI container → RunSpecUseCase → PhaseRunner → PhaseRunner.execute() → implementationLoop.run()

---

## 2. Key Interfaces, Types, and Data Flows

### Type Hierarchy

```
PhaseDefinition
  ├─ phase: string
  ├─ type: PhaseExecutionType  // includes "implementation_loop"
  ├─ content: string            // currently empty for implementation_loop
  ├─ requiredArtifacts: string[]
  ├─ approvalGate?: ApprovalPhase
  ├─ approvalArtifact?: string
  └─ outputFile?: string
     // GAP: No config/parameters field
```

### Configuration Flow (Current)

```
DI Container
  └─> RunSpecUseCase
       └─> implementationLoopOptions (Partial<ImplementationLoopOptions>)
            └─> PhaseRunner
                 └─> PhaseRunner.execute("IMPLEMENTATION", ctx)
                      └─> implementationLoop.run(specName, implementationLoopOptions)
```

### Configuration Flow (Desired)

```
YAML File (cc-sdd.yaml)
  └─> YamlWorkflowDefinitionLoader
       └─> PhaseDefinition (with config extracted)
            └─> PhaseRunner (receives FrameworkDefinition)
                 └─> implementationLoop.run(specName, configFromYaml + runtimeOptions)
```

### Core Workflow Execution Path

1. **Loader**: `YamlWorkflowDefinitionLoader.load("cc-sdd")` → `FrameworkDefinition`
2. **Engine**: `WorkflowEngine.execute(state)` → iterates through pending phases
3. **Runner**: `PhaseRunner.execute(phaseName, ctx)` → calls phase-type handler
4. **Implementation Loop**: For IMPLEMENTATION phase, calls `implementationLoop.run(specName, options)`

---

## 3. Existing Tests for Affected Code

### YAML Loader Tests
- **`orchestrator-ts/tests/infra/sdd/yaml-workflow-definition-loader.test.ts`** (152 lines)
  - Integration test: loads real `cc-sdd.yaml`, verifies 14 phases (line 23)
  - Validates outputFile for llm_prompt phases (line 30-38)
  - Validates approvalArtifact preservation (line 130-150)
  - Unit tests cover: missing file, malformed YAML, duplicate phases, unknown type, missing id
  - **GAP**: No test coverage for implementation_loop phase configuration

### Phase Runner Tests
- **`orchestrator-ts/tests/domain/phase-runner.test.ts`** (560 lines)
  - Lines 335-435: "IMPLEMENTATION phase with IImplementationLoop" suite (7 tests)
    - Tests delegation to `implementationLoop.run()`
    - Tests passing `specName` as `planId`
    - Tests outcome mapping (completed → ok:true, section-failed → ok:false, etc.)
    - Tests stubbing when no loop provided (line 426-434)
  - Lines 345-368: Verifies `implementationLoop.run` is called with `specName` as first arg and options as second
  - **GAP**: No tests for configuration extracted from YAML phase definition

### Integration and E2E Tests
- **`orchestrator-ts/tests/integration/workflow-engine.integration.test.ts`** — Workflow engine tests
- **`orchestrator-ts/tests/e2e/implementation-loop.e2e.test.ts`** — End-to-end implementation loop tests
- **`orchestrator-ts/tests/application/services/implementation-loop/implementation-loop-service.test.ts`** — Service tests

---

## 4. Known Constraints and Technical Debt

### Constraint 1: Empty Content Field for implementation_loop
- **Current**: YAML has `content: ""` for IMPLEMENTATION phase (line 110 in cc-sdd.yaml)
- **Validation**: `validateFrameworkDefinition()` only checks non-empty content for `llm_slash_command` and `llm_prompt` (line 52)
- **Implication**: Adding content/config to implementation_loop will not trigger validation errors; but no parser exists yet

### Constraint 2: Hardcoded Options
- **Current hardcoding locations**:
  - Default options in `implementation-loop-service.ts` lines 42-50 (e.g., `maxRetriesPerSection: 3`)
  - Quality gate config passed from DI container at runtime
  - No path from YAML to these options
- **Implication**: Configuration must be manually updated in code or DI setup; cannot be changed per workflow definition

### Constraint 3: No Type-Specific Configuration Schema
- **Current**: `PhaseDefinition` is generic; all phases share the same field set
- **Implication**: Adding `implementation_loop` config would require either:
  - A new optional field on `PhaseDefinition` (less type-safe)
  - Discriminated union by phase type (more complex parsing logic)

### Constraint 4: Schema Validation
- **Current**: YAML loader only validates against a fixed schema
- **Implication**: If `implementation_loop` gets a config object, schema must be validated at parse time (similar to how `required_artifacts` is validated)

### Constraint 5: Clean Architecture Boundaries
- **Current**: Domain layer (`framework.ts`) does not import from application layer
- **Implication**: Domain `PhaseDefinition` cannot reference `ImplementationLoopOptions` directly; would need to decode config as generic `Record<string, unknown>` in domain and convert in application layer

### Constraint 6: Options Merging
- **Current**: DI-provided options override defaults in `resolveOptions()` function (lines 52-56 in implementation-loop-service.ts)
- **Implication**: If YAML config is added, must decide merge strategy:
  - YAML values as defaults, DI values as overrides?
  - Conflict detection and error reporting?

### Technical Debt (Observation)
- `PhaseDefinition.content` serves different purposes depending on phase type:
  - For `llm_slash_command`: the command name (e.g., "kiro:spec-requirements")
  - For `llm_prompt`: the prompt template
  - For `implementation_loop`: currently empty (unused)
- This field conflation could make the schema confusing if extended

---

## 5. Current Component Responsibilities

| Component | File | Purpose | Configurability |
|-----------|------|---------|-----------------|
| **Loader** | `yaml-workflow-definition-loader.ts` | Parse YAML → `FrameworkDefinition` | Fixed schema, no type-specific logic |
| **Domain** | `framework.ts` | Type definitions for phases | Generic `PhaseDefinition` |
| **Phase Runner** | `phase-runner.ts` | Dispatch phase execution | Reads `phaseDef.type` and routes |
| **Implementation Loop Service** | `implementation-loop-service.ts` | Execute task sections | Accepts `ImplementationLoopOptions` at runtime |
| **DI Container** | `run-container.ts` (inferred) | Provide runtime dependencies | Wires options to PhaseRunner |

---

## 6. Data Model Snapshots

### Current YAML Structure (cc-sdd.yaml lines 108-112)
```yaml
- phase: IMPLEMENTATION
  type: implementation_loop
  content: ""
  required_artifacts:
    - tasks.md
```

### Current PhaseDefinition (parsed)
```typescript
{
  phase: "IMPLEMENTATION",
  type: "implementation_loop",
  content: "",
  requiredArtifacts: ["tasks.md"],
  // approvalGate, approvalArtifact, outputFile undefined
}
```

### Current ImplementationLoopOptions (applied at runtime)
```typescript
{
  maxRetriesPerSection: 3,           // hardcoded default
  qualityGateConfig: { checks: [] }, // hardcoded default or from config
  selfHealingLoop?: ISelfHealingLoop,
  eventBus?: IImplementationLoopEventBus,
  logger?: IImplementationLoopLogger,
  contextEngine?: IContextEngine,
  agentEventBus?: IAgentEventBus,
}
```

---

## 7. Summary: What Exists and What's Missing

### What Exists
- Stable domain types and interfaces (`PhaseExecutionType`, `PhaseDefinition`, `FrameworkDefinition`)
- Robust YAML loader with validation
- Well-designed implementation loop service accepting runtime options
- Clean separation of concerns across DI, workflow engine, and phase runner
- Comprehensive test coverage for YAML loading and phase runner behavior

### What's Missing
- No field in `PhaseDefinition` for phase-specific configuration
- No parsing logic in YAML loader for `implementation_loop` config
- No mechanism to pass YAML-extracted config to the implementation loop
- No schema validation for `implementation_loop` config structure
- No tests for configuration extraction from YAML

### Required Changes (Not Implemented)
1. Add configuration field to `PhaseDefinition` interface
2. Add YAML parsing logic for that field in `YamlWorkflowDefinitionLoader`
3. Add schema definition and validator for `implementation_loop` config
4. Thread configuration from `PhaseDefinition` through `PhaseRunner` to `IImplementationLoop.run()`
5. Update `ImplementationLoopOptions` handling to merge YAML config with runtime options
6. Add test coverage for all new functionality
