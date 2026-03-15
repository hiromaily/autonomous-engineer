# Research & Design Decisions

## Summary

**Discovery Scope**: Extension — integrates four existing services (spec4 agent-loop, spec6 context-engine, spec7 task-planning, spec8 git-integration) into a new orchestration layer.

**Key Findings**:
1. The codebase already has two strong orchestration precedents: `AgentLoopService` (cognitive loop) and `TaskPlanningService` (plan execution with retry). `ImplementationLoopService` follows the same service + port pattern at a higher abstraction level.
2. `TaskPlanningService` already owns plan-state persistence via `PlanFileStore` (infra/planning). The implementation loop can read plan state from the same store without duplicating persistence logic.
3. The review engine is a net-new concern — no existing `IReviewEngine` port or implementation exists. It must be designed as a first-class port interface so the review strategy can be substituted (LLM-based vs. tool-based).

**No external dependency research needed** — all integrations are internal (agent loop, context engine, git integration, task planning). Technology choices follow existing project conventions.

---

## Research Log

### Topic 1: Existing Orchestration Patterns

**Source**: `orchestrator-ts/src/application/agent/agent-loop-service.ts`, `orchestrator-ts/src/application/planning/task-planning-service.ts`

**Findings**:
- Both services use constructor injection of port interfaces; no concrete adapters in constructors.
- Both expose `stop()` for graceful cancellation via a private `#stopRequested` flag.
- Both return discriminated union result types (`AgentLoopResult`, `TaskPlanResult`) — never throw from public methods.
- `TaskPlanningService` provides `resume(planId)` that reads from `PlanFileStore` — the implementation loop should delegate resumability to the same mechanism.
- `AgentLoopService` step state is fully immutable; each iteration produces a new `AgentState` snapshot.

**Implication**: The implementation loop should follow the same patterns: port-based injection, stop flag, discriminated result types, immutable state.

---

### Topic 2: Plan State & Section Lifecycle

**Source**: `orchestrator-ts/src/domain/planning/types.ts`

**Findings**:
- `Step` (task section) already has `status: StepStatus` ("pending" | "in_progress" | "completed" | "failed").
- `TaskPlan` has `tasks[]` each containing `steps[]`.
- `PlanFileStore` handles persistence; the implementation loop reads/writes via `ITaskPlanner` or directly via a plan store port.
- No `escalated` status exists in current `StepStatus` — new status values will be needed.

**Implication**: Domain types must be extended with `"escalated"` and optionally `"escalated-to-human"` step statuses, or a separate `SectionExecutionStatus` type should be introduced to avoid polluting the existing planning domain.

**Decision**: Introduce a separate `SectionExecutionRecord` domain type rather than modifying existing `StepStatus` to preserve backward compatibility with TaskPlanningService.

---

### Topic 3: Review Engine — New Concern

**Source**: Requirements 3, 6; no existing review engine found in codebase.

**Findings**:
- No `IReviewEngine` port or any review engine service exists.
- Review logic spans three dimensions: requirement alignment (LLM-based), design consistency (LLM-based), code quality (tool-based: lint + test runner).
- Code-quality checks involve invoking shell tools (already available via `IToolExecutor` / shell adapter).
- LLM-based review fits the existing `LlmProviderPort` pattern.

**Implication**: `IReviewEngine` is a new first-class port. Its initial implementation will be an LLM-driven service that also invokes tools for lint/test. The interface must be abstract enough to support substitution.

---

### Topic 4: Context Isolation Strategy

**Source**: Requirements 8; `orchestrator-ts/src/application/context/context-engine-service.ts`, `orchestrator-ts/src/application/ports/context.ts`

**Findings**:
- `IContextProvider` has a `buildContext()` method; fresh invocations produce isolated snapshots.
- `ContextEngineService` does not maintain cross-call state — each call is independent.
- `AgentLoopOptions.contextProvider` is optional — the implementation loop can pass a freshly scoped provider per section.

