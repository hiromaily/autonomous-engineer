# Research & Design Decisions

---
**Purpose**: Capture discovery findings, architectural investigations, and rationale that inform the technical design.

---

## Summary

- **Feature**: `git-integration`
- **Discovery Scope**: Complex Integration
- **Key Findings**:
  - The codebase already has six git CLI tools (`git_status`, `git_diff`, `git_commit`, `git_branch_list`, `git_branch_create`, `git_branch_switch`) in `adapters/tools/git.ts`; two new tools (`git_add`, `git_push`) are required.
  - The existing hexagonal / clean architecture (Domain → Application Ports → Adapters → Infra) is the mandated pattern; all PR-hosting SDK dependencies must stay in the adapter layer.
  - GitHub REST API (no external SDK needed for simple create/update) and a future GitLab adapter share the same `IPullRequestProvider` port, allowing provider substitution without core changes.

---

## Research Log

### Existing Git Tool Coverage

- **Context**: Requirements 2 and 3 involve staging all changed files and pushing to a remote; neither `git_add` nor `git_push` exists today.
- **Sources Consulted**: `orchestrator-ts/adapters/tools/git.ts`
- **Findings**:
  - `git_commit` commits only currently staged changes, so a preceding `git_add` step is required.
  - `git_push` with non-fast-forward detection (checking stderr for `[rejected]`) is absent.
- **Implications**: Two new tool definitions are added to `adapters/tools/git.ts` following the existing `Tool<Input, Output>` pattern. Protected-pattern filtering logic belongs in `GitControllerAdapter` (adapter layer), not in the tool itself.

### Permission System

- **Context**: Requirement 6.4 mandates that `gitWrite` must be `true` for write operations; `networkAccess` must be `true` for PR creation (HTTP calls to GitHub/GitLab).
- **Sources Consulted**: `domain/tools/permissions.ts`, `domain/tools/types.ts`
- **Findings**:
  - `PermissionFlag` already includes `gitWrite` and `networkAccess`.
  - `PermissionSystem.checkPermissions()` returns `{ granted, missingFlags }` and is called automatically by `ToolExecutor`.
  - The `Full` execution mode is the only profile where both flags are `true`.
- **Implications**: `git_add` and `git_push` must list `requiredPermissions: ["gitWrite"]`; the GitHub/GitLab HTTP adapter needs `networkAccess` enforcement at the `IPullRequestProvider` call site.

### Tool-System Integration Pattern

- **Context**: Requirement 5.4 mandates that the service uses the tool-system's git tools for all local git CLI operations rather than calling `child_process` directly.
- **Sources Consulted**: `application/tools/executor.ts`, `adapters/tools/git.ts`
- **Findings**:
  - `IToolExecutor.invoke(name, rawInput, context)` handles permission checks, schema validation, timeouts, and structured logging.
  - `GitControllerAdapter` must hold an `IToolExecutor` dependency and call `invoke` for each git operation.
- **Implications**: The adapter layer is the only caller of `IToolExecutor`; the domain and application layers never import tool implementations.

### Event Bus Pattern

- **Context**: Requirements 1.6, 2.4, 2.6–2.8, 3.2, 3.4–3.5, 4.4, 4.6, 6.5 all specify named events to be emitted.
- **Sources Consulted**: `application/ports/workflow.ts`, `infra/events/workflow-event-bus.ts`
- **Findings**:
  - `IWorkflowEventBus` uses a typed discriminated union (`WorkflowEvent`) and synchronous `emit`.
  - A parallel `IGitEventBus` with a `GitEvent` discriminated union follows the same structural pattern without coupling to the workflow domain.
- **Implications**: Define `GitEvent` union in `domain/git/types.ts`; define `IGitEventBus` in `application/ports/git-controller.ts`; provide a concrete `GitEventBus` in `infra/events/`.

### LLM Integration for Commit Messages and PR Descriptions

- **Context**: Requirements 2.2 and 4.2 require LLM-generated commit messages and PR descriptions.
- **Sources Consulted**: `application/ports/llm.ts`
- **Findings**:
  - `LlmProviderPort.complete(prompt)` returns `LlmResult`; never throws.
  - The prompt includes git diff or task metadata as context.
- **Implications**: `GitIntegrationService` receives `LlmProviderPort` via constructor injection; prompt engineering is application-layer logic.

### GitHub REST API for Pull Request Creation

- **Context**: Requirement 4.1 specifies GitHub and GitLab as primary providers; requirement 4.5 requires updating existing PRs.
- **Sources Consulted**: GitHub REST API documentation (repos/{owner}/{repo}/pulls), GitLab MR documentation
- **Findings**:
  - `POST /repos/{owner}/{repo}/pulls` creates a PR; returns 422 if branch already has an open PR.
  - `GET /repos/{owner}/{repo}/pulls?head={branch}` checks for existing PRs; `PATCH /repos/{owner}/{repo}/pulls/{number}` updates an existing one.
  - Authentication: `Authorization: Bearer <token>` header; 401 on auth failure.
  - Draft PRs: supported via `"draft": true` in the request body.
  - GitLab uses `POST /projects/{id}/merge_requests` with a `draft` title prefix for draft MRs.
- **Implications**: `GitHubPrAdapter` and `GitLabPrAdapter` implement the same `IPullRequestProvider` port. No third-party SDK required; native `fetch` (available in Bun) suffices. Auth errors map to the `pr-creation-auth-failed` event.

