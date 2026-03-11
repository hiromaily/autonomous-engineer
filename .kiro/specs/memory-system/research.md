# Research & Design Decisions

---
**Purpose**: Capture discovery findings, architectural investigations, and rationale that inform the technical design.

---

## Summary

- **Feature**: `memory-system`
- **Discovery Scope**: Complex Integration (new subsystem extending orchestrator-core)
- **Key Findings**:
  - All existing ports follow the same hexagonal pattern: interface in `application/ports/`, implementation in `infra/`; memory system must match exactly.
  - `WorkflowStateStore.persist()` already demonstrates the correct atomic write pattern (temp file + `rename`); `FileMemoryStore` should reuse the same approach.
  - Short-term memory requires no disk I/O and is conceptually distinct from persistent memory; clean separation via `ShortTermMemoryPort` prevents interface bloat.

---

## Research Log

### Existing Port Patterns in orchestrator-ts

- **Context**: Memory port must integrate with `RunSpecUseCase` and downstream specs (spec4 agent-loop, spec6 context-engine) without architectural drift.
- **Sources Consulted**: `application/ports/llm.ts`, `application/ports/workflow.ts`, `application/ports/config.ts`, `application/usecases/run-spec.ts`
- **Findings**:
  - All ports are pure TypeScript interfaces with no runtime dependencies.
  - Error envelopes follow a discriminated union: `{ ok: true; value: T } | { ok: false; error: E }` (see `LlmResult`).
  - Infrastructure classes receive a `cwd: string` parameter for testability (see `WorkflowStateStore` constructor).
  - `RunSpecUseCase` uses constructor injection via a `deps` object — memory port can be added to this object without breaking the existing signature.
  - All interface fields are `readonly`; no mutable public properties anywhere.
- **Implications**: `MemoryPort` and `ShortTermMemoryPort` must use the same discriminated union error envelope, readonly fields, and `cwd`-based testability.

### `rules/` Directory Location

- **Context**: The architecture doc shows `rules/` at the repo root (alongside `.memory/`), but the TypeScript implementation lives in `orchestrator-ts/`. The working directory of the `aes` CLI can differ.
- **Findings**:
  - `WorkflowStateStore` resolves paths with `join(this.cwd, ...)` where `cwd = process.cwd()` by default.
  - The `aes` CLI is intended to be run from the repo root (as shown in steering `tech.md` common commands: `cd orchestrator-ts && bun run aes`).
  - The architecture doc explicitly shows both `.memory/` and `rules/` at the repo root level.
  - Making base directory configurable (Req 7.4) resolves the location ambiguity for tests.
- **Implications**: `FileMemoryStore` resolves paths using a configurable `baseDir` that defaults to `process.cwd()`, which should be the repo root. Both `.memory/` and `rules/` are created relative to `baseDir`.

### Short-Term Memory Scope

- **Context**: Req 1 requires an in-process store with no disk I/O; it serves the agent-loop (spec4) and context-engine (spec6).
- **Findings**:
  - `WorkflowState` already persists phase and status, but lacks ephemeral working context (recent file list, task-level progress details).
  - Short-term memory is reset at workflow start (Req 1.4) and discarded on end (Req 1.2) — a simple typed object suffices.
  - A separate `ShortTermMemoryPort` prevents polluting the persistent `MemoryPort` with synchronous in-process methods.
- **Implications**: Define `ShortTermMemoryPort` as a separate interface; `MemoryPort` composes it via a `shortTerm` property. The `InProcessShortTermStore` implementation requires no async methods.

### Keyword-Based Retrieval for v1

- **Context**: Req 5 requires ranked retrieval; the architecture doc notes vector/semantic search as a future optimization.
- **Findings**:
  - v1 memory files are small Markdown documents; full file scans are feasible.
  - Term-frequency scoring (count of query token hits in title + body) is sufficient for v1 without additional dependencies.
  - Entry titles are the primary discriminator for deduplication (Req 6.2).
  - Returning `relevanceScore: number` in results allows callers (context-engine) to budget tokens by truncating low-score entries.
- **Implications**: `FileMemoryStore.query()` scans memory files, parses entries by Markdown heading, computes TF scores, and returns top-N results. No external search libraries needed in v1.

### Failure Record Storage Format

- **Context**: Req 4.2 specifies `.memory/failures/failure_{timestamp}_{task_id}.json`.
- **Findings**:
  - JSON format allows structured querying by field (specName, taskId) without parsing Markdown.
  - Atomic write (temp + rename) still applies to prevent partial writes on crash.
  - Listing failures requires a directory scan; the port exposes this as `getFailures(filter?)` to keep callers from direct file I/O.
