# Research & Design Decisions

---
**Purpose**: Capture discovery findings, architectural investigations, and rationale that inform the technical design for the self-healing-loop (spec10).

**Usage**:
- Log research activities and outcomes during the discovery phase.
- Document design decision trade-offs that are too detailed for `design.md`.
- Provide references and evidence for future audits or reuse.
---

## Summary

- **Feature**: `self-healing-loop`
- **Discovery Scope**: Extension — extending spec9 (implementation-loop) with autonomous failure analysis and rule-update capabilities; integrated with spec5 (memory-system).
- **Key Findings**:
  - The `ISelfHealingLoop` port is already declared in `orchestrator-ts/src/application/ports/implementation-loop.ts` with a single `escalate(escalation: SectionEscalation): Promise<SelfHealingResult>` method. The service simply needs to implement this existing contract.
  - `SectionEscalation` and `SelfHealingResult` domain types are already defined in `orchestrator-ts/src/domain/implementation-loop/types.ts`. No new domain types are required for the integration interface.
  - The `MemoryPort` in `orchestrator-ts/src/application/ports/memory.ts` already exposes `writeFailure(record: FailureRecord)` and `getFailures(filter?)` and uses `KnowledgeMemoryFile` (`coding_rules`, `review_rules`, `implementation_patterns`, `debugging_patterns`) as the target files for rule updates. The `MemoryWriteTrigger` enum includes `"self_healing"`.
  - `FailureRecord` in `memory.ts` tracks `taskId`, `specName`, `phase`, `attempted`, `errors`, `rootCause`, `ruleUpdate`, and `timestamp`. The self-healing service will use this existing type (extended as `SelfHealingFailureRecord`) for persistence.
  - `LlmProviderPort` in `orchestrator-ts/src/application/ports/llm.ts` provides a typed, non-throwing `complete(prompt, options?)` method returning `LlmResult` (discriminated union). Analysis and gap-identification steps will use this port directly.
  - `IContextEngine` in `orchestrator-ts/src/application/ports/context.ts` is already the context isolation abstraction; `resetTask(sectionId)` is the hook the implementation loop calls before retrying after a resolved self-healing outcome.
  - `ImplementationLoopService.#escalateSection()` already handles the `ISelfHealingLoop` call, reads `healingResult.outcome`, and constructs `buildHealedImprovePrompt()` from `healingResult.summary` and `healingResult.updatedRules`. No changes are required in the implementation-loop service.

## Research Log

### Integration Point: `ISelfHealingLoop` Port

- **Context**: spec9 already references spec10 via the `ISelfHealingLoop` port, but the implementation class does not yet exist.
- **Sources Consulted**: `orchestrator-ts/src/application/ports/implementation-loop.ts`, `orchestrator-ts/src/application/implementation-loop/implementation-loop-service.ts`
- **Findings**:
  - Port is defined at lines 227–235 of `implementation-loop.ts`.
  - `ImplementationLoopService.#escalateSection()` calls `options.selfHealingLoop.escalate(escalation)` inside a try/catch. A thrown exception is caught and treated as unresolvable failure.
  - `buildHealedImprovePrompt()` at lines 725–742 of `implementation-loop-service.ts` constructs the retry prompt from `healingResult.summary` and `healingResult.updatedRules`. The self-healing service must populate both fields on a `"resolved"` outcome.
  - The retry counter reset and `contextEngine.resetTask(sectionId)` call for `"resolved"` outcomes are handled inside `#executeSection()`. Requirement 6.3 is already satisfied by spec9 code.
- **Implications**: `SelfHealingLoopService` is a new class in `orchestrator-ts/src/application/self-healing-loop/` that implements `ISelfHealingLoop`. No changes to existing spec9 files are needed.

### Existing Domain Types: `SectionEscalation`, `SelfHealingResult`

- **Context**: Confirm whether new domain types are needed.
- **Sources Consulted**: `orchestrator-ts/src/domain/implementation-loop/types.ts`
- **Findings**:
  - `SectionEscalation` already contains `sectionId`, `planId`, `retryHistory`, `reviewFeedback`, and `agentObservations` — exactly what requirements 1.3 and 2.1 mandate.
  - `SelfHealingResult` already has `outcome: SelfHealingOutcome`, `updatedRules?: ReadonlyArray<string>`, and `summary: string`.
  - New domain types required: `RootCauseAnalysis`, `GapReport`, `SelfHealingLogEntry`, and `SelfHealingFailureRecord` (for the internal domain model and persistence).
- **Implications**: New types go into a new file `orchestrator-ts/src/domain/self-healing/types.ts`.

### Memory-System Integration

