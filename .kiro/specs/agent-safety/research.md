# Research & Design Decisions

---
**Purpose**: Capture discovery findings, architectural investigations, and rationale that inform the technical design.

---

## Summary

- **Feature**: `agent-safety`
- **Discovery Scope**: Extension (existing tool-system from spec2 is implemented; agent-safety wraps it)
- **Key Findings**:
  - The existing `ToolExecutor` in `application/tools/executor.ts` is the single entry point for all tool invocations — the Decorator pattern (`SafetyGuardedToolExecutor`) integrates cleanly without modifying existing code.
  - `filesystem.ts` already implements `resolveWorkspacePath()` (path traversal guard), but workspace isolation is currently scattered per-tool; agent-safety centralizes it into a dedicated guard applied at the executor level.
  - No safety checks beyond permission flags and schema validation exist today — all 12 requirements introduce genuinely new behavior.

---

## Research Log

### Existing Tool Execution Pipeline

- **Context**: Need to understand where safety checks slot in relative to existing executor logic.
- **Sources Consulted**: `application/tools/executor.ts`, `domain/tools/types.ts`, `domain/tools/permissions.ts`
- **Findings**:
  - `ToolExecutor.invoke()` runs 6 steps: registry lookup → permission check → input schema validation → execute with timeout → output schema validation → log.
  - `ToolContext` already carries `workspaceRoot`, `permissions`, `memory`, `logger`.
  - `ToolInvocationLog` in `Logger` captures invocation data but is ephemeral (in-memory); no append-only persistent audit log exists.
  - The existing permission system (`PermissionSystem`) only checks capability flags, not semantic safety policies (workspace isolation, protected files, etc.).
- **Implications**: Safety checks must run *before* `ToolExecutor.invoke()`. The decorator wraps the full invocation and adds its own audit trail on top of the existing logger.

### Workspace Isolation — Existing vs. Centralized

- **Context**: `filesystem.ts` has `resolveWorkspacePath()` inline; git, shell, and code-analysis tools do not apply it.
- **Sources Consulted**: `adapters/tools/filesystem.ts`, `adapters/tools/git.ts`, `adapters/tools/shell.ts`
- **Findings**:
  - Git tools use `context.workingDirectory` (not validated against workspace root).
  - Shell tools run commands in `context.workingDirectory` with no boundary check.
  - Only filesystem tools call `resolveWorkspacePath()`.
- **Implications**: `WorkspaceIsolationGuard` must intercept all tools, not just filesystem tools. Centralization in the safety guard pipeline fixes the coverage gap.

### Sandboxing Approach

