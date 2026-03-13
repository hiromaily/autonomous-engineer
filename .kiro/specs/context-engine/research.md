# Research & Design Decisions

---
**Purpose**: Capture discovery findings, architectural investigations, and rationale that inform the technical design.

**Usage**:
- Log research activities and outcomes during the discovery phase.
- Document design decision trade-offs that are too detailed for `design.md`.
- Provide references and evidence for future audits or reuse.
---

## Summary

- **Feature**: `context-engine`
- **Discovery Scope**: New Feature / Complex Integration (greenfield subsystem integrating into existing orchestrator-ts codebase)
- **Key Findings**:
  - The orchestrator-ts codebase uses a strict Clean/Hexagonal Architecture: domain → application ports → adapters. The Context Engine must follow this pattern — domain logic at the core, ports for memory and tool dependencies, adapters wrapping external calls.
  - No token counting or context management code exists in the current codebase. The `ClaudeProvider` uses the Anthropic SDK, which returns actual token counts in the response (`response.usage.input_tokens`). For pre-assembly estimation, `cl100k_base` (via `js-tiktoken`) provides a fast synchronous approximation; server-side counting via `client.messages.count_tokens()` is authoritative but incurs an extra API round-trip and is better suited for validation than tight inner-loop assembly.
  - The existing `LlmProviderPort` only exposes `complete()` and `clearContext()`. A new application port — `ContextEnginePort` — is required; the Context Engine does not extend the LLM port but sits alongside it as a separate domain service consumed by the agent loop (spec4) and implementation loop (spec9).

## Research Log

### Token Counting Strategy for Bun/TypeScript

- **Context**: The Context Engine must enforce per-layer token budgets. We need a fast, synchronous token estimation that works in Bun's runtime.
- **Sources Consulted**:
  - `@dqbd/tiktoken` (WASM bindings) — https://github.com/dqbd/tiktoken
  - `js-tiktoken` (pure JS) — npm package
  - Anthropic SDK `client.messages.count_tokens()` — server-side counting API
  - Anthropic response `usage.input_tokens` — actual tokens after a call
- **Findings**:
  - `js-tiktoken` is a pure JavaScript implementation of tiktoken, compatible with Bun without WASM complications.
  - Claude models use the `cl100k_base` encoding, the same as GPT-3.5/GPT-4.
  - Server-side `count_tokens` is the most accurate method but requires an API round-trip (latency, cost). Not suitable for tight assembly loops.
  - Client-side `cl100k_base` counting is fast (synchronous) and sufficient for budget enforcement. Minor discrepancies vs. server-side are acceptable for budget management (we add a safety buffer).
  - The Anthropic SDK already returns `usage.input_tokens` after each `complete()` call, providing post-hoc ground truth for observability.
- **Implications**: Use `js-tiktoken` with `cl100k_base` encoding for synchronous pre-assembly token estimation. Log actual token counts from API responses for observability. Add a configurable safety buffer (5–10%) to the total budget ceiling to account for estimator variance.

### Existing Codebase Integration Points

- **Context**: The Context Engine must integrate with memory, tool executor, and the workflow/agent loop without violating the layered architecture.
- **Sources Consulted**: Direct codebase analysis of `orchestrator-ts/`
- **Findings**:
  - `MemoryPort` (application port) provides `query(MemoryQuery)` → `MemoryQueryResult` with ranked entries. This is the correct entry point for memory retrieval layer population.
  - `IToolExecutor` (application layer) exposes `invoke(name, rawInput, context)`. The Context Engine will use this to call `git_status`, `read_file`, `search_files`, and `find_symbol_definition` tools when populating repository state and code context layers.
  - `WorkflowPhase` (domain type) and `WorkflowState` are already defined. The Context Engine's phase isolation maps directly onto these phase identifiers.
  - `PhaseRunner.onEnter()` already calls `llm.clearContext()` at each phase transition. The Context Engine's phase reset event should be triggered from this same lifecycle hook in the future (when agent-loop spec4 wires it in).
  - `ShortTermMemoryPort` is available for ephemeral per-session state (system instructions cache, file modification timestamps for cache invalidation).
  - The `ToolContext` type includes a `Logger` interface with `info()` and `error()`. The Context Engine's structured observability logs must conform to a new `ContextAssemblyLog` type rather than reusing `ToolInvocationLog`, since the log shape is different.