**Implication**: Context isolation is achieved by obtaining a new `ContextEngineService` instance (or calling `buildContext()` with section-scoped parameters) at the start of each section. No special "reset" API is needed.

---

### Topic 5: Self-Healing Loop Integration (spec10)

**Source**: Requirements 7; spec10 is not yet implemented.

**Findings**:
- spec10 does not exist in the codebase yet.
- The implementation loop must reference spec10 only through a port interface (`ISelfHealingLoop`).
- The port must be optional (injectable); if not provided, fall back to marking section as `failed` and halting.

**Implication**: Define `ISelfHealingLoop` as an optional dependency in `ImplementationLoopOptions`. The initial implementation-loop service can provide a no-op fallback when spec10 is absent.

---

## Architecture Pattern Evaluation

| Pattern | Pros | Cons | Decision |
|---------|------|------|----------|
| Embed review in agent loop | No new service boundary | Violates single-responsibility; agent loop already complex | Rejected |
| Review as port + standalone service | Substitutable; testable independently | Extra file count | **Selected** |
| Monolithic implementation-loop with inline review | Simple | Hard to test review logic; violates existing separation pattern | Rejected |
| Event-sourced section state | Full auditability | Over-engineered for current scope | Rejected — use `SectionExecutionRecord` snapshots |

---

## Design Decisions

### Decision 1: `IReviewEngine` as a first-class port

**Context**: Review logic spans LLM calls and tool execution; must be substitutable for testing.
**Alternatives**: Inline review in `ImplementationLoopService`; make review a method on agent loop.
**Selected**: Define `IReviewEngine` port in `application/ports/review-engine.ts`.
**Rationale**: Consistent with existing port pattern; enables independent unit testing; allows future swap to tool-only or specialized review agents.
**Trade-offs**: One extra port file; minimal overhead.
**Follow-up**: Implement `LlmReviewEngineService` in `application/implementation-loop/` as the default implementation.

---

### Decision 2: `SectionExecutionRecord` as a separate domain type

**Context**: `StepStatus` from planning domain only has "pending" | "in_progress" | "completed" | "failed".
**Alternatives**: Extend `StepStatus` with "escalated" and "escalated-to-human".
**Selected**: Introduce `SectionExecutionRecord` in `domain/implementation-loop/types.ts`.
**Rationale**: Avoids mutating the planning domain contract; implementation-loop concerns are orthogonal to plan scheduling concerns.
**Trade-offs**: Two parallel status representations; implementation loop must map between them.

---

### Decision 3: `ISelfHealingLoop` as optional constructor dependency

**Context**: spec10 is not yet implemented; implementation loop must work without it.
**Alternatives**: Hard-code spec10 unavailability check; throw if not provided.
**Selected**: Accept `ISelfHealingLoop | null` in constructor; use null-object fallback.
**Rationale**: Allows integration testing without spec10; aligns with requirement 7.4.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Review engine produces noisy feedback causing infinite improvement loops | Medium | High | `maxRetriesPerSection` gate (Req 5); quality gate requires deterministic tool checks |
| Context accumulation across improve steps exceeds token budget | Medium | Medium | Context engine compression (Req 8.3) + per-section budget configuration |
| Plan state divergence between in-memory and persisted store | Low | High | Read exclusively from `PlanFileStore` at startup (Req 9.4); write after each section |
| spec10 not available at runtime | High (initially) | Medium | Null-object fallback marks section failed, emits halt summary (Req 7.4) |

---

## References

- `orchestrator-ts/src/application/agent/agent-loop-service.ts` — cognitive loop pattern reference
- `orchestrator-ts/src/application/planning/task-planning-service.ts` — plan orchestration pattern reference
- `orchestrator-ts/src/application/ports/agent-loop.ts` — port interface pattern
- `orchestrator-ts/src/application/ports/task-planning.ts` — port interface pattern
- `orchestrator-ts/src/domain/planning/types.ts` — existing plan domain types
- `orchestrator-ts/src/domain/agent/types.ts` — existing agent domain types
- `.kiro/specs/implementation-loop/requirements.md` — source requirements