- **Context**: Requirement 5 mandates isolated execution for `run_test_suite` and `install_dependencies`.
- **Findings**:
  - Container-based sandboxing (Docker/OCI) provides the strongest isolation but requires Docker daemon availability and adds startup latency.
  - Restricted-shell sandboxing (using Bun's subprocess with limited capabilities) is lighter but less portable.
  - Temp-directory isolation (run in a fresh temp dir, cleaned up after) protects the workspace from writes but does not restrict process capabilities.
  - For v1, temp-directory isolation is the practical minimum; container support is optional and operator-configured.
- **Implications**: `ISandboxExecutor` must support all three methods behind a configurable `sandboxMethod` field. Default: `'temp-directory'`.

### Audit Log Storage

- **Context**: Requirement 10 mandates immutable, append-only storage.
- **Findings**:
  - Append-only NDJSON file (one JSON object per line) is the simplest approach: no dependencies, human-readable, easily post-processed.
  - SQLite would support queries but adds a dependency and write-lock contention risk.
  - In-memory with flush on stop risks data loss on crash.
- **Implications**: NDJSON file at configurable path (default: `.aes/audit.ndjson`). The `IAuditLogger` port abstracts the storage; the default adapter uses NDJSON file append.

### Human Approval Interface

- **Context**: Requirement 11 requires async approval with timeout.
- **Findings**:
  - CLI prompt (stdin readline) works for interactive use but blocks the process.
  - Webhook callback is more robust for CI/automated environments.
  - For v1, CLI prompt is the default; the `IApprovalGateway` port allows adapter substitution.
- **Implications**: `IApprovalGateway` is a clean port; CLI and webhook are two adapter implementations.

---

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| **Decorator** | `SafetyGuardedToolExecutor` wraps `IToolExecutor`; same interface, safety pipeline added before delegation | No changes to existing executor; independently testable; clean separation | Requires `SafetyContext` to extend `ToolContext` | **Selected** |
| Full Replacement | Replace `ToolExecutor` with a new class combining safety + execution | Single class, no delegation | Breaks existing tests; tightly couples safety to execution pipeline | Rejected |
| Pre-processor hook | Hook registered in `ToolExecutor` pre-execution | No new class needed | Violates single responsibility; adds coupling to executor | Rejected |
| Per-tool guard injection | Each tool adapter checks safety inline | No central coordinator | Scattered logic; impossible to enforce ordering; duplication | Rejected |

---

## Design Decisions

### Decision: Centralize workspace isolation in `WorkspaceIsolationGuard` rather than per-tool

- **Context**: `resolveWorkspacePath()` in `filesystem.ts` only covers filesystem tools; git and shell tools have no boundary enforcement.
- **Alternatives Considered**:
  1. Add `resolveWorkspacePath()` calls to each tool adapter individually.
  2. Centralize in `WorkspaceIsolationGuard` at the safety executor level.
- **Selected Approach**: Centralize in the safety guard pipeline; `filesystem.ts`'s `resolveWorkspacePath()` remains as a tool-level defense-in-depth check but the primary enforcement moves to the safety layer.
- **Rationale**: Ensures consistent enforcement regardless of which tool is invoked; prevents new tools from accidentally bypassing the check.
- **Trade-offs**: Safety guard must understand which input fields carry file paths per tool type (parametric check). Mitigation: guards inspect tool name and input structure, not raw bytes.
- **Follow-up**: Document path-field extraction logic per tool category in implementation.

### Decision: `SafetySession` as first-class object passed into `SafetyContext`

- **Context**: Iteration count, failure signatures, and rate counters are stateful across tool invocations within a session.
- **Alternatives Considered**:
  1. Store session state in `ToolContext` (extend existing interface).
  2. Pass a new `SafetySession` object via a new `SafetyContext` interface.
  3. Store state in the `SafetyGuardedToolExecutor` instance.
- **Selected Approach**: `SafetyContext extends ToolContext` and adds `session: SafetySession`. One session per agent run.
- **Rationale**: Keeps state explicit and injectable (testable). Avoids cluttering `ToolContext` with safety-specific fields.
- **Trade-offs**: Callers must create and pass a `SafetySession`; slight API surface increase.

### Decision: AuditEntry includes `sessionId` and `iterationNumber` from `SafetySession`

- **Context**: Requirement 10.5 mandates session and iteration traceability in every log entry.
- **Selected Approach**: `SafetySession` exposes `sessionId` and `iterationCount`; `SafetyGuardedToolExecutor` reads these when building each `AuditEntry`.
- **Trade-offs**: Audit log is tightly coupled to session concept; acceptable since sessions are the primary unit of agent execution.

### Decision: Safety guard ordering

- **Context**: Req 2.5 (filesystem guardrails after workspace checks), Req 8.5 (destructive action before sandbox and rate-limit).
- **Selected Order**: EmergencyStop → IterationLimit → FailureDetection → WorkspaceIsolation → FilesystemGuard → GitSafety → ShellRestriction → DestructiveAction (→ Approval) → RateLimit → SandboxExecution → ToolExecutor
- **Rationale**: Session-level checks (stop, limits, paused state) gate first. Path-based checks (workspace, protected files) apply before semantic checks (git, shell). Destructive detection runs before rate limiting per requirement.

---

## Risks & Mitigations

- **Path-field extraction complexity**: Guards need to know which fields in a tool's input are file paths. Mitigation: define a `PathExtractor` map keyed by tool name; document the contract.
- **Approval gateway blocking the event loop**: Async stdin readline may block on interactive approval. Mitigation: use async readline with `AbortController`-based timeout.
- **Audit log write failure**: If the audit log file is unavailable, the system should not silently skip logging. Mitigation: audit write errors are surfaced as warnings; emergency stop writes are retried once.
- **Sandboxing startup latency**: Container-based sandbox adds per-invocation latency. Mitigation: sandbox method is configurable; default to temp-directory for low overhead.
- **Failure signature collision**: Two different errors with similar messages may collide on the same signature. Mitigation: signature = `toolName + ':' + errorType + ':' + message.slice(0, 120)` (bounded length).

---

## References

- `orchestrator-ts/application/tools/executor.ts` — existing tool execution pipeline
- `orchestrator-ts/domain/tools/types.ts` — `ToolError`, `ToolContext`, `Tool<I,O>`, `Logger` interfaces
- `orchestrator-ts/adapters/tools/filesystem.ts` — existing `resolveWorkspacePath()` utility
- `docs/architecture/agent-safety-architecture.md` — architecture reference for spec3
- `docs/agent/dev-agent-v1-specs.md` — spec3 sub-component definitions