### Branch Name Validation

- **Context**: Requirement 6.6 mandates validation against Git ref-name rules before branch creation.
- **Sources Consulted**: `git-check-ref-format` documentation (man page), git source
- **Findings**:
  - Invalid characters include: space, `~`, `^`, `:`, `?`, `*`, `[`, `\`, `..`, `@{`, control chars.
  - Branch names cannot start/end with `.` or `/` or end with `.lock`.
- **Implications**: A `GitValidator.isValidBranchName(name: string): boolean` method in `domain/git/git-validator.ts` enforces these rules without invoking any external process.

### Audit Logging Integration

- **Context**: Requirement 6.2 requires an audit log entry for every git operation.
- **Sources Consulted**: `application/safety/ports.ts` (`IAuditLogger`, `AuditEntry`)
- **Implications**: `GitIntegrationService` writes to `IAuditLogger` before and after each operation; the `AuditEntry.toolName` field records the git operation type.

---

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Hexagonal (selected) | `IGitController` port in app layer, `GitControllerAdapter` in adapter layer | Consistent with steering; testable; provider-agnostic | Slightly more boilerplate | Mandatory per project steering |
| Direct CLI in service | Call `child_process` from `GitIntegrationService` | Simpler | Violates hexagonal boundary; untestable; violates req 5.5 | Rejected |
| Single mega-adapter | One class for both local git and PR APIs | Fewer files | Mixes CLI and HTTP concerns; hard to replace either independently | Rejected |

---

## Design Decisions

### Decision: Separate `IGitController` and `IPullRequestProvider` ports

- **Context**: Local git CLI operations and remote PR API calls are distinct concerns with different failure modes and providers.
- **Alternatives Considered**:
  1. Single `IGitController` port covering both local and remote operations.
  2. Two separate ports: `IGitController` for local git, `IPullRequestProvider` for hosting API.
- **Selected Approach**: Two separate ports.
- **Rationale**: Allows independent substitution of git CLI adapter and PR hosting provider; aligns with Interface Segregation Principle; enables GitLab adapter without touching the core git controller.
- **Trade-offs**: One additional injection point in `GitIntegrationService`.

### Decision: New `git_add` and `git_push` tools in existing `adapters/tools/git.ts`

- **Context**: Requirement 5.4 mandates the tool system for all local git operations.
- **Alternatives Considered**:
  1. Add raw `child_process` calls inside `GitControllerAdapter`.
  2. Extend `adapters/tools/git.ts` with two new tool definitions.
- **Selected Approach**: Extend `adapters/tools/git.ts` with `git_add` (staged file listing + protected filter) and `git_push` (with non-fast-forward detection).
- **Rationale**: Consistent with existing pattern; benefits from tool executor's permission checks, timeouts, and logging automatically.
- **Trade-offs**: `git_add` takes a file list parameter; the protected-pattern filter runs in `GitControllerAdapter` before the tool call.

### Decision: `GitEvent` as a standalone discriminated union

- **Context**: Requirements specify 11 distinct named events; these are git-specific and not part of `WorkflowEvent`.
- **Alternatives Considered**:
  1. Extend `WorkflowEvent` union.
  2. Define a separate `GitEvent` union with its own bus.
- **Selected Approach**: Separate `GitEvent` discriminated union and `IGitEventBus`.
- **Rationale**: Avoids polluting the workflow event bus with git-specific events; allows subscribers to listen only to git events.
- **Trade-offs**: Separate bus to wire up in composition root.

### Decision: Retry counter and operation-failure tracking in `GitIntegrationService`

- **Context**: Requirement 6.5 requires pausing after three identical consecutive failures.
- **Selected Approach**: `GitIntegrationService` tracks `Map<string, number>` of `operationType → consecutiveFailureCount`.
- **Rationale**: Retry state is transient session state, not infrastructure state; keeping it in the service keeps domain logic self-contained.
- **Trade-offs**: Counter resets on service restart; acceptable for the current single-session model.

---

## Risks & Mitigations

- **Protected branch list uses glob patterns** (e.g., `release/*`) — Mitigation: implement minimatch-style glob matching in `GitValidator`.
- **GitHub API rate limiting** on high-frequency PR updates — Mitigation: cache PR number after first creation; `PATCH` on subsequent calls avoids duplicate `POST`.
- **Branch name collision loop** if many branches share a prefix — Mitigation: cap suffix at 99; return error if all suffixes exhausted.
- **Large diff context for LLM prompt** — Mitigation: truncate diff to configurable `maxDiffTokens` before building LLM prompt; log a warning.
- **Workspace isolation (req 6.1)** relies on path prefix check — Mitigation: `GitValidator.isWithinWorkspace(path, workspaceRoot)` normalizes with `path.resolve` before prefix comparison to prevent traversal.

---

## References

- Git ref-name validation rules: https://git-scm.com/docs/git-check-ref-format
- GitHub REST API — Pull Requests: https://docs.github.com/en/rest/pulls/pulls
- GitLab REST API — Merge Requests: https://docs.gitlab.com/ee/api/merge_requests.html
- Existing port patterns: `orchestrator-ts/application/ports/workflow.ts`, `orchestrator-ts/application/ports/llm.ts`
- Existing git tools: `orchestrator-ts/adapters/tools/git.ts`
