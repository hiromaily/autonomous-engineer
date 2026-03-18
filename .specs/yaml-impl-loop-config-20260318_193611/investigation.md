# DEEP-DIVE INVESTIGATION REPORT: YAML Implementation Loop Configuration

## Executive Summary

This report provides an in-depth analysis of the codebase to understand how to make the `implementation_loop` phase type configurable via the YAML workflow definition. The investigation reveals **clear integration paths** but also **critical design decisions** that must be made upfront regarding configuration scope, merge semantics, and schema validation.

---

## 1. ROOT CAUSE & INTEGRATION POINTS

### 1.1 How PhaseDefinition Flows Through the System

The configuration data flow is strictly one-directional:

```
YAML File (cc-sdd.yaml, line 108-112)
  ↓
YamlWorkflowDefinitionLoader.toPhaseDefinition() [line 60-96]
  ↓
PhaseDefinition { phase, type, content, requiredArtifacts, ... }
  ↓
FrameworkDefinition { id, phases: PhaseDefinition[] }
  ↓
PhaseRunner.execute(phase, ctx) [line 39-88]
  ↓
Line 72-82: case "implementation_loop":
    → implementationLoop.run(ctx.specName, this.implementationLoopOptions)
```

**Key Insight**: `PhaseRunner` already receives the full `PhaseDefinition` object at line 40:
```typescript
const phaseDef = findPhaseDefinition(this.frameworkDefinition, phase);
```

This means the phase definition is available in the phase runner switch statement, but **it is not currently examined for implementation_loop type**. The current code passes only pre-wired `implementationLoopOptions` from DI (line 74), ignoring the phase definition entirely.

### 1.2 Where Configuration Must Be Extracted

The extraction point is the YAML loader's `toPhaseDefinition()` method (orchestrator-ts/src/infra/sdd/yaml-workflow-definition-loader.ts, lines 60-96):

Currently this method:
- Extracts 6 fields: `phase`, `type`, `content`, `required_artifacts`, `approval_gate`, `approval_artifact`, `output_file`
- Validates `required_artifacts` array (line 79-90)
- Uses spread operator to conditionally add optional fields (lines 91-93)
- **Does not extract any type-specific configuration**

### 1.3 Where Configuration Must Be Applied

The application point is `PhaseRunner.execute()` (orchestrator-ts/src/application/services/workflow/phase-runner.ts, lines 72-82):

Current code:
```typescript
case "implementation_loop": {
  if (this.implementationLoop) {
    const result = await this.implementationLoop.run(ctx.specName, this.implementationLoopOptions);
```

To apply YAML config, this must be modified to:
1. Extract config from `phaseDef` (which is already available from line 40)
2. Merge it with DI-provided `this.implementationLoopOptions`
3. Pass the merged options to `run()`

The options flow through:
- `ImplementationLoopService.run()` accepts `options?: Partial<ImplementationLoopOptions>` (line 106)
- `resolveOptions()` function merges defaults with partial options (lines 52-56)

---

## 2. EDGE CASES & RISKS

### 2.1 Merge Strategy: YAML vs DI Conflict

**Current behavior** (line 52-56 in implementation-loop-service.ts):
```typescript
const DEFAULT_OPTIONS: Required<ImplementationLoopOptions> = {
  maxRetriesPerSection: 3,
  qualityGateConfig: { checks: [] },
  // ... service instances as undefined
};

function resolveOptions(partial: Partial<ImplementationLoopOptions>) {
  return { ...DEFAULT_OPTIONS, ...partial };
}
```

**Conflict scenario**: What if YAML specifies `maxRetriesPerSection: 5` but DI provides `maxRetriesPerSection: 2`?

**Options**:
1. **YAML as defaults, DI as overrides** (current spread order)
   - `{ ...yamlConfig, ...diOptions }` means DI always wins
   - **Risk**: Users cannot override via YAML; defeats the purpose of YAML configurability

2. **DI as defaults, YAML as overrides** (inverse spread)
   - `{ ...diOptions, ...yamlConfig }` means YAML always wins
   - **Risk**: debug mode's injected `agentEventBus` could be overridden unexpectedly

3. **Explicit validation with error on conflict**
   - Detect conflicts and throw error before execution
   - **Risk**: Stricter, but breaks workflows if operator forgets one config source

4. **Layered approach: only YAML scalars, DI services**
   - YAML provides `maxRetriesPerSection`, `qualityGateConfig`
   - DI provides `selfHealingLoop`, `eventBus`, `logger`, `contextEngine`, `agentEventBus`
   - **Recommended** - minimizes conflicts by partitioning by type

### 2.2 Unknown/Extra Config Keys

**Risk**: YAML has a typo like `maxRetryPerSection: 5` (singular instead of plural).