- **Implications**: The Context Engine belongs in `domain/context/` (core logic) + `application/ports/context.ts` (port interface) + `application/context/` (service orchestration). Adapters live in `adapters/context/` if external integrations need wrapping.

### Context Caching Strategy

- **Context**: Requirements mandate caching of system instructions and static steering documents across iterations within a session.
- **Sources Consulted**: Requirements 6.1–6.5; `infra/memory/short-term-store.ts`
- **Findings**:
  - The existing `ShortTermMemoryPort` stores simple key-value state (`recentFiles`, `currentPhase`, etc.). It is not designed for cached content blobs.
  - A dedicated in-process `ContextCache` value object (Map-based, keyed by source file path + mtime) is cleaner than overloading `ShortTermMemoryPort`.
  - Cache invalidation requires file modification time checks. The `stat()` filesystem call provides `mtime`. On cache hit, mtime is compared; if changed, the entry is evicted and re-fetched.
  - Cacheable layers: system instructions, steering documents (architecture, coding standards). Non-cacheable: tool results, repository state, memory retrieval.
- **Implications**: Implement `ContextCache` as an in-process, session-scoped Map. Key = absolute file path; value = `{ content, tokenCount, mtime, cachedAt }`. Expose cache hit/miss statistics as part of assembly output.

### Step-Type-Aware Planning

- **Context**: Requirements 2.2 require different retrieval behaviour for Exploration, Modification, and Validation step types.
- **Sources Consulted**: Requirements 2.1–2.5; `docs/architecture/context-engineering-architecture.md`; `docs/architecture/agent-loop-architecture.md`
- **Findings**:
  - The current `PhaseRunner` does not expose step types; step types are an agent-loop concept (spec4). The Context Engine must define a `StepType` discriminant that the agent loop provides at context request time.
  - Exploration steps: retrieve code context + repository state (broad discovery).
  - Modification steps: retrieve code context + active specification (focused edit).
  - Validation steps: retrieve tool results + active specification (verify against contract).
  - The planner's decisions must be returned as structured metadata for logging (Requirement 2.5).
- **Implications**: Define `StepType = "Exploration" | "Modification" | "Validation"` in the domain. `ContextPlanner` is a pure domain function (no I/O) that maps `(StepType, taskDescription, previousToolResults)` → `PlannerDecision` containing the set of layers to retrieve and query parameters per layer.

### Compression Strategies

- **Context**: Requirements 4.1–4.6 define layer-specific compression behaviour.
- **Sources Consulted**: `docs/architecture/context-engineering-architecture.md`; Requirements 4.1–4.6
- **Findings**:
  - Three compression strategies are required:
    1. **Document summarization** (specification layer): Extract headings + key decisions + acceptance criteria. Implemented as a text-processing function (regex/string manipulation) — no LLM call required for this level of extraction; the structure of markdown spec documents is predictable.
    2. **Code skeleton extraction** (code context layer): Strip function bodies, retain signatures, class definitions, and interface declarations. TypeScript AST parsing via `ts-morph` or `typescript` compiler API could be used; alternatively, regex-based extraction is simpler and sufficient for budget-trimming purposes.
    3. **Memory score filtering** (memory layer): Drop entries below a relevance score threshold. The `MemoryQueryResult` already includes `relevanceScore` per entry.
  - The specification layer compression must never strip acceptance criteria (Req 4.2).
  - Compression must not be applied to system instructions or task description layers (Req 4.6).