- **Implications**: `FailureRecord` is a JSON-serializable TypeScript interface. `FileMemoryStore.getFailures()` reads `.memory/failures/`, parses JSON, and filters in-memory.

---

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Single `MemoryPort` (all-in-one) | One interface covering short-term + persistent + retrieval | Simple DI surface | Mixes sync/async; short-term methods pollute persistent interface | Rejected: interface bloat |
| Two-port split (`ShortTermMemoryPort` + `MemoryPort`) | Short-term stays synchronous; persistent port is async | Clean separation, aligns with IO vs in-process distinction | Two injection points for callers | **Selected**: composited as `MemoryPort.shortTerm` to minimize DI changes |
| Separate services (MemoryReader + MemoryWriter) | Split read and write surfaces | ISP-aligned | More interfaces to wire up; no clear benefit at v1 scope | Deferred to v2 if scale demands |

---

## Design Decisions

### Decision: Compose `ShortTermMemoryPort` inside `MemoryPort`

- **Context**: Req 7.1 specifies a single `MemoryPort`; Req 1 requires an in-process store distinct from file I/O.
- **Alternatives Considered**:
  1. One interface with both sync and async methods — breaks method consistency.
  2. Completely separate injection points — increases `RunSpecUseCase` constructor complexity.
- **Selected Approach**: `MemoryPort` includes a `readonly shortTerm: ShortTermMemoryPort` property. Callers access short-term memory as `memory.shortTerm.read()` and persistent memory as `memory.query(...)`.
- **Rationale**: Single injection point for `RunSpecUseCase` while keeping sync/async boundaries clean.
- **Trade-offs**: Slightly unusual composition pattern, but aligns with how `WorkflowEngine` composes multiple sub-components.
- **Follow-up**: Verify that spec4 (agent-loop) and spec6 (context-engine) can use this composed interface cleanly.

### Decision: Title-based Deduplication

- **Context**: Req 6.2 requires deduplication before appending but leaves "equivalence" undefined.
- **Alternatives Considered**:
  1. Content hash — robust but complex; hash changes on whitespace edits.
  2. First 100 chars — fragile.
  3. Entry title exact match — simple, stable, and meaningful.
- **Selected Approach**: Duplicate detection uses case-insensitive title match against existing entries in the target file.
- **Rationale**: Titles are the canonical identifier for memory entries; they are mandatory (Req 6.3) and human-readable.
- **Trade-offs**: Does not detect semantically identical entries with different titles. Acceptable for v1.
- **Follow-up**: If false-negative duplicates become a problem, add content-similarity scoring in a later iteration.

### Decision: `baseDir` defaulting to `process.cwd()`

- **Context**: Req 7.4 requires a configurable base directory for tests; CLI is run from repo root.
- **Selected Approach**: `FileMemoryStore(baseDir: string = process.cwd())` — constructor parameter with default, identical to `WorkflowStateStore(cwd: string = process.cwd())`.
- **Rationale**: Consistent with existing infrastructure pattern; tests pass a temp directory; production uses repo root.
- **Trade-offs**: None significant.

---

## Risks & Mitigations

- **Race condition on concurrent writes**: Multiple workflow phases writing simultaneously could corrupt Markdown files. Mitigation: atomic write (temp + rename) eliminates partial-write corruption; full concurrency locking deferred to v2 (single-process v1 makes true concurrency unlikely).
- **Memory file growth**: Append-only policy with no pruning could bloat files over many sessions. Mitigation: deduplication (Req 6.2) limits growth; manual pruning via Git history is always possible; automated compaction deferred to v2.
- **Short-term memory type drift**: `ShortTermState` shape must remain stable as spec4/spec6 add new fields. Mitigation: use `Partial<ShortTermState>` on writes; define `ShortTermState` with explicit optional fields rather than a generic Map.
- **Failure record directory missing**: If `.memory/failures/` doesn't exist on first write, the write will fail. Mitigation: `mkdir({ recursive: true })` before any failure write, same as `WorkflowStateStore`.

---

## References

- `docs/memory/memory-architecture.md` — Memory layer definitions and design goals
- `docs/agent/dev-agent-v1-specs.md` (spec5 section) — Scope, sub-components, and success criteria
- `orchestrator-ts/infra/state/workflow-state-store.ts` — Atomic write and `cwd`-based path pattern to replicate
- `orchestrator-ts/application/ports/llm.ts` — Discriminated union error envelope pattern to replicate