**Current YAML loader behavior**: Uses explicit field extraction (not generic deserialization):
```typescript
// Only these 6 fields are extracted
const def: PhaseDefinition = {
  phase: p["phase"],
  type: type as PhaseExecutionType,
  content: typeof p["content"] === "string" ? p["content"] : "",
  requiredArtifacts: [ ... ],
  approvalGate: ...,
  approvalArtifact: ...,
  outputFile: ...,
};
```

**Options**:
1. **Strict schema validation** — use a schema validator (e.g., zod, joi) to reject unknown keys
   - **Recommendation**: Emit warning or error if YAML contains unrecognized keys in the config object
2. **Warn (log)**: Log warning, continue with defaults
3. **Silent pass-through** — unknown keys are dropped with no message (current pattern)

**Recommendation**: **Strict for type-specific config**. When extracting implementation_loop config, validate against a schema.

### 2.3 Serialized Workflow State Compatibility

**Analysis**:
- State does not store phase configuration — only phase names and completion status
- **No forward/backward compatibility issue** — workflow state is independent of phase definition
- The phase definition is always loaded fresh from YAML on each run
- **Implication**: Changing YAML config will take effect on resume even if state was persisted before the feature was added

### 2.4 QualityGateConfig Serialization

`QualityGateConfig` is fully serializable (orchestrator-ts/src/application/ports/implementation-loop.ts, lines 46-63):
```typescript
export type QualityGateCheck = Readonly<{
  name: string;
  command: string;
  required: boolean;
  workingDirectory?: string;
}>;

export type QualityGateConfig = Readonly<{
  checks: ReadonlyArray<QualityGateCheck>;
}>;
```

**No service instances** — all fields are primitives or arrays of primitives.

**YAML mapping is safe**:
```yaml
config:
  qualityGateConfig:
    checks:
      - name: "lint"
        command: "bun run lint"
        required: true
      - name: "test"
        command: "bun test"
        required: false
        workingDirectory: "orchestrator-ts"
```

---

## 3. EXTERNAL DEPENDENCIES & API CONTRACTS

### 3.1 ImplementationLoopOptions: Safe vs Unsafe to Expose

**Full type** (orchestrator-ts/src/application/ports/implementation-loop.ts, lines 259-284):
```typescript
export type ImplementationLoopOptions = Readonly<{
  maxRetriesPerSection: number;                    // ✅ SAFE: primitive
  qualityGateConfig: QualityGateConfig;            // ✅ SAFE: fully serializable
  selfHealingLoop?: ISelfHealingLoop;              // ❌ UNSAFE: service instance
  eventBus?: IImplementationLoopEventBus;          // ❌ UNSAFE: service instance
  logger?: IImplementationLoopLogger;              // ❌ UNSAFE: service instance
  contextEngine?: IContextEngine;                  // ❌ UNSAFE: service instance
  agentEventBus?: IAgentEventBus;                  // ❌ UNSAFE: service instance
}>;
```

**Safe subset to expose via YAML**:
- `maxRetriesPerSection` (number, default: 3)
- `qualityGateConfig` (nested object with checks array)

**Unsafe subset (DI-only)**:
- All service instances

### 3.2 Options Merge Point

**Three-layer precedence**:
1. **Defaults** (hardcoded: maxRetriesPerSection=3, qualityGateConfig={checks:[]})
2. **YAML config** (user-defined in phase definition)
3. **DI options** (runtime injections, service instances — e.g., debug agentEventBus)

**Recommended pattern**:
```typescript
// In PhaseRunner.execute(), case "implementation_loop":
const yamlConfig = extractImplementationLoopConfig(phaseDef);
// DI service instances take precedence; YAML controls scalars
const mergedOptions = { ...yamlConfig, ...this.implementationLoopOptions };
// resolveOptions() applies final defaults for anything still undefined
const result = await this.implementationLoop.run(ctx.specName, mergedOptions);
```

---

## 4. PRIOR ART: How Other Phases Use `content`

### 4.1 Phase Type Usage Patterns

From cc-sdd.yaml:

| Phase Type | Content Usage | Example |
|---|---|---|
| `llm_slash_command` | Command name to invoke | `"kiro:spec-requirements"` |
| `llm_prompt` | Full prompt template (multiline) | Detailed multi-line instruction with interpolation |
| `human_interaction` | Empty string | `""` |
| `suspension` | Empty string | `""` |
| `git_command` | Empty string | `""` |
| `implementation_loop` | **Empty string** | `""` (currently unused) |

### 4.2 Content Field Ambiguity

**Problem**: `PhaseDefinition.content` serves different semantic purposes:
- For `llm_slash_command`: the command identifier
- For `llm_prompt`: the prompt text
- For `implementation_loop`: nothing (wasted field)

