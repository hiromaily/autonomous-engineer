# Research & Design Decisions — task-planning

---
**Purpose**: Capture discovery findings, architectural investigations, and rationale that inform the technical design.

---

## Summary

- **Feature**: `task-planning`
- **Discovery Scope**: Complex Integration (depends on spec4: agent-loop and spec6: context-engine; both fully implemented in codebase)
- **Key Findings**:
  - The existing `IAgentLoop` port (`application/ports/agent-loop.ts`) accepts a `task: string` and returns an `AgentLoopResult` with `terminationCondition`. Task Planning can drive the Agent Loop by passing each Step's description as the task string — no modifications to spec4 required.
  - The existing `IContextProvider` port (used by spec4/spec6) defines `buildContext(state, toolSchemas): Promise<string>`. The Task Planning service should inject an `IContextEngine` port (spec6) for plan-generation prompts, consistent with how spec4 delegates context assembly.
  - The `FileMemoryStore` uses atomic temp-file + rename writes (`atomicWrite` helper). The same pattern must be used for plan persistence at `.memory/tasks/task_{id}.json` to guarantee durability.
  - The existing `domain/workflow/approval-gate.ts` and `adapters/safety/approval-gateway.ts` demonstrate the human approval gate pattern: an application port interface + adapter implementation. The task-planning human review gate should follow this same pattern.

## Research Log

### Existing Agent Loop Interface

- **Context**: Need to know exactly how TaskPlanningService invokes the Agent Loop per step.
- **Sources Consulted**: `application/ports/agent-loop.ts`, `application/agent/agent-loop-service.ts`
- **Findings**:
  - `IAgentLoop.run(task: string, options?: Partial<AgentLoopOptions>): Promise<AgentLoopResult>` — never throws; all errors surface as `TerminationCondition`
  - `AgentLoopResult.terminationCondition` is one of: `TASK_COMPLETED | MAX_ITERATIONS_REACHED | HUMAN_INTERVENTION_REQUIRED | SAFETY_STOP | RECOVERY_EXHAUSTED`
  - `AgentLoopResult.taskCompleted: boolean` — true only on `TASK_COMPLETED`
  - `AgentLoopOptions.eventBus`, `.logger` are optional injection points for observability
- **Implications**: TaskPlanningService treats `taskCompleted === true` as step success; any other termination condition triggers the failure recovery sequence.

### Existing Context Engine Interface

- **Context**: Understand how to delegate plan-generation prompt assembly to spec6.
- **Sources Consulted**: `.kiro/specs/context-engine/design.md`, `application/ports/agent-loop.ts` (IContextProvider)
- **Findings**:
  - `IContextProvider.buildContext(state: AgentState, toolSchemas)` assembles a full prompt string for the Agent Loop PLAN step
  - For plan generation (not a PLAN step), TaskPlanningService needs a distinct `buildPlanGenerationContext(goal, taskDescription, repositoryContext)` call — spec6 likely exposes this via `IContextEngine.buildContext()` with a step-type hint
  - The context-engine design specifies `IContextEngine` as the full port; `IContextProvider` is the narrower view used by agent-loop
- **Implications**: TaskPlanningService injects `IContextEngine` (the broader port, from spec6) rather than `IContextProvider`. This allows access to the full context assembly API including task-description and spec-layer injection.

### File Persistence Pattern

- **Context**: Understand the canonical file write pattern used in the codebase.
- **Sources Consulted**: `infra/memory/file-memory-store.ts`
- **Findings**:
  - All writes use `atomicWrite(destPath, content)`: write to `.tmp` sibling, `datasync`, then `rename`
  - Directory creation uses `mkdir({ recursive: true })` to ensure parent path exists
  - Failure records use timestamped filenames: `failure_{ts}_{taskId}.json`
- **Implications**: Plan files follow the same pattern: `task_{id}.json` written atomically; directory `.memory/tasks/` created on first write.

### Human Approval Gate Pattern

