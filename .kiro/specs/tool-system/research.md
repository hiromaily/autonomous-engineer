# Research & Design Decisions

---
**Purpose**: Capture discovery findings, architectural investigations, and rationale that inform the technical design.

---

## Summary
- **Feature**: `tool-system`
- **Discovery Scope**: New Feature (greenfield, complex)
- **Key Findings**:
  - No tool layer exists in `orchestrator-ts/`; this is a pure greenfield implementation within an already-established Clean Architecture codebase.
  - The existing codebase uses a discriminated union `Result` pattern (`{ ok: true; value: T } | { ok: false; error: E }`) for all error handling, most clearly in `application/ports/llm.ts` (`LlmResult`). The tool system must follow the same pattern.
  - `zod` (v3.25) is already a dependency. It can validate at runtime and act as a schema source, but the architecture specification calls for JSON Schema (`schema.input`, `schema.output`). The recommended approach is to use **ajv v8** for JSON Schema runtime validation and keep zod for other validation concerns (e.g., config loading), avoiding conflation.

## Research Log

### Existing Architecture Patterns
- **Context**: Need to ensure tool-system layers fit the existing directory and dependency structure.
- **Sources Consulted**: `orchestrator-ts/` directory tree, `application/ports/llm.ts`, `adapters/llm/claude-provider.ts`, `domain/workflow/types.ts`, `application/ports/workflow.ts`
- **Findings**:
  - Domain layer (`domain/`) holds pure types and business logic with no external dependencies.
  - Application ports (`application/ports/`) define interfaces consumed by use cases.
  - Adapters (`adapters/`) implement ports and interact with external systems.
  - The `{ ok: true; value: T } | { ok: false; error: E }` result type is used consistently (LlmResult).
  - `zod` is used for validation; `citty` for CLI; `@anthropic-ai/sdk` for the LLM adapter.
- **Implications**:
  - Tool types and registry belong in `domain/tools/`.
  - `ToolExecutor` belongs in the application layer as an orchestrator.
  - Concrete tool implementations (filesystem, git, shell, code analysis, knowledge) are adapters.

### JSON Schema Validation Library
- **Context**: The Tool interface requires `schema.input` and `schema.output` as JSON Schema objects for runtime input/output validation.
- **Sources Consulted**: Architecture doc (`tool-system-architecture.md`), existing package.json
- **Findings**:
  - `zod` is already installed but its native validation works against zod schemas, not raw JSON Schema.
  - `ajv` (v8) is the industry-standard JSON Schema validator: supports JSON Schema Draft-07, draft-2019-09, and draft-2020-12; actively maintained; <50 KB gzipped; used broadly in the TypeScript ecosystem.
  - `ajv` integrates cleanly with TypeScript via `ajv` + `@types/json-schema`.
  - Alternative `typebox` provides TypeScript-first schema definitions that emit JSON Schema, but introduces a new DSL and dependency not needed for this use case.
- **Implications**:
  - Add `ajv` as a production dependency in `orchestrator-ts/package.json`.
  - The `ToolExecutor` uses `ajv` internally for schema compilation and validation; this is an implementation detail not exposed through public interfaces.

### Timeout Handling Strategy
- **Context**: Req 3.3 requires per-tool timeout declaration with a global default.
- **Findings**:
  - Bun supports `AbortController` and `AbortSignal` natively for async operation cancellation.
  - A `Promise.race([toolExecution, timeoutPromise])` pattern with `AbortSignal` is the standard approach.
  - Per-tool `timeoutMs?: number` on the `Tool` interface, with a `defaultTimeoutMs` on `ToolExecutor` configuration, is the cleanest contract.
- **Implications**:
  - `Tool<I, O>` interface includes `readonly timeoutMs?: number`.
  - `ToolExecutor` config includes `readonly defaultTimeoutMs: number`.
  - The executor selects `tool.timeoutMs ?? config.defaultTimeoutMs` for each invocation.

### MemoryClient and Logger as Forward-Reference Ports
- **Context**: `ToolContext` references `MemoryClient` and `Logger`, but the memory system (spec5) is not yet implemented.
- **Findings**:
  - The tool-system spec must define minimal port interfaces for `MemoryClient` and `Logger` to avoid blocking on spec5.
  - The memory system adapter will later implement `MemoryClient`; the existing event-bus logging infrastructure can implement `Logger`.
- **Implications**:
  - Define `MemoryClient` and `Logger` as minimal interfaces in `domain/tools/types.ts`.
  - These will be fulfilled by spec5 (MemoryClient) and the existing orchestrator infra (Logger).

### Permission Model: Immutability and Mode Profiles
- **Context**: Req 4.5 mandates that the execution mode is fixed at startup and cannot be escalated at runtime.
- **Findings**:
  - Using `Object.freeze()` on mode permission profiles prevents accidental mutation.
  - Wrapping `PermissionSet` in a readonly type ensures TypeScript enforces immutability at the boundary.
  - The four execution modes (ReadOnly, Dev, CI, Full) map directly to fixed `PermissionSet` values — stored as a `const` lookup map.