- **Context**: Requirements 3, 4, and 5 depend on memory-system (spec5) for reading rule files, writing rule updates, and persisting failure records.
- **Sources Consulted**: `orchestrator-ts/src/application/ports/memory.ts`
- **Findings**:
  - `KnowledgeMemoryFile` targets match requirements exactly: `coding_rules`, `review_rules`, `implementation_patterns`.
  - `MemoryPort.append()` and `MemoryPort.update()` provide add/correct semantics for rule file updates.
  - `MemoryPort.writeFailure()` handles failure record persistence via the memory system port, satisfying requirement 5.4.
  - `MemoryPort.getFailures(filter?)` supports duplicate-gap detection (requirement 3.4) by allowing lookup of prior failure records for the same `sectionId`.
  - `MemoryWriteTrigger.self_healing` is already present, confirming first-class support.
- **Implications**: No new memory ports are needed. `SelfHealingLoopService` will accept `MemoryPort` as a constructor dependency and use `append`, `update`, `writeFailure`, and `getFailures` directly.

### LLM Provider Integration

- **Context**: Requirements 2 and 3 require structured LLM calls for root-cause analysis and gap identification.
- **Sources Consulted**: `orchestrator-ts/src/application/ports/llm.ts`
- **Findings**:
  - `LlmProviderPort.complete(prompt, options?)` returns `LlmResult` (discriminated union); never throws.
  - Structured output will be achieved via prompt engineering (JSON block requested in system prompt) with a parsing step. No tool-use or function-calling API is assumed.
  - Retry logic for LLM failures (requirement 2.3: `maxAnalysisRetries`) must be implemented inside `SelfHealingLoopService`.
- **Implications**: `SelfHealingLoopService` accepts `LlmProviderPort` and implements internal retry with timeout using `Promise.race` and `AbortSignal` semantics (via a timeout wrapper, since `LlmProviderPort` does not expose abort).

### Logging and NDJSON

- **Context**: Requirement 8 mandates NDJSON logging to `.aes/logs/self-healing-<planId>.ndjson`.
- **Sources Consulted**: `orchestrator-ts/src/application/ports/implementation-loop.ts` (`IImplementationLoopLogger`)
- **Findings**:
  - The existing logger pattern writes NDJSON via a port injected as an option. The self-healing loop will follow the same pattern: accept an optional `ISelfHealingLoopLogger` port.
  - If logger is absent, log entries are silently dropped (requirement 8.3).
- **Implications**: Define `ISelfHealingLoopLogger` with a single `log(entry: SelfHealingLogEntry): void` method.

### Concurrency / Duplicate Escalation

- **Context**: Requirement 1.4 requires detecting concurrent escalations for the same `sectionId`.
- **Sources Consulted**: `orchestrator-ts/src/application/implementation-loop/implementation-loop-service.ts`
- **Findings**:
  - `ImplementationLoopService` is single-threaded (sequential section loop). In normal operation, at most one escalation per sectionId runs at a time.
  - However, the port contract must be safe. A `Set<string>` of in-flight sectionIds in `SelfHealingLoopService` is sufficient.
- **Implications**: `SelfHealingLoopService` maintains `#inFlightSections: Set<string>`. On entry: check for duplicate, add to set. On exit (finally): remove from set.

### Workspace Boundary Safety

- **Context**: Requirement 4.5 prohibits writing outside the workspace root.
- **Sources Consulted**: Memory port file path resolution conventions.
- **Findings**:
  - The `MemoryPort` already abstracts file paths; resolved paths come from the memory adapter, not from the self-healing service directly.
  - However, the `SelfHealingLoopService` must validate that any path returned by `MemoryPort` (and placed into `updatedRules`) remains within the configured workspace root before returning them to the caller.
- **Implications**: A `workspaceRoot` parameter is added to `SelfHealingLoopConfig`. Path validation is performed after rule file update.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Direct implementation of `ISelfHealingLoop` | New `SelfHealingLoopService` class in `application/self-healing-loop/` | Minimal changes to existing code; clean dependency boundary | None | Preferred: aligns with existing pattern in spec9 |
| Decorator over `ImplementationLoopService` | Wrap existing loop with healing logic | Could intercept inline | Blurs responsibility; harder to test in isolation | Rejected: requirements mandate a distinct port |
| Strategy pattern (pluggable analyzers) | Separate analyzer and executor strategies | Highly flexible | Over-engineered for current requirements scope | Deferred: could evolve in future versions |

**Selected**: Direct implementation of `ISelfHealingLoop` as `SelfHealingLoopService`, with internal collaborators (`FailureAnalyzer`, `GapIdentifier`, `RuleUpdater`) as private methods rather than separate injectable classes — this avoids premature abstraction while keeping the service unit-testable via mocked `LlmProviderPort` and `MemoryPort`.

## Design Decisions

### Decision: Internal vs. Externalized Sub-components

- **Context**: The requirements describe Failure Analyzer, Gap Identifier, Rule Updater, and Learning Engine as conceptually distinct steps. Should these be separate injectable services or private methods?
- **Alternatives Considered**:
  1. Separate injectable classes for each step — maximum testability and SRP purity.
  2. Private methods on `SelfHealingLoopService` — simpler wiring, sufficient testability via port mocks.
