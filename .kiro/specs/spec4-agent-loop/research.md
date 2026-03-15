# Research & Design Decisions

---
**Purpose**: Capture discovery findings, architectural investigations, and rationale that inform the technical design.

---

## Summary

- **Feature**: `agent-loop`
- **Discovery Scope**: New Feature (greenfield) — complex domain orchestration
- **Key Findings**:
  - The existing codebase provides all required infrastructure (`IToolExecutor`, `IToolRegistry`, `LlmProviderPort`) via dependency injection; the agent loop is an application-layer orchestration consumer of these ports.
  - The project uses an immutable discriminated-union result pattern (`{ ok: true; value } | { ok: false; error }`) consistently across LLM and tool layers; the agent loop must follow the same convention.
  - `AgentState` must use exclusively plain, serializable (`readonly`) data structures to support interruption/resume without a custom serializer.
  - No new external library dependencies are introduced; the agent loop is a pure TypeScript orchestration service.

---

## Research Log

### Topic 1: Existing Codebase Architecture Patterns

- **Context**: Agent loop must integrate with spec1 (orchestrator-core) and spec2 (tool-system) without architectural drift.
- **Sources Consulted**: `orchestrator-ts/` directory — all TypeScript source files, `domain/`, `application/`, `adapters/`, `infra/` layers.
- **Findings**:
  - Layer hierarchy: `domain/` (types + core logic) → `application/ports/` (port interfaces) + `application/usecases/` or `application/<feature>/` (orchestration) → `adapters/` (implementations) → `infra/` (persistence, events, config).
  - `ToolExecutor` (`application/tools/executor.ts`) is the precedent for complex orchestration: all steps as private methods within a single cohesive class, dependencies injected via constructor, never throws (errors returned in `ToolResult`).
  - `WorkflowEventBus` (`infra/events/workflow-event-bus.ts`) demonstrates the event bus pattern with `emit/on/off`, typed `WorkflowEvent` discriminated union.
  - `LlmProviderPort` (`application/ports/llm.ts`): `complete(prompt, options?): Promise<LlmResult>` — one method, never throws.
  - `IWorkflowStateStore` demonstrates persist/restore for durable state.
- **Implications**: `AgentLoopService` belongs at `application/agent/agent-loop-service.ts`. Domain types belong at `domain/agent/types.ts`. Port interface at `application/ports/agent-loop.ts`.

### Topic 2: State Immutability and Serialization

- **Context**: Requirement 1.4 demands that `AgentState` can be serialized and restored after interruption.
- **Sources Consulted**: Existing `WorkflowState` in `domain/workflow/types.ts`.
- **Findings**:
  - `WorkflowState` uses exclusively `readonly` scalars and `readonly` arrays — directly JSON-serializable without custom logic.
  - No class instances, Symbols, or functions appear in `WorkflowState`; same constraint applies to `AgentState`.
  - `Observation.rawOutput` must be typed as `unknown` with a serialization boundary (serialized to string before persistence if needed).
- **Implications**: `AgentState` and `Observation` are pure value-object records. Each step returns a new state rather than mutating the existing one. `rawOutput` in `Observation` is stored as `unknown` during in-memory execution and serialized to string on persistence.

### Topic 3: Event Emission Pattern

- **Context**: Requirements 7 and 9 specify structured events and per-iteration logs. The question was whether to reuse `IWorkflowEventBus` or introduce a separate `IAgentEventBus`.
- **Sources Consulted**: `application/ports/workflow.ts`, `infra/events/workflow-event-bus.ts`.
- **Findings**:
  - `WorkflowEvent` is a discriminated union of 6 event types covering workflow-level concerns (phase start/complete/error, approval required, workflow complete/failed).
  - Agent-loop events operate at a finer granularity (per-iteration, per-step) and have a different lifecycle from workflow events.
  - Mixing them into `WorkflowEvent` would violate single-responsibility and create coupling between spec1 and spec4.
