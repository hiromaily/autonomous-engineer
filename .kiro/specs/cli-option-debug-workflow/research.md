# Research & Design Decisions

---
**Purpose**: Capture discovery findings, architectural investigations, and rationale that inform the technical design.

---

## Summary

- **Feature**: `cli-option-debug-workflow`
- **Discovery Scope**: Extension (adding to existing CLI, workflow engine, and agent loop)
- **Key Findings**:
  - `RunSpecUseCase` accepts a `createLlmProvider` factory, making mock injection straightforward without modifying the engine.
  - `WorkflowEngine` takes a concrete `ApprovalGate` class. A `DebugApprovalGate extends ApprovalGate` override avoids touching `WorkflowEngine` or extracting a new interface.
  - `ConfigLoader.validate()` unconditionally requires `apiKey`; bypass by providing a placeholder value from the CLI layer when `--debug-flow` is set, keeping `ConfigLoader` itself unchanged.
  - Agent loop debug events require a new optional observer hook in `AgentLoopOptions`; the `MockLlmProvider` also intercepts all `complete()` calls, providing the LLM call log as a side effect.

## Research Log

### LLM Mock Injection Point

- **Context**: Where in the call chain can the real LLM provider be swapped without changing core workflow logic?
- **Sources Consulted**: `orchestrator-ts/src/cli/index.ts`, `src/application/usecases/run-spec.ts`
- **Findings**:
  - `RunSpecUseCase` accepts `createLlmProvider: (cfg, override?) => LlmProviderPort` — a factory function.
  - The factory is called inside `run-spec.ts` just before `PhaseRunner` is constructed. Overriding the factory at the CLI layer is the only change needed.
  - `PhaseRunner` only calls `llm.clearContext()`. Actual LLM `complete()` calls happen inside `AgentLoopService` (implementation phase) and `SelfHealingLoopService`.
- **Implications**: `MockLlmProvider` satisfies `LlmProviderPort`; no changes to `RunSpecUseCase` or `WorkflowEngine` are required.

### Config API Key Bypass

- **Context**: `ConfigLoader.validate()` fails for missing `llm.apiKey`; debug-flow must not require a real key.
- **Sources Consulted**: `src/infra/config/config-loader.ts`, `src/application/ports/config.ts`
- **Findings**:
  - `ConfigLoader.validate()` enforces `apiKey` as a hard required field with no opt-out.
  - Adding a `debugMode` flag to `ConfigLoader` would spread debug coupling into infra.
  - Cleanest option: CLI layer catches `ConfigValidationError` when `--debug-flow` is set, then re-tries with a synthesized `AesConfig` that has `apiKey: "__debug__"` and uses `MockLlmProvider`. No changes to `ConfigLoader`.
- **Implications**: `ConfigLoader` remains unchanged. The CLI handles the bypass explicitly and transparently.

### ApprovalGate Auto-Approval

- **Context**: `WorkflowEngine` uses `ApprovalGate` to pause the workflow for human review; debug-flow must auto-approve.
- **Sources Consulted**: `src/domain/workflow/approval-gate.ts`, `src/domain/workflow/workflow-engine.ts`
- **Findings**:
  - `WorkflowEngine.deps` types `approvalGate` as `ApprovalGate` (concrete class), not an interface.
  - `ApprovalGate.check()` is public and non-final; subclassing with `DebugApprovalGate extends ApprovalGate` that overrides `check()` to always return `{ approved: true }` works without modifying `WorkflowEngine` or extracting a new interface.
  - Extracting `IApprovalGate` would be cleaner long-term but is out of scope for this feature.
- **Implications**: `DebugApprovalGate` extends `ApprovalGate`, overriding `check()`. `RunSpecUseCase` instantiates the right gate based on `debugFlow` option.

### Agent Loop Iteration Events

- **Context**: Requirement 3 requires per-iteration structured logs (phase, step type, tool, result). The agent loop currently has no debug callback.
- **Sources Consulted**: `src/application/ports/agent-loop.ts`, `src/application/agent/agent-loop-service.ts`
- **Findings**:
  - `AgentLoopOptions` already carries `maxIterations`, `maxRecoveryAttempts`, etc. Adding an optional `onIteration?: (entry: AgentIterationLogEntry) => void` callback follows the existing pattern.
  - `AgentLoopService` calls the callback at the end of each iteration's update step. No behavior change when the callback is absent.
  - The callback is threaded from CLI → `ImplementationLoopService` → `AgentLoopService` via options.
- **Implications**: One new field in `AgentLoopOptions`; `AgentLoopService` calls it in the non-hot path; no impact on non-debug runs.