- **Context**: Determine how to pause execution for human review, consistent with existing safety patterns.
- **Sources Consulted**: `domain/workflow/approval-gate.ts`, `adapters/safety/approval-gateway.ts`, `application/safety/ports.ts`
- **Findings**:
  - The existing pattern defines an application-layer port (interface) that approval adapters implement
  - The agent-safety approval gateway is callback/promise-based: the service awaits a `Promise` that resolves when the human approves or rejects
  - CLI adapter can prompt interactively; CI adapter auto-approves or rejects based on policy
- **Implications**: TaskPlanningService injects an `IHumanReviewGateway` port (defined in `application/ports/task-planning.ts`). The gateway exposes `reviewPlan(plan, reason): Promise<PlanReviewDecision>`. The service awaits this promise; the adapter implementation determines actual interaction.

### Dependency Ordering Algorithm

- **Context**: Implement step dependency resolution without introducing external libraries.
- **Sources Consulted**: Architecture doc, requirements
- **Findings**:
  - The dependency graph is a DAG (directed acyclic graph) of step IDs connected via `dependsOn`
  - Topological sort (Kahn's algorithm) produces a valid execution order and detects cycles simultaneously
  - Kahn's algorithm is O(V+E), works on small plans (typically 5–20 steps) with negligible cost
  - No external library required; pure TypeScript implementation in domain layer
- **Implications**: `PlanValidator` in domain layer implements Kahn's algorithm for both circular dependency detection (Req 5.3) and execution order computation (Req 5.1).

---

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Clean/Hexagonal (selected) | Domain + Application + Infra layers matching existing structure | Consistent with all existing specs; no migration needed | Requires explicit port definitions | Only viable choice given project steering |
| Service-per-step | Each step type has its own service | Fine-grained isolation | Over-engineering for a single-step-type system | Rejected: all steps follow the same IAgentLoop invocation pattern |
| Event-sourced plan | Plan state reconstructed from event log | Full audit trail | Significant complexity increase for v1 | Deferred to future version; v1 uses mutable JSON snapshot |

---

## Design Decisions

### Decision: Plan generation uses LLM via IContextEngine, not direct LlmProviderPort

- **Context**: Plan generation requires assembling a rich prompt (goal, architecture docs, repository context) — the same responsibility as the Context Engine.
- **Alternatives Considered**:
  1. Call `LlmProviderPort.complete()` directly with a hand-built prompt string.
  2. Inject `IContextEngine` and use it to assemble the generation prompt.
- **Selected Approach**: Inject `IContextEngine` and call `buildContext()` with a plan-generation step type hint to get the prompt; pass the resulting context string to `LlmProviderPort.complete()`.
- **Rationale**: Avoids duplicating context assembly logic. Context Engine already handles token budgets, memory retrieval, spec layer injection — all needed for good plan quality.
- **Trade-offs**: Creates a dependency on spec6 at the application layer, but this is explicitly stated in the spec's dependency list.
- **Follow-up**: Verify that `IContextEngine.buildContext()` accepts a step-type hint that produces plan-generation-appropriate context in the spec6 implementation.

### Decision: Step-level IAgentLoop invocation (not task-level)

- **Context**: The agent loop operates on a single task string per run. Plan steps map 1:1 to agent loop invocations.
- **Alternatives Considered**:
  1. Invoke the agent loop once per `Task` (passing all steps as context).
  2. Invoke the agent loop once per `Step` (passing the step description as the task string).
- **Selected Approach**: One `IAgentLoop.run()` call per `Step`. The step's description is passed as the `task` string. The current plan context (goal, completed steps, next steps) is injected via `IContextEngine` before each step.
- **Rationale**: Step-level granularity enables precise status tracking, dependency enforcement, and per-step failure recovery. The agent loop is designed for bounded single-task execution.
- **Trade-offs**: More IAgentLoop invocations per plan. Acceptable given that each is independently recoverable.

### Decision: Persistence uses atomic JSON snapshots (not event log)

- **Context**: Plans must be resumable after crash. Two approaches: snapshot or event sourcing.
- **Alternatives Considered**:
  1. Append-only event log (plan created, step started, step completed, ...).
  2. Atomic JSON snapshot overwritten on every state change.
- **Selected Approach**: Atomic JSON snapshot at `.memory/tasks/task_{id}.json`, rewritten on every status change following the `atomicWrite` pattern from `FileMemoryStore`.
- **Rationale**: Simple to implement, easy to read by humans, consistent with existing memory persistence. Event sourcing adds complexity with no v1 benefit.
- **Trade-offs**: Snapshot can be lost if the process crashes mid-write (mitigated by temp+rename atomicity). No audit trail of intermediate states.

### Decision: Configurable step threshold for human approval gate (default: 10 steps)

- **Context**: Large or high-risk plans require human review before execution.
- **Alternatives Considered**:
  1. Fixed threshold hardcoded to a constant.
  2. Configurable threshold via `TaskPlannerOptions`.
- **Selected Approach**: Configurable `maxAutoApproveSteps` in `TaskPlannerOptions` with default 10. High-risk detection via a set of keyword-based heuristics on step descriptions (file deletion, force push, schema migration keywords).
- **Rationale**: Different deployment contexts have different risk tolerances. CI environments may set a higher threshold or disable the gate entirely.
- **Trade-offs**: Keyword heuristics for high-risk detection can produce false positives. Acceptable for v1; can be refined with a dedicated risk classifier in future versions.

### Decision: Dynamic plan adjustment uses LLM revision, not automatic step removal

- **Context**: When an Agent Loop observation reveals a step is no longer needed, the plan must adapt.
- **Selected Approach**: TaskPlanningService detects revision signals from `AgentLoopResult` observations (via `ReflectionOutput.planAdjustment === "revise"`), constructs a revision prompt, sends it to the LLM via the context engine, and applies the revised step list to the persisted plan.
- **Rationale**: LLM-driven revision preserves coherent plan semantics (new steps may be added, not just removed). Pure rule-based removal would miss additive revision scenarios.
- **Trade-offs**: Adds one LLM call per revision. Justified by the quality benefit of semantically coherent plan updates.

---

## Risks & Mitigations

- **Agent Loop non-termination** — An agent loop run may reach `MAX_ITERATIONS_REACHED` without completing the step. Mitigation: treat this as a step failure and enter the retry/recovery sequence with the iteration limit as context for the revised approach.
- **Large plan + human review timeout** — If the human review timeout expires and no response is received, the service halts. Mitigation: emit a clear `waiting-for-input` event and surface it in the CLI renderer; do not proceed autonomously.
- **Cascading step failures** — A failed step may cause all dependent steps to be blocked. Mitigation: PlanValidator's dependency graph is evaluated before and after each failure; if all remaining steps depend on the failed step, escalate immediately without retrying unblockable steps.
- **Circular dependency in user-supplied plans** — User-edited plan files may introduce cycles. Mitigation: PlanValidator runs on every load from disk, not just on generation; reject and report before any execution begins.
- **Context Engine unavailability** — If spec6 is not yet wired, plan generation fails. Mitigation: define a minimal fallback prompt builder (same pattern as agent-loop's `#buildFallbackContext`) that omits spec and memory layers. This ensures the system degrades gracefully.

---

## References

- `docs/architecture/task-planning-architecture.md` — Authoritative architecture description for spec7
- `docs/agent/dev-agent-v1-specs.md` — Dependency map and success criteria for spec7
- `orchestrator-ts/application/ports/agent-loop.ts` — IAgentLoop port interface (spec4)
- `orchestrator-ts/application/agent/agent-loop-service.ts` — AgentLoopService implementation (spec4)
- `orchestrator-ts/infra/memory/file-memory-store.ts` — Atomic file write pattern reference
- `orchestrator-ts/domain/workflow/approval-gate.ts` — Human approval gate domain pattern