- **Implications**: Define a separate `AgentLoopEvent` union in `domain/agent/types.ts`. Introduce `IAgentEventBus` in `application/ports/agent-loop.ts` following the same `emit/on/off` pattern. The infra adapter (`infra/agent/agent-event-bus.ts`) can be implemented later.

### Topic 4: LLM Response Parsing and Reliability

- **Context**: Requirements 2.2, 2.4, and 5.2 require parsing structured `ActionPlan` and `ReflectionOutput` from LLM responses. The LLM is not guaranteed to return well-formed JSON.
- **Sources Consulted**: `adapters/llm/claude-provider.ts`.
- **Findings**:
  - The existing `claude-provider.ts` returns raw text content; JSON extraction is the caller's responsibility.
  - Common pattern for structured LLM output: prompt requests JSON in a specific schema; caller attempts JSON.parse; retries on failure.
  - `maxPlanParseRetries` should be configurable and distinct from `maxRecoveryAttempts`.
- **Implications**: The PLAN step includes a parse-retry loop (configurable `maxPlanParseRetries`, default 2). The REFLECT step similarly retries parsing. Parse failures that exhaust retries are escalated as `HUMAN_INTERVENTION_REQUIRED`.

### Topic 5: Context Assembly Without spec6

- **Context**: Requirement 11.5 says context assembly is delegated to an injected `IContextProvider` when spec6 is available. When absent, the agent loop must still function.
- **Findings**:
  - The PLAN step needs: task string, current plan, completed steps, recent observations, available tool schemas.
  - A minimal inline context builder can concatenate these fields as structured text — sufficient for the agent loop to function independently of spec6.
  - `IContextProvider` is defined as an optional port; if absent, the fallback builder activates.
- **Implications**: `AgentLoopService` contains a private `#buildContext()` method that either delegates to the injected `IContextProvider` or falls back to inline construction. This keeps the agent loop independently runnable (spec4 prerequisite for spec7, not spec6).

### Topic 6: Stop Signal Mechanism

- **Context**: Requirements 7.6 and 11.3 require an external `stop()` method that halts the loop at the next PLAN step boundary without interrupting an in-flight tool call.
- **Findings**:
  - Async cancellation in TypeScript without `AbortController` threading: a shared `#stopRequested: boolean` flag is checked at the start of each PLAN step — safe since the loop is single-threaded per `await` boundary.
  - The safety layer emergency stop (requirement 7.5) bypasses the step boundary and halts immediately; this is handled by the safety adapter signaling via a separate `SafetySignal` callback.
- **Implications**: `AgentLoopService` holds `#stopRequested = false`. The `stop()` method sets it `true`. Each iteration checks the flag before invoking `#planStep()`. The safety stop uses an injected callback `onSafetyStop` in `AgentLoopOptions`.

---

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Single cohesive service class | All loop steps as private methods in `AgentLoopService` | Cohesive, easy to trace execution, consistent with `ToolExecutor` precedent | Large single class if steps grow complex | **Selected** — matches existing codebase patterns |
| Step pipeline with separate step classes | Each step is a class implementing `IStep` | Individually testable steps, open for extension | Over-engineered for current scope; parallel team risk | Deferred to v1.x if complexity grows |
| Generator-based coroutine loop | `async function*` yielding state at each step | Elegant resumption, observable progress | Unfamiliar pattern in TypeScript; harder to test | Not selected |

---

## Design Decisions

### Decision: Domain Type Location

- **Context**: Where should `AgentState`, `ActionPlan`, `Observation`, `ReflectionOutput`, and `AgentLoopEvent` be defined?
- **Alternatives Considered**:
  1. `application/agent/types.ts` — co-located with service
  2. `domain/agent/types.ts` — domain layer, independent of application logic