- **Implications**: Define a `CompressionStrategy` discriminated union and a `LayerCompressor` domain interface. Each layer type has a registered compressor. The compressor receives `(content: string, budget: number)` and returns `{ compressed: string, tokenCount: number, technique: string }`. Use regex-based extraction for simplicity; no external AST library dependency for v1.

### Iterative Expansion Constraints

- **Context**: Requirements 5.1–5.5 describe mid-iteration context expansion.
- **Sources Consulted**: Requirements 5.1–5.5
- **Findings**:
  - Expansion is only permitted for code context, specification, and memory retrieval layers.
  - A configurable `maxExpansionsPerIteration` guard prevents unbounded growth.
  - Each expansion event must re-run budget checks and potentially compress the affected layer.
  - The expansion request carries a `resourceId` (file path or memory query) and a `targetLayer` discriminant.
- **Implications**: `ContextAccumulator` (domain entity) tracks expansion events per iteration and enforces the max-expansion invariant. The `buildContext()` method is called after each expansion to re-assemble and re-check budgets.

---

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Domain service in `domain/context/` | Pure domain logic: ContextPlanner, TokenBudgetManager, LayerCompressor, ContextAccumulator | Aligns with existing Clean/Hexagonal Architecture; fully testable without I/O | Requires wiring through application ports | Preferred — consistent with steering |
| Fat application service | All logic in `application/context/context-engine-service.ts` | Simpler initial structure | Mixes domain logic with orchestration; harder to unit test | Rejected — violates architecture boundary |
| Middleware pipeline | Context assembly as a composable middleware chain (similar to Express middleware) | Flexible composition | Adds abstraction overhead not needed for a deterministic 7-layer system | Rejected — over-engineered for this use case |

---

## Design Decisions

### Decision: Token Counting Library

- **Context**: The Context Engine must count tokens for every context layer before and after assembly. The system runs on Bun.
- **Alternatives Considered**:
  1. `js-tiktoken` (pure JS, `cl100k_base`) — synchronous, no WASM dependency
  2. `@dqbd/tiktoken` (WASM) — full parity with Python tiktoken; more accurate
  3. Anthropic server-side `count_tokens` API — most accurate; requires API call
  4. Character-based approximation (divide by ~4) — no dependency; very imprecise
- **Selected Approach**: `js-tiktoken` with `cl100k_base` encoding + 5% safety buffer on total budget ceiling. Post-hoc actual counts from `response.usage.input_tokens` logged for observability.
- **Rationale**: Pure JS avoids WASM loading issues in Bun. `cl100k_base` is accurate for Claude models. Server-side counting adds latency and cost not acceptable in the inner loop.
- **Trade-offs**: Minor discrepancy (±3%) vs. server-side counts. Mitigated by safety buffer.
- **Follow-up**: Verify `js-tiktoken` WASM-free bundle works correctly in Bun v1.3.10+ during implementation.

### Decision: Cache Invalidation Mechanism

- **Context**: Steering files and system instructions can change between sessions but are stable within a session. The cache must detect changes.
- **Alternatives Considered**:
  1. File modification time (mtime) comparison — lightweight, no hashing
  2. Content hash (SHA-256) — accurate change detection
  3. Session-scoped immutable cache (never invalidate mid-session) — simplest; misses hot reloads
- **Selected Approach**: mtime comparison on each cache lookup. If mtime differs from cached mtime, evict and re-fetch.
- **Rationale**: mtime is available via `stat()` without reading the file. Fast O(1) check. Sufficient for session-scoped use where files rarely change.
- **Trade-offs**: Mtime can change without content change (e.g., `touch`). Acceptable false-positive eviction cost is low (one extra file read).
- **Follow-up**: Consider content-hash invalidation if false-positive eviction becomes a measurable overhead.

### Decision: Compression via Text Extraction (No LLM)