### Debug Output Routing

- **Context**: Debug events come from two sources: (1) `MockLlmProvider` call log; (2) `AgentLoopService` iteration callback. Both must route to the same `IDebugEventSink`.
- **Sources Consulted**: `src/cli/json-log-writer.ts`, `src/cli/renderer.ts`
- **Findings**:
  - `JsonLogWriter` (existing) is a clean model: write NDJSON entries to a file, flush on close.
  - A `DebugLogWriter` following the same pattern writes `DebugEvent` entries to stderr (default) or a file.
  - Both `MockLlmProvider` and `DebugApprovalGate` accept `IDebugEventSink` in their constructors. The sink is instantiated once in `cli/index.ts` and shared.
- **Implications**: One new infra file (`debug-log-writer.ts`) mirroring `json-log-writer.ts`. The sink interface is a simple port with `emit(event)` and `close()` signatures.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations |
|--------|-------------|-----------|---------------------|
| Factory swap at CLI | Inject `MockLlmProvider` via existing `createLlmProvider` factory | Zero changes to core; follows existing pattern | Mock must be wired carefully to thread through all consumers |
| Middleware / decorator on `LlmProviderPort` | Wrap real provider with a logging decorator | Reusable for production tracing | Doesn't skip real API calls — wrong for debug-flow |
| Global singleton debug flag | Pass a boolean through context | Simple | Spreads debug coupling throughout the codebase |

**Selected**: Factory swap at CLI.

## Design Decisions

### Decision: `DebugApprovalGate extends ApprovalGate`

- **Context**: `WorkflowEngine` depends on concrete `ApprovalGate`. Must auto-approve in debug-flow.
- **Alternatives Considered**:
  1. Extract `IApprovalGate` interface — cleaner but larger change scope
  2. Add `autoApprove` boolean to `ApprovalGate` — mixes debug concern into production code
  3. Subclass `ApprovalGate` with override — minimal, zero impact on non-debug path
- **Selected Approach**: Option 3 (`DebugApprovalGate extends ApprovalGate`).
- **Rationale**: Respects existing code ownership; no interface extraction required for a single debug consumer.
- **Trade-offs**: `WorkflowEngine` remains coupled to the concrete class, a mild OCP violation; acceptable for this scope.

### Decision: `IDebugEventSink` as a shared port

- **Context**: Two components (`MockLlmProvider`, `DebugApprovalGate`) need to emit debug events to the same destination.
- **Alternatives Considered**:
  1. Direct `DebugLogWriter` reference — couples providers to infra
  2. Shared `IDebugEventSink` port — follows hexagonal pattern
- **Selected Approach**: Option 2; both components accept `IDebugEventSink` in constructors.
- **Rationale**: Consistent with existing port/adapter pattern; allows test doubles.

### Decision: `onIteration` callback in `AgentLoopOptions`

- **Context**: Per-iteration agent events require a hook in `AgentLoopService`.
- **Alternatives**:
  1. New event channel on `WorkflowEventBus` — pollutes production event contract
  2. Optional callback in `AgentLoopOptions` — follows established options-bag pattern
- **Selected Approach**: Option 2.
- **Rationale**: Zero overhead when unset; no changes to `WorkflowEventBus` schema.

## Risks & Mitigations

- **Mock response causes phase stall**: If `MockLlmProvider` returns a response that `PhaseRunner` or `AgentLoopService` cannot parse as a valid completion signal, the workflow loops indefinitely. Mitigation: default mock response is a pass-through success string validated against the phase parser contract.
- **API key bypass in config**: If operator accidentally runs with `--debug-flow` in CI, the mock will succeed silently. Mitigation: the `[DEBUG-FLOW MODE]` startup banner is emitted to stderr before any work begins.
- **`DebugApprovalGate` bypasses gate in wrong context**: If `--debug-flow` is accidentally set in a production environment, all gates are bypassed. Mitigation: the startup banner makes the mode visible; no special production safeguard needed (debug-flow is a developer tool).

## References

- `orchestrator-ts/src/cli/index.ts` — entry point, flag definitions, factory injection
- `orchestrator-ts/src/application/usecases/run-spec.ts` — `createLlmProvider` factory pattern
- `orchestrator-ts/src/domain/workflow/approval-gate.ts` — gate check contract
- `orchestrator-ts/src/domain/workflow/workflow-engine.ts` — gate invocation in `runPendingPhases`
- `orchestrator-ts/src/application/ports/agent-loop.ts` — `AgentLoopOptions` extension point
- `orchestrator-ts/src/cli/json-log-writer.ts` — NDJSON writer model for `DebugLogWriter`