- **Selected Approach**: `domain/agent/types.ts`
- **Rationale**: These types represent domain concepts (task execution state, observations, plans) that will be referenced by spec7 (task-planning) and spec9 (implementation-loop). Domain types should not depend on application concerns.
- **Trade-offs**: Slightly more indirection; outweighed by correct layering.

### Decision: Immutable State Updates

- **Context**: `AgentState` can be updated from multiple step methods; mutation risk is high in a complex loop.
- **Alternatives Considered**:
  1. Mutable class with setters
  2. Readonly records replaced on each step return (immutable)
- **Selected Approach**: Immutable — each step receives `AgentState` and returns a new `AgentState`.
- **Rationale**: Consistent with existing `WorkflowState` pattern. Eliminates partial-mutation bugs. Enables easy serialization at any point.
- **Trade-offs**: Slightly higher allocation cost; not measurable at loop iteration frequency.

### Decision: Event Bus — Separate vs Shared

- **Context**: Whether to introduce a new `IAgentEventBus` or extend `IWorkflowEventBus`.
- **Selected Approach**: New `IAgentEventBus` with the same `emit/on/off` interface shape.
- **Rationale**: Agent-loop events (per-iteration, per-step) operate at a different granularity and lifecycle from workflow-phase events. Mixing them creates spec1↔spec4 coupling.
- **Trade-offs**: One more interface to define; no shared infrastructure cost since pattern is copied.

### Decision: LLM Parse Retry vs Tool Recovery Retry

- **Context**: Two kinds of retries exist: LLM response parsing failures (PLAN/REFLECT steps) and tool execution failures (error recovery sub-loop).
- **Selected Approach**: Separate `maxPlanParseRetries` (default 2) in `AgentLoopOptions` distinct from `maxRecoveryAttempts` (default 3).
- **Rationale**: These retries address different failure modes with different recovery strategies (re-prompt LLM vs re-execute tool with fix).
- **Follow-up**: Verify retry counts are reasonable in integration tests.

---

## Risks & Mitigations

- **LLM non-determinism in PLAN step** — LLM may occasionally return unparseable output. Mitigation: parse-retry loop with `maxPlanParseRetries`; escalate to `HUMAN_INTERVENTION_REQUIRED` on exhaustion.
- **Token budget overflow in PLAN context** — large `observations` accumulation may exceed LLM context window. Mitigation: sliding window of N most-recent observations (determined by `IContextProvider` or fallback inline budget); requirement 4.4 captures this.
- **Stuck in error recovery** — error recovery sub-loop could cycle without progress. Mitigation: `maxRecoveryAttempts` enforced per error occurrence; repeated-failure detection escalates immediately (requirement 8.5).
- **Stop signal race on in-flight tool call** — `stop()` called while ACT step executes. Mitigation: stop flag is checked only at PLAN step boundary; current tool call completes normally before halt.
- **AgentState serialization of rawOutput** — `Observation.rawOutput` is `unknown` and may not be directly JSON-serializable. Mitigation: persistence layer (spec5/task-planning) is responsible for serialization; in-memory agent loop operates on `unknown`.

---

## References

- `orchestrator-ts/domain/tools/types.ts` — `ToolError`, `ToolResult<T>`, `Tool<Input,Output>` interface patterns
- `orchestrator-ts/application/tools/executor.ts` — `IToolExecutor`, `ToolExecutor` — precedent for application-layer orchestration class
- `orchestrator-ts/application/ports/llm.ts` — `LlmProviderPort`, `LlmResult` — LLM abstraction pattern
- `orchestrator-ts/domain/workflow/types.ts` — `WorkflowState` — immutable state record precedent
- `orchestrator-ts/application/ports/workflow.ts` — `IWorkflowEventBus`, `WorkflowEvent` — event bus pattern
- `docs/architecture/agent-loop-architecture.md` — architectural reference for loop steps
- `docs/agent/dev-agent-v1-specs.md` — spec4 definition and sub-component list