### 4.3 Configuration Location Decision: `content` vs New Field

**Option A: Repurpose `content` as YAML sub-document**
```yaml
- phase: IMPLEMENTATION
  type: implementation_loop
  content: |
    maxRetriesPerSection: 5
```
**Pros**: Reuses existing field
**Cons**: Semantic confusion; content is a string but must be parsed; violates Single Responsibility

**Option B: Add new top-level field like `config`**
```yaml
- phase: IMPLEMENTATION
  type: implementation_loop
  config:
    maxRetriesPerSection: 5
    qualityGateConfig:
      checks:
        - name: lint
          command: bun run lint
          required: true
```
**Pros**: Clear semantics; type-safe at domain level
**Cons**: Requires PhaseDefinition interface change

**Recommendation**: **Option B** — add `config?: Record<string, unknown>` to `PhaseDefinition`, with type-specific validation only for `implementation_loop` in the loader.

---

## 5. IDENTIFIED AMBIGUITIES REQUIRING DESIGN DECISIONS

### 5.1 Configuration Scope

**Recommendation**: **Phase 1 scope** — expose only `maxRetriesPerSection` and `qualityGateConfig`. Add others in future phases if needed.

### 5.2 Configuration Merge Semantics

**Recommendation**: **Layered approach**.
- YAML can set: `maxRetriesPerSection`, `qualityGateConfig`
- DI always provides: `selfHealingLoop`, `eventBus`, `logger`, `contextEngine`, `agentEventBus`
- Cleanest separation of concerns

### 5.3 Schema Validation for YAML Config

**Recommendation**: **Strict for type-specific config**. When extracting implementation_loop config, validate against a manual schema:
```typescript
if (config.maxRetriesPerSection !== undefined && !Number.isInteger(config.maxRetriesPerSection)) {
  throw new Error(`Invalid maxRetriesPerSection: must be an integer, got ${typeof config.maxRetriesPerSection}`);
}
```

---

## 6. CLEAN ARCHITECTURE LAYER BOUNDARY ANALYSIS

### Proposed Changes Maintain Boundaries

1. **Domain** adds `config?: Record<string, unknown>` to `PhaseDefinition`
   - Still generic, no application imports
   - ✅ Boundary maintained

2. **Infrastructure** extracts config from YAML
   - Validates primitives (string, number, array, object types)
   - Does not validate semantic shape (that's application layer)
   - ✅ Boundary maintained

3. **Application** interprets config and merges with options
   - Knows about `ImplementationLoopOptions` and its shape
   - Performs type-safe extraction and validation
   - ✅ Boundary maintained

---

## 7. VALIDATION & TEST COVERAGE GAPS

### Required Test Suite

**Core functionality**:
1. YAML loader extracts implementation_loop config
2. Config is passed through PhaseRunner to implementationLoop.run()
3. DI options are merged correctly with YAML config
4. Invalid config is rejected with helpful error

**Edge cases**:
1. Unknown config keys in YAML produce error
2. Config merging respects layering (scalar vs service)
3. Backward compatibility: old YAML without config still works
4. Empty config object `{}` is handled gracefully

---

## 8. OPEN QUESTIONS FOR DESIGN REVIEW

1. **Configuration Location**: Should phase-specific config live in a new `config` field (recommended) or repurposed `content` field?

2. **Merge Precedence**: When YAML and DI options both provide `maxRetriesPerSection`, which wins? Recommended: **layered approach** where YAML controls scalars, DI always injects services.

3. **Schema Validation Strictness**: Should unknown config keys cause errors (strict) or warnings (lenient)?

4. **Future Extensibility**: Should the design allow other phase types to have configuration in the future? The infrastructure should be generic.

5. **Interpolation**: Should YAML config support `{specDir}`, `{specName}`, `{language}` interpolation? (Example: `workingDirectory: "{specDir}/orchestrator-ts"`)

---

## 9. SUMMARY: CRITICAL DESIGN DECISIONS

| Decision | Recommendation | Rationale |
|----------|-----------------|-----------|
| **Config location** | New `config?: Record<string, unknown>` field on `PhaseDefinition` | Type-safe, clear semantics, supports future phase types |
| **Serializable scope** | `maxRetriesPerSection`, `qualityGateConfig` only | Service instances cannot be YAML-serialized |
| **Merge semantics** | Layered: YAML scalars + DI services | Respects both operator intent (YAML) and framework concerns (DI) |
| **Schema validation** | Strict on type-specific config | Fail fast on typos; detect errors at load time |
| **Backward compat** | No action needed | State doesn't store config; YAML config is optional |
| **Interpolation** | Support {specDir}, {specName}, {language} | Consistency with other phase types |