- **Context**: Over-budget layers must be compressed. Using the LLM to summarize would add latency and cost inside the context assembly path.
- **Alternatives Considered**:
  1. LLM-based summarization — highest quality, flexible
  2. Regex/string extraction — fast, deterministic, no extra API cost
  3. AST-based code skeleton extraction (ts-morph) — precise for TypeScript
- **Selected Approach**: Regex/string extraction for v1 across all layers.
  - Spec layer: extract headings (`#`, `##`), acceptance criteria lines (regex on `- ` bullets under `### Acceptance Criteria`).
  - Code layer: extract function/class/interface/type signature lines (regex on `export`, `function`, `class`, `interface`, `type`, `const`).
  - Memory layer: score-threshold filter on pre-ranked entries (no text transformation needed).
- **Rationale**: Zero additional dependencies, deterministic, fast. Quality is adequate for v1 token budget management. LLM-based compression can be added in v2 if quality proves insufficient.
- **Trade-offs**: Regex extraction is brittle for non-standard formatting. Mitigated by always falling back to truncation if extraction produces invalid results.
- **Follow-up**: Track compressed-vs-actual token savings in observability logs. If savings are poor, upgrade to ts-morph AST extraction for code layer.

### Decision: ContextEngine as Domain Service with Application Orchestrator

- **Context**: The Context Engine has both pure domain logic (planning, budgeting, compression) and I/O orchestration (file reads, tool invocations, memory queries). These must be separated.
- **Alternatives Considered**:
  1. Single domain service with injected port interfaces — standard Hexagonal pattern
  2. CQRS-style separate read/write paths — overkill for this subsystem
- **Selected Approach**: Domain layer holds pure logic (`ContextPlanner`, `TokenBudgetManager`, `LayerCompressor`, `ContextAccumulator`). Application layer holds `ContextEngineService` which orchestrates I/O through `MemoryPort`, `IToolExecutor`, and filesystem access. The application port `IContextEngine` is the interface consumed by the agent loop.
- **Rationale**: Matches existing architecture pattern. Domain logic is fully unit-testable without mocks.
- **Trade-offs**: Requires wiring through dependency injection at composition root. No significant downside given existing DI pattern in the codebase.

---

## Risks & Mitigations

- **Risk**: `js-tiktoken` token count diverges from Anthropic's actual count by more than the 5% safety buffer, causing context window overflows. — Mitigation: log actual token counts from each API response; add automated alerting when estimated vs. actual diverges by >10%.
- **Risk**: Regex-based code extraction strips semantically important lines (e.g., decorators, multi-line type definitions). — Mitigation: the compressor falls back to truncation when extraction reduces content below a minimum useful threshold. Track quality in observability logs.
- **Risk**: Phase isolation logic in the Context Engine diverges from `PhaseRunner.onEnter()` lifecycle hook timing. — Mitigation: the Context Engine exposes an explicit `resetPhase(phaseId)` method; `PhaseRunner.onEnter()` is extended (in spec4/spec9) to call this method, ensuring a single reset trigger.
- **Risk**: ContextCache grows without bound during a long session if many unique steering files are loaded. — Mitigation: cache is bounded to 50 entries (configurable); LRU eviction on overflow.

---

## References

- [Anthropic SDK — token usage fields](https://docs.anthropic.com/en/api/messages) — `response.usage.input_tokens` provides post-call ground truth
- [js-tiktoken npm package](https://www.npmjs.com/package/js-tiktoken) — pure JS BPE tokenizer; `cl100k_base` encoding for Claude
- [Context Engineering Architecture doc](../../../docs/architecture/context-engineering-architecture.md) — architectural intent for the context pipeline
- [dev-agent-v1-specs.md](../../../docs/agent/dev-agent-v1-specs.md) — dependency order: spec6 depends on spec2 (tool-system) + spec5 (memory-system)
- [Clean Architecture / Hexagonal Architecture](https://alistair.cockburn.us/hexagonal-architecture/) — steering principle for dependency direction