- **Implications**:
  - `ExecutionMode` is a discriminated union type.
  - Mode-to-PermissionSet resolution happens at startup and is not re-evaluated during a session.

### Path Traversal Prevention (Workspace Isolation)
- **Context**: Req 5.5 requires all filesystem tools to reject paths outside `workspaceRoot`.
- **Findings**:
  - Node.js `path.resolve()` combined with `String.prototype.startsWith()` check on the resolved path against `workspaceRoot` is the standard approach.
  - Bun exposes the same `node:path` module.
  - This check should be implemented in a shared utility used by all filesystem tools, not duplicated per tool.
- **Implications**:
  - A shared `resolveWorkspacePath(workspaceRoot, requestedPath): string` utility validates paths and throws a permission error for traversal attempts.
  - This utility is internal to the filesystem adapter directory.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Clean/Hexagonal (selected) | Domain types + app-layer executor + adapter implementations | Matches existing codebase; testable core; adapters are replaceable | More files and abstractions than a flat approach | Only viable choice given existing structure.md mandates |
| Flat module (rejected) | All tool logic in a single `tools/` folder | Simpler file structure | Violates dependency inversion; would create circular deps with higher-level specs | Incompatible with existing architecture |
| Plugin-style (deferred) | Tools loaded dynamically from external packages | Extensible; supports third-party tools | Requires a plugin host and discovery mechanism; out of v1 scope | Could be added in v1.x |

## Design Decisions

### Decision: `ToolResult<T>` as discriminated union
- **Context**: Need a consistent, type-safe error return from tool execution without exceptions.
- **Alternatives Considered**:
  1. Throw `ToolError` exceptions — callers must use try/catch; less visible in types.
  2. Return `ToolResult<T>` discriminated union — mirrors existing `LlmResult` pattern.
- **Selected Approach**: `type ToolResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ToolError }`
- **Rationale**: Consistent with existing codebase pattern; TypeScript narrows the type correctly; forces callers to handle both branches.
- **Trade-offs**: Slightly more verbose call sites, but errors are impossible to ignore.

### Decision: ajv for JSON Schema runtime validation
- **Context**: Tools expose JSON Schema for input/output; need runtime validation in executor.
- **Alternatives Considered**:
  1. `zod` — already installed but validates zod schemas, not raw JSON Schema.
  2. `ajv` — industry standard for JSON Schema validation.
  3. `@sinclair/typebox` — TypeScript-first with JSON Schema output.
- **Selected Approach**: `ajv` v8 for runtime validation in `ToolExecutor`.
- **Rationale**: JSON Schema is the specified contract format; ajv is purpose-built for this; no new DSL introduced.
- **Trade-offs**: Adds one dependency; ajv v8 requires explicit configuration for draft-07 compatibility.

### Decision: ToolExecutor in application layer
- **Context**: Executor orchestrates registry lookup, permission checking, schema validation, and execution.
- **Alternatives Considered**:
  1. In domain layer — keeps it close to the Tool interface but domain should be dependency-free.
  2. In application layer — orchestrator role matches application layer responsibility.
- **Selected Approach**: `ToolExecutor` as a class in `application/tools/executor.ts`.
- **Rationale**: The executor depends on ajv (external lib) and may depend on the event bus for logging; these are application-layer concerns.
- **Trade-offs**: Adds one file to the application layer; minimal.

### Decision: Tool categories as adapter modules
- **Context**: Five tool categories (filesystem, git, shell, code-analysis, knowledge) need to interact with external systems.
- **Selected Approach**: Each category lives in `adapters/tools/<category>/` and exports individual tool factory functions.
- **Rationale**: Adapter layer is the correct home for external system interaction; each category can be tested and replaced independently.
- **Trade-offs**: More directories; but each adapter is focused and independently testable.

## Risks & Mitigations
- **ajv version compatibility with Bun** — ajv v8 works in Node.js ESM; Bun compatibility should be confirmed in CI on first test run. Mitigation: pin ajv version; use `import type` guards.
- **MemoryClient stub becoming a permanent placeholder** — if spec5 is delayed, tests may rely on the stub long-term. Mitigation: clearly mark `MemoryClient` as a forward-reference port in comments; ensure spec5 implements the exact interface.
- **Shell tool security surface** — `run_command` gives the agent arbitrary shell access within the `shellExecution` permission. Mitigation: spec3 (agent-safety) adds allowlist/blocklist on top; this spec focuses only on the permission flag check.
- **Code analysis tool performance on large repos** — AST parsing TypeScript files on every invocation may be slow. Mitigation: out of scope for v1; spec11 (codebase-intelligence) adds indexing. Document as a known limitation.

## References
- `orchestrator-ts/application/ports/llm.ts` — existing Result pattern reference
- `docs/architecture/tool-system-architecture.md` — primary architecture specification
- `docs/agent/dev-agent-v1-specs.md` (spec2 section) — scope definition and success criteria
- ajv v8 documentation: https://ajv.js.org/
