# Implementation Plan

- [x] 1. Implement domain types and pure validation logic
- [x] 1.1 (P) Define all Git domain value types, result types, event union, and configuration
  - Define `GitIntegrationConfig` with all configuration fields (baseBranch, remote, maxFilesPerCommit, maxDiffTokens, protectedBranches, protectedFilePatterns, forcePushEnabled, workspaceRoot, isDraft)
  - Define result types: `GitChangesResult`, `BranchCreationResult`, `CommitResult`, `PushResult`, `PullRequestResult`, `PullRequestParams`
  - Define `GitEvent` as an exhaustive 11-variant discriminated union with `type` discriminant and `timestamp: string` on every variant
  - All types must use `Readonly<>` and `ReadonlyArray<>` to prevent accidental mutation
  - No I/O or mutable state permitted in this file
  - _Requirements: 1.1, 1.2, 1.3, 1.6, 2.1, 2.3, 2.4, 2.6, 2.7, 2.8, 3.2, 3.4, 3.5, 4.4, 4.6, 6.5_

- [x] 1.2 (P) Implement pure branch name and file path validation logic
  - Implement `IGitValidator` interface with four methods: `isValidBranchName`, `matchesProtectedPattern`, `isWithinWorkspace`, `filterProtectedFiles`
  - `isValidBranchName` must reject names containing `~`, `^`, `:`, `?`, `*`, `[`, `\`, `..`, `@{`, control characters, and names starting/ending with `.` or `/` or ending with `.lock`
  - `matchesProtectedPattern` must support glob-style patterns including `release/*` without external libraries
  - `isWithinWorkspace` must use `path.resolve` normalization to prevent path traversal bypasses; precondition: `workspaceRoot` must be an absolute path
  - `filterProtectedFiles` returns `{ safe, blocked }` split from the input file list
  - All methods must be pure functions with no I/O or side effects
  - _Requirements: 1.3, 6.1, 6.6_

- [x] 2. Define application port interfaces
- [x] 2.1 (P) Define the IGitController port and IGitEventBus
  - Define `GitResult<T>` discriminated union: `{ ok: true; value: T }` | `{ ok: false; error: ToolError }`
  - Define `IGitController` interface in `application/ports/git-controller.ts`: `listBranches`, `detectChanges`, `createAndCheckoutBranch`, `stageAndCommit`, `push`
  - Document preconditions for each method (clean working directory before `createAndCheckoutBranch`, non-empty files before `stageAndCommit`, all within workspaceRoot)
  - Define `IGitEventBus` interface in its own file `application/ports/git-event-bus.ts`: `emit`, `on`, `off` with `GitEvent` as the typed payload
  - No implementation code — interface definitions only
  - _Requirements: 1.6, 2.4, 2.6, 2.7, 2.8, 3.2, 3.4, 3.5, 4.4, 4.6, 5.1, 5.2, 5.4, 6.5_

- [x] 2.2 (P) Define the IPullRequestProvider port
  - Define `PrErrorCategory` union type: `"auth" | "conflict" | "network" | "api"`
  - Define `PrError` interface with `category`, `message`, and optional `statusCode`
  - Define `PrResult` discriminated union: `{ ok: true; value: PullRequestResult }` | `{ ok: false; error: PrError }`
  - Define `IPullRequestProvider` interface with `createOrUpdate(params: PullRequestParams): Promise<PrResult>`
  - Document postconditions: on success returns PR URL; on HTTP 401 `error.category === "auth"`
  - No implementation code — interface definitions only
  - _Requirements: 4.1, 4.4, 4.5, 4.7, 5.3_

- [x] 3. Extend git tool definitions with git_add and git_push
  - Add `git_add` tool definition to existing `adapters/tools/git.ts` following the established `Tool<Input, Output>` pattern
  - `git_add` input: `{ files: ReadonlyArray<string> }` (relative paths from workingDirectory); output: `{ staged: ReadonlyArray<string> }`;  requiredPermissions: `["gitWrite"]`; executes `git add -- <files...>`
  - Add `git_push` tool definition: input `{ remote: string; branch: string }`; output `{ remote: string; branch: string }`; requiredPermissions: `["gitWrite"]`; executes `git push <remote> <branch>` — never adds `--force` flag
  - Both tools use the existing `runGit` helper pattern and `GitError` for non-zero exit codes
  - Non-fast-forward push failure causes non-zero exit; `ToolExecutor` returns `{ ok: false, error: { type: "runtime", message: "..." } }` — the raw stderr is carried in the message
  - _Requirements: 2.5, 3.1, 5.4_

- [x] 4. Implement the GitControllerAdapter
  - Implement `IGitController` by delegating every local git operation to `IToolExecutor.invoke`; never call `child_process` or git SDKs directly
  - `detectChanges`: invoke `git_status` and `git_diff`; return `GitChangesResult` with staged, unstaged, untracked arrays
  - `listBranches`: invoke `git_branch_list`; return array of branch name strings
  - `createAndCheckoutBranch`: invoke `git_branch_create` then `git_branch_switch`; map errors to `GitResult`
  - `stageAndCommit`: call `IGitValidator.filterProtectedFiles` first; if any blocked files are present return `{ ok: false }` with a `protected-file-detected` error; invoke `git_add` for safe files then `git_commit`; return `CommitResult` with hash, message, fileCount
  - `push`: invoke `git_push`; if tool returns `{ ok: false }` inspect `error.message.includes("[rejected]")` to classify as non-fast-forward; map HTTP 403/permission errors to `ToolError { type: "permission" }`
  - Respect `PermissionSet.gitWrite`: return `ToolError { type: "permission" }` for any write operation when `gitWrite` is `false`
  - _Requirements: 1.4, 1.5, 2.5, 2.7, 3.1, 3.4, 5.2, 5.4, 5.5, 6.3, 6.4_

- [x] 5. Implement the GitIntegrationService
- [x] 5.1 Implement feature branch creation with collision resolution
  - Derive candidate branch name as `agent/<specName>` or `agent/<taskSlug>`
  - Call `IGitValidator.isValidBranchName` on the candidate; reject with error if invalid
  - Call `IGitController.detectChanges`; return `Err(dirty-working-directory)` if staged, unstaged, or untracked files are found
  - Call `IGitController.listBranches`; if name conflicts, append numeric suffix `-2` through `-99` and re-validate; emit conflict resolution info
  - Call `IGitController.createAndCheckoutBranch(name, baseBranch)`; on success emit `branch-created` event and write audit entry
  - Track consecutive failure count for `"create-branch"` operation; reset to 0 on success
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 6.2, 6.5_

- [x] 5.2 Implement commit automation with LLM message generation
  - Call `IGitController.detectChanges`; if no changes emit `no-changes-to-commit` and return `Ok(skipped)`
  - Call `IGitValidator.filterProtectedFiles` on all changed files; if any blocked files exist emit `protected-file-detected` and return `Err`
  - Validate file count against `config.maxFilesPerCommit`; if exceeded emit `commit-size-limit-exceeded` and return `Err` — this check must occur before the LLM call
  - Truncate diff to `config.maxDiffTokens` before constructing the LLM prompt; invoke `LlmProviderPort.complete` with the commit message prompt template (including specName and taskTitle)
  - Truncate the generated subject line to 72 characters; call `IGitController.stageAndCommit(safeFiles, message)`
  - On success emit `commit-created` event and write audit entry; track consecutive failure count for `"commit"`
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 6.2, 6.5_

- [x] 5.3 Implement push with protected-branch and force-push enforcement
  - Before calling the adapter, call `IGitValidator.matchesProtectedPattern(branchName, config.protectedBranches)`; if matched emit `protected-branch-push-rejected` and return `Err`
  - Check `config.forcePushEnabled`; force push is prohibited by default — the `git_push` tool never adds `--force`
  - Call `IGitController.push(branchName, remote)`; if adapter returns non-fast-forward error emit `push-rejected-non-fast-forward` and return `Err`
  - On success emit `branch-pushed` event and write audit entry; track consecutive failure count for `"push"`
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 6.2, 6.5_

- [x] 5.4 Implement PR creation/update with LLM content generation
  - Verify `permissions.networkAccess` is `true`; return `ToolError { type: "permission" }` if false
  - Invoke `LlmProviderPort.complete` with the PR body prompt template (specName, completedTasks, specArtifactPath, commitMessages); parse JSON response for `{ title, body }`; cap title at 72 characters
  - Populate `PullRequestParams` including spec name, artifact link, completed task summary, and implementation overview
  - Call `IPullRequestProvider.createOrUpdate(params)`; on `PrError { category: "auth" }` emit `pr-creation-auth-failed` with guidance; on success emit `pull-request-created` event and write audit entry
  - Set `isDraft` flag in params based on `GitWorkflowParams.isDraft`
  - Track consecutive failure count for `"create-pr"`; reset to 0 on success
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 6.2, 6.5_

- [x] 5.5 Implement consecutive-failure escalation and the full-workflow orchestration method
  - After each operation's failure path: increment `consecutiveFailureCounts.get(operationType)`; when count reaches 3 emit `repeated-git-failure` event with operation name and attempt count, then return `Err` — do not reset count until next success
  - Implement `runFullWorkflow(params)`: execute `createBranch → generateAndCommit → push → createOrUpdatePullRequest` in sequence; halt and return the first `Err` encountered; on all four stages completing successfully return `Ok(PullRequestResult)`
  - Inject all seven dependencies via constructor: `IGitController`, `IPullRequestProvider`, `LlmProviderPort`, `IGitEventBus`, `IAuditLogger`, `IGitValidator`, `GitIntegrationConfig`
  - _Requirements: 6.5_

- [x] 6. Implement the GitHubPrAdapter
  - Implement `IPullRequestProvider` using native `fetch` (Bun built-in); no third-party GitHub SDK
  - Constructor accepts `GitHubPrAdapterConfig`: `apiBaseUrl`, `owner`, `repo`, `token`; token must never appear in logs, audit entries, or events
  - `createOrUpdate`: first check for an existing open PR via `GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=open`; if found use `PATCH /repos/{owner}/{repo}/pulls/{number}` to update; if not found use `POST /repos/{owner}/{repo}/pulls` to create
  - Set `draft: true` in the create payload when `params.isDraft` is true
  - Map HTTP 401 response to `PrResult { ok: false, error: { category: "auth", statusCode: 401, message: "..." } }`
  - Cap title at 72 characters before submission; include required fields: `title`, `body`, `head`, `base`, `draft`
  - _Requirements: 4.1, 4.4, 4.5, 4.7, 5.3_

- [x] 7. Implement the in-process git event bus infrastructure
  - Implement `IGitEventBus` as a synchronous in-process event bus; handlers invoked in registration order
  - Support multiple handlers via `on(handler)` / `off(handler)`; `emit(event)` calls all registered handlers synchronously
  - The implementation resides at `infra/events/git-event-bus.ts` and mirrors the `IWorkflowEventBus` pattern established in `infra/events/workflow-event-bus.ts`
  - _Requirements: 1.6, 2.4, 2.6, 2.7, 2.8, 3.2, 3.4, 3.5, 4.4, 4.6, 6.5_

- [ ] 8. Wire up composition root and configuration loading
  - Load `GitIntegrationConfig` from `infra/config/config-loader.ts`; validate all required fields; provide defaults (baseBranch: `"main"`, remote: `"origin"`, maxFilesPerCommit: `50`, forcePushEnabled: `false`)
  - Construct `GitValidator`, `GitControllerAdapter` (injecting `IToolExecutor` and `GitValidator`), `GitHubPrAdapter` (injecting config with token from environment), `GitEventBus`, and `GitIntegrationService` at the composition root
  - Register `GitIntegrationService` in the dependency injection container so the implementation engine can resolve `IGitIntegrationService`
  - Ensure no adapter or infra imports appear in domain or application layer modules
  - _Requirements: 5.1, 5.2, 5.3, 5.5_

- [ ] 9. Write unit tests for domain and application logic
- [ ] 9.1 (P) Unit test GitValidator edge cases
  - Test `isValidBranchName` against every invalid character class: `~`, `^`, `:`, `?`, `*`, `[`, `\`, names containing `..` or `@{`, control characters, names starting/ending with `.` or `/`, names ending with `.lock`
  - Test `matchesProtectedPattern` with exact matches and glob patterns (`release/*`, `release/**`)
  - Test `isWithinWorkspace` with normal paths, symlink-style relative paths, and path traversal attempts (`../outside`)
  - Test `filterProtectedFiles` correctly partitions `.env`, `secrets.json`, `*.key`, `*.pem` from safe files
  - _Requirements: 1.3, 6.1, 6.6_

- [ ] 9.2 (P) Unit test GitIntegrationService orchestration logic
  - Test protected-file detection pre-commit blocks the LLM call and emits `protected-file-detected`
  - Test file-count limit enforcement emits `commit-size-limit-exceeded` before LLM invocation
  - Test consecutive-failure counter: increments on each identical failure; emits `repeated-git-failure` on the third; resets to 0 on next success
  - Test branch name collision suffix logic: first collision appends `-2`, second appends `-3`, etc.
  - Test LLM prompt construction truncates diff to `maxDiffTokens` and subjects line to 72-char cap
  - Test `runFullWorkflow` halts at the first error stage and does not invoke subsequent stages
  - Use stub `IGitController` and stub `IPullRequestProvider`
  - _Requirements: 1.3, 2.2, 2.3, 2.4, 2.6, 2.7, 4.2, 6.5_

- [ ] 9.3 (P) Unit test GitHubPrAdapter HTTP mapping
  - Test HTTP 401 response maps to `PrResult { ok: false, error: { category: "auth", statusCode: 401 } }`
  - Test existing open PR found via GET → PATCH update path is used instead of POST create
  - Test draft flag is set in POST payload when `params.isDraft` is true
  - Test title is capped at 72 characters before submission
  - Use fetch mock / interceptor; no real network calls
  - _Requirements: 4.4, 4.5, 4.7_

- [ ] 10. Write integration tests for adapter and service workflows
- [ ] 10.1 (P) Integration test GitControllerAdapter with real ToolExecutor
  - Use a temporary in-process git repository for each test
  - Test branch creation collision resolution: create branch, attempt to create same name, verify suffix is appended
  - Test protected-file staging rejection: stage a `.env` file, verify `stageAndCommit` returns `{ ok: false }` without calling `git commit`
  - Test push non-fast-forward error detection: simulate diverged remote branch, verify error is classified as `push-rejected-non-fast-forward`
  - _Requirements: 1.3, 1.5, 2.7, 3.4, 5.2_

- [ ] 10.2 (P) Integration test GitIntegrationService full workflow with stubs
  - Stub `IGitController` returns success for each operation in sequence
  - Stub `IPullRequestProvider` returns a successful `PullRequestResult`
  - Verify the complete event emission sequence: `branch-created` → `commit-created` → `branch-pushed` → `pull-request-created`
  - Test retry escalation path: configure stub to fail identically three times → verify `repeated-git-failure` event is emitted with `attemptCount: 3`
  - Verify `IAuditLogger.write` is called once per successful operation with correct `toolName` and outcome
  - _Requirements: 1.6, 2.8, 3.5, 4.6, 6.2, 6.5_