- **Selected Approach**: Private methods. The LLM port and memory port mocks cover all observable behavior; the internal step boundaries are implementation details.
- **Rationale**: The analysis steps share state (the escalation context, the LLM conversation). Externalizing them would require passing this state object around, adding accidental complexity without test benefit.
- **Trade-offs**: Slightly less granular SRP; offset by simpler dependency graph.
- **Follow-up**: If future requirements add pluggable analysis strategies, refactor to strategy pattern at that time.

### Decision: Timeout Implementation

- **Context**: Requirements 1.5 (`selfHealingTimeoutMs`) and 2.5 (`analysisTimeoutMs`) mandate timeouts.
- **Alternatives Considered**:
  1. `AbortController` + timeout — requires LLM port to accept a signal (it does not currently).
  2. `Promise.race` with a rejection timer — works with any async operation.
- **Selected Approach**: `Promise.race([operation, rejectAfter(ms)])` utility, resolving to an `unresolved` result on timeout.
- **Rationale**: Non-invasive; no changes needed to `LlmProviderPort`.
- **Trade-offs**: LLM call continues in background after timeout; the result is discarded. Acceptable given the 2-minute outer timeout.

### Decision: `SelfHealingFailureRecord` Shape

- **Context**: Requirement 5 specifies a richer failure record than the existing `FailureRecord` in `memory.ts`. Should the self-healing service extend `FailureRecord` or define its own type?
- **Alternatives Considered**:
  1. Extend existing `FailureRecord` — reuse `writeFailure()`; minimal changes.
  2. Define a separate `SelfHealingFailureRecord` in the self-healing domain, map to `FailureRecord` before writing — clean domain isolation.
- **Selected Approach**: Define `SelfHealingFailureRecord` as an internal domain type and map to `FailureRecord` when calling `MemoryPort.writeFailure()`. Fields `sectionId`, `planId`, `outcome`, `gapIdentified`, `ruleFilesUpdated`, and `truncated` are tracked internally.
- **Rationale**: `FailureRecord` uses `taskId`/`specName`/`phase` which map naturally from `sectionId`/`planId`/`"implementation"`. The mapping is a one-liner; no new memory port method is needed.
- **Trade-offs**: Slight impedance mismatch on field names; mitigated by explicit mapping function.

### Decision: Rule File Writing via `MemoryPort`

- **Context**: Requirement 4 mandates writing to `rules/coding_rules.md` etc. Requirement 4.4 says do not write directly to filesystem. The `MemoryPort` uses `KnowledgeMemoryFile` enum targets (`coding_rules`, `review_rules`, `implementation_patterns`).
- **Alternatives Considered**:
  1. Use `MemoryPort.append()` for new rules and `MemoryPort.update()` for corrections — fully abstracted.
  2. Write directly to filesystem with path from config — simpler but violates requirement 5.4.
- **Selected Approach**: Option 1. The gap report includes a `targetFile: KnowledgeMemoryFile` field that maps directly to the `MemoryTarget`.
- **Rationale**: Satisfies requirements 4.1, 4.3, 4.4, and 4.5 without any new ports.
- **Trade-offs**: Machine-readable HTML comment marker (requirement 4.2) must be embedded in the `MemoryEntry.description` field since `MemoryPort` does not expose raw file append.

## Risks & Mitigations

- **LLM produces non-parseable JSON** — Mitigated by retry logic (`maxAnalysisRetries`; default 2) and explicit structured prompts with JSON schema in system message.
- **Infinite self-healing cycles** — Mitigated by requirement 3.4 (duplicate gap detection via `MemoryPort.getFailures()`) and requirement 6.4 (implementation loop does not call `escalate()` again after a resolved self-healing).
- **Gap report maps to unsupported rule file** — Mitigated by requirement 3.3: return `unresolved` if target file is not in the supported set.
- **Workspace boundary violation** — Mitigated by requirement 4.5: validate resolved paths against `workspaceRoot` before including in `updatedRules`.
- **Memory write failure** — Mitigated by requirement 5.3: log the error but do not change the already-determined outcome.
- **Self-healing loop throws** — Already handled by spec9's `#escalateSection()` try/catch; `SelfHealingLoopService` must not throw on any code path (return `unresolved` instead).

## References

- `orchestrator-ts/src/application/ports/implementation-loop.ts` — `ISelfHealingLoop`, `SectionEscalation`, `SelfHealingResult` port definitions
- `orchestrator-ts/src/application/implementation-loop/implementation-loop-service.ts` — `#escalateSection()` and `buildHealedImprovePrompt()` integration hooks
- `orchestrator-ts/src/domain/implementation-loop/types.ts` — Shared domain types for the escalation value objects
- `orchestrator-ts/src/application/ports/memory.ts` — `MemoryPort`, `FailureRecord`, `KnowledgeMemoryFile`, `MemoryWriteTrigger`
- `orchestrator-ts/src/application/ports/llm.ts` — `LlmProviderPort`, `LlmResult`
- `orchestrator-ts/src/application/ports/context.ts` — `IContextEngine.resetTask()`
- `.kiro/specs/self-healing-loop/requirements.md` — Full requirements with 8 requirement groups
