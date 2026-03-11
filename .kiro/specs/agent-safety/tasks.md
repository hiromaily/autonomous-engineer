# Implementation Plan

- [ ] 1. Domain Foundation
- [ ] 1.1 Define immutable safety configuration and session state types
  - Create `SafetyConfig` as an immutable value object with all policy thresholds and operator-configurable lists: workspace root, protected file patterns (defaults: `.env`, `secrets.json`, `.git/config`), protected branches (defaults: `main`, `production`), branch naming regex, max files per commit, shell blocklist/allowlist, max iterations, max runtime, max file deletes, rate limit config, and approval timeout
  - Create `SafetySession` as a mutable per-session aggregate holding: session ID, start timestamp, iteration count, repo write count, rolling timestamp windows for tool invocations and API requests, consecutive failure signature map, pause state, and emergency stop flag
  - Define `SafetyRateLimitConfig` embedded in `SafetyConfig` with defaults for tool invocations per minute, repo writes per session, and API requests per minute
  - Define the `EmergencyStopSource` discriminated union covering OS signal (SIGINT/SIGTERM) and programmatic trigger (safety-violation, resource-exhaustion) variants
  - Validate `SafetyConfig` at construction time; expose all array fields as `ReadonlyArray` to prevent post-construction mutation
  - _Requirements: 1.1, 2.1, 3.1, 3.3, 3.4, 4.1, 5.4, 6.1, 6.2, 6.5, 7.1, 7.5, 9.1, 9.2, 9.3, 9.5, 11.3, 12.1_

- [ ] 1.2 Define the guard interface and shared value objects
  - Build the `ISafetyGuard` contract: a single check operation that receives the tool name, raw input, and safety context, and returns a check result without side effects and without ever rejecting
  - Build `SafetyCheckResult` as a discriminated value object with three outcomes: allowed (proceed), blocked (carry the specific `ToolError`), and requires-approval (carry a populated `ApprovalRequest`)
  - Build `SafetyContext` as an extension of the existing `ToolContext` that adds session and config references alongside existing fields — callers receive this type transparently
  - Build `ApprovalRequest` value object carrying the description, risk classification, expected impact, and proposed action needed to present an approval prompt
  - _Requirements: 1.1, 2.1, 3.1, 4.1, 6.1, 7.1, 8.1, 9.1, 10.1, 11.1_

- [ ] 1.3 Define application port interfaces for adapters
  - Build the `IAuditLogger` port with write and flush operations; build the `AuditEntry` value object with ISO 8601 timestamp, session ID, iteration number, tool name, sanitized input summary, outcome classification (`success | blocked | error | emergency-stop`), block reason, approval decision, and error details
  - Build the `IApprovalGateway` port with a single request-approval operation that accepts a request and a timeout, and returns one of three outcomes: approved, denied, or timeout
  - Build the `ISandboxExecutor` port with a single execute operation; build the sandbox request value object (command, args, working directory, method, optional container image) and the sandbox result value object (stdout, stderr, exit code, duration)
  - Build the `IEmergencyStopHandler` port with register, trigger, and deregister operations
  - _Requirements: 5.1, 10.1, 11.1, 12.1_

---

- [ ] 2. Stateless Safety Guards
- [ ] 2.1 (P) Implement workspace boundary enforcement guard
  - Build a guard that extracts every file path field from incoming tool inputs; use an exhaustive, statically-defined mapping from tool name to path field names so no tool category can bypass the check through an omitted field
  - Normalize each extracted path to its canonical absolute form before comparing against the workspace root; the check always operates on the fully resolved path, never the raw input string
  - Reject traversal sequences (e.g., `../`) through the same normalization step — traversal is defused by resolving first, then comparing
  - Return a permission-category error when any path resolves outside the workspace boundary; pass unchanged when all paths are within bounds
  - Apply to all four filesystem tool categories and to any git or shell tool inputs that include file paths
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [ ] 2.2 (P) Implement protected file pattern matching guard
  - Build a guard that applies only to write tools (`write_file`) and checks the target file path against the operator-configured list of protected file patterns; pass all read operations without checking
  - Normalize the path before matching; match by both the file's base name and the full-path substring to cover directory-anchored patterns like `.git/config`
  - Reject writes targeting any protected pattern — default or operator-added — with a `"permission"` category `ToolError`
  - Enforce that this guard runs after the workspace isolation guard in the ordered pipeline
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

- [ ] 2.3 (P) Implement git operation safety enforcement guard
  - Build a guard covering `git_commit`, `git_branch_create`, and `git_branch_switch` operations
  - For commit operations: read the current branch name via `git rev-parse --abbrev-ref HEAD` (direct subprocess call, not routed through the tool system) and reject commits on any protected branch with a `"permission"` category `ToolError`; count staged files via `git diff --staged --name-only` and reject if the count exceeds `maxFilesPerCommit` with a `"validation"` category `ToolError`
  - For branch creation: validate the proposed branch name against `branchNamePattern` regex and reject non-conforming names with a `"validation"` category `ToolError`
  - Apply the same protected-branch rejection policy to all operator-configured branches alongside the defaults
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [ ] 2.4 (P) Implement shell command blocklist and allowlist validation guard
  - Build a guard covering `run_command`, `run_test_suite`, and `install_dependencies` tools
  - Compile blocklist patterns from `SafetyConfig` to `RegExp` objects at configuration construction time; reject commands matching any blocklist pattern with a `"permission"` category `ToolError` that includes the matched pattern name in the error message
  - When `shellAllowlist` is non-null, additionally reject any command that does not match at least one allowlist pattern even if it passes the blocklist
  - Always perform command validation before any execution; never pass a rejected command to the shell executor
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

---

- [ ] 3. Stateful Safety Guards
- [ ] 3.1 (P) Implement session iteration count and runtime limit enforcement guard
  - Build a guard that reads `session.iterationCount` and `Date.now() - session.startedAtMs` from `SafetyContext` and rejects the invocation if either exceeds the configured limit
  - Include the limit type ("iterations" or "runtime") and current value in the rejection error message to support human-readable graceful stop messages
  - Produce a structured error carrying a progress summary string so the agent loop can record state before halting
  - Make `iterationCount` and elapsed runtime observable via session state for external monitoring consumers
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

- [ ] 3.2 (P) Implement consecutive failure detection and session pause guard
  - Build a guard with two responsibilities: a pre-check that rejects all invocations when `session.paused` is true (with a human-review-required error), and a post-execution update (called by the executor after each result) that tracks failure signatures
  - Compute a failure signature by concatenating the tool name, error type, and the first 120 characters of the error message into a stable fingerprint for each failed invocation result
  - When the same failure signature occurs 3 or more consecutive times, set `session.paused = true`, set `session.pauseReason`, and emit a structured notification identifying the repeated failure signature and occurrence count
  - Reset the consecutive counter for a signature when a different result (success or a different error) is observed for that tool
  - Do not resume from the paused state except via an explicit external resume signal that clears `session.paused`
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

- [ ] 3.3 (P) Implement per-category rolling rate limit guard
  - Build a guard enforcing three independent rate categories using session state: per-minute rolling window for total tool invocations (`session.toolInvocationTimestamps`), per-session counter for repository write operations (`session.repoWriteCount`), and per-minute rolling window for external API requests (`session.apiRequestTimestamps`)
  - Prune timestamps older than 60 seconds from each rolling window before counting; compare current count against the configured limit for each category
  - Reject invocations that would exceed any category's limit with a `"runtime"` category `ToolError` that includes the limit category name and current count in the error message
  - Expose all three counters through session state for observability consumers
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

- [ ] 3.4 (P) Implement destructive action classification and approval routing guard
  - Build a guard that classifies an operation as destructive when: the number of files to be deleted exceeds `maxFileDeletes`, a force-push flag is detected in a git push input, or the write target matches a protected file pattern
  - When a destructive operation is detected, return a check result signalling that approval is required along with a populated approval request (description, risk classification, expected impact, proposed action); return with allowed=true so the executor — not this guard — is responsible for calling the approval gateway and acting on the decision
  - This guard must run before `RateLimitGuard` in the ordered pipeline
  - The guard itself holds no mutable state; all session updates after an approval decision are the executor's responsibility
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

---

- [ ] 4. Safety Adapters
- [ ] 4.1 (P) Implement append-only NDJSON audit logger adapter
  - Build an adapter that opens the configured log file exclusively in append mode and writes exactly one serialized JSON line followed by a newline per `write()` call; flush each write to disk before resolving
  - Create the log directory on the first write if it does not exist; never overwrite or modify existing entries
  - Include all `AuditEntry` fields in every write: ISO 8601 timestamp, session ID, iteration number, tool name, sanitized input summary (capped at 512 bytes), outcome classification, block reason, approval decision, and error details
  - Surface disk-full and permission errors as `console.error` warnings without propagating to callers; retry emergency-stop entries once on a fallback path before giving up
  - Expose a `flush()` method that waits for all pending writes to complete; used by `EmergencyStopHandler` before process termination
  - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

- [ ] 4.2 (P) Implement CLI readline approval gateway adapter
  - Build an adapter that presents approval requests to the human operator via a terminal readline prompt displaying the operation description, risk classification, and expected impact
  - Accept operator input within the configured timeout using an `AbortController`-based mechanism; if the timeout expires before input is received, return `'timeout'` immediately without waiting further
  - Map `'y'`/`'yes'` input to `'approved'`, any other input to `'denied'`, and timeout to `'timeout'`; never throw and always resolve to exactly one `ApprovalDecision`
  - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

- [ ] 4.3 (P) Implement temp-directory sandbox executor adapter
  - Build an adapter that creates a fresh temporary directory for each `execute()` call and runs the command with its working directory set to the temp location, preventing writes to the workspace root
  - After execution completes (success, failure, or timeout), remove the temporary directory and all its contents; guarantee cleanup even when execution times out
  - When `method === 'container'`, pass the configured `containerImage` to the subprocess invocation; for `'temp-directory'` and `'restricted-shell'` methods, use Bun's subprocess API with the temp directory as the cwd
  - Report temp directory creation failures and container availability failures as `"runtime"` category errors before attempting execution, per `ISandboxExecutor` postconditions
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

---

- [ ] 5. Implement the SafetyGuardedToolExecutor decorator
  - Construct and hold the ordered guard list at initialization in the pipeline sequence: iteration-limit guard, failure-detection guard (pre-check), workspace isolation guard, filesystem guard, git safety guard, shell restriction guard, destructive action guard, then rate-limit guard
  - On each invocation: check the emergency stop flag first and reject immediately if set; then run each guard in order, stopping at the first rejection; write the blocked audit entry before returning the error
  - When the destructive action guard signals approval is required, call the approval gateway; if denied or timed out, write a blocked audit entry and return a permission error; if approved, continue to execution
  - For sandbox tools (test suite runner, dependency installer), delegate to the sandbox executor instead of the wrapped tool executor; for all other tools, delegate to the wrapped executor
  - Extend the incoming tool context with the session and config references internally before running guards; callers pass only the unchanged context they already have
  - After each executed invocation (success or error), write the audit entry, increment the iteration counter, update rate-limit rolling windows, increment the repo write counter for repository write operations, and invoke the failure detection guard's post-execution update with the result
  - After an approval gateway response, record the decision in the session state so it is included in the audit entry and available for observability
  - Never throw; all error paths return a failed tool result
  - _Requirements: 1.1, 2.1, 3.1, 4.1, 5.1, 6.1, 6.5, 7.1, 7.2, 7.5, 8.2, 8.3, 8.4, 8.5, 9.1, 9.5, 10.1, 10.2, 10.3, 10.4, 11.1, 12.5_

---

- [ ] 6. (P) Implement the EmergencyStopHandler
  - Register OS signal handlers for SIGINT and SIGTERM at agent session start; on signal receipt, set the emergency stop flag on the session, write a final audit entry recording the signal source and last known agent state, wait for the audit flush to complete, then terminate the process
  - Expose a programmatic trigger for safety-violation and resource-exhaustion detection paths; apply the same stop sequence (set flag → write audit entry → flush → exit) as the signal handler
  - Expose a deregister operation that removes the OS signal listeners when the agent session ends cleanly without triggering a stop
  - _Requirements: 12.1, 12.2, 12.3, 12.4_

---

- [ ] 7. Composition Root Integration
  - Instantiate `SafetyConfig` with operator-supplied overrides merged over validated defaults; instantiate `SafetySession` with a fresh UUID session ID and the current epoch milliseconds as the start timestamp
  - Instantiate the audit logger, approval gateway, and sandbox executor adapters; inject them along with the existing `ToolExecutor` (spec2), the session, and the config into `SafetyGuardedToolExecutor`
  - Register the `EmergencyStopHandler` with the session and audit logger immediately after construction; replace the bare `ToolExecutor` reference in the agent loop composition root with `SafetyGuardedToolExecutor`
  - On clean agent session end (no emergency stop), call the handler's deregister operation to remove OS signal listeners and release resources
  - Confirm that all existing call sites continue to pass the unchanged tool context and receive tool results with no callers requiring modification
  - _Requirements: 1.1, 6.1, 10.1, 11.1, 12.1_

---

- [ ] 8. Unit Tests
- [ ] 8.1 (P) Stateless guard unit tests
  - `WorkspaceIsolationGuard`: path traversal sequences (e.g., `../../../etc/passwd`) rejected, paths at workspace root boundary accepted, paths outside root rejected, all four filesystem tool categories covered, git tool paths covered, shell tool paths covered
  - `FilesystemGuard`: each default protected pattern (`.env`, `secrets.json`, `.git/config`) rejected on write; operator-added patterns rejected; read operations on same paths pass through
  - `GitSafetyGuard`: commit on `main` rejected with `"permission"` error; commit on `agent/foo` accepted; staged file count at limit accepted; staged file count above limit rejected with `"validation"` error; branch name `agent/foo` accepted; branch name `no-prefix` rejected
  - `ShellRestrictionGuard`: blocklist match rejected with matched pattern in error message; blocklist non-match allowed; allowlist present with match allowed; allowlist present with non-match rejected
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4, 4.5_

- [ ] 8.2 (P) Stateful guard unit tests
  - `IterationLimitGuard`: at-limit invocation accepted; one-over-limit rejected with limit type and current count in message; runtime limit similarly tested with a mocked elapsed time
  - `FailureDetectionGuard`: first and second consecutive identical failures pass; third consecutive identical failure sets `session.paused` and emits notification; subsequent invocations on paused session all rejected; counter resets on a different result
  - `RateLimitGuard`: at-limit for each of the three categories accepted; one-over-limit for each rejected with category name and count in message; rolling window prunes timestamps older than 60 seconds; repo write counter increments correctly per session
  - `DestructiveActionGuard`: bulk delete above threshold returns `requiresApproval: true` with populated `ApprovalRequest`; force-push flag triggers approval request; protected file write triggers approval request; delete count below threshold passes through
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 7.1, 7.2, 7.3, 7.4, 7.5, 8.1, 8.2, 9.1, 9.2, 9.3, 9.4, 9.5_

- [ ] 8.3 (P) Adapter unit tests
  - `AuditLogger`: writes valid NDJSON entries in append mode; all required fields present (session ID, iteration number, tool name, outcome, block reason); directory created on first write; existing content preserved across multiple writes; sanitized input summary capped at 512 bytes
  - `ApprovalGateway`: `'y'` input returns `'approved'`; non-`'y'` input returns `'denied'`; no input within timeout returns `'timeout'` without blocking the test
  - `SandboxExecutor`: temp directory created and removed after successful execution; temp directory removed on timeout; setup failure (unwritable temp parent) returns `"runtime"` category error before any execution
  - _Requirements: 5.1, 5.3, 5.5, 10.1, 10.2, 10.3, 10.4, 10.5, 11.1, 11.2, 11.3, 11.4_

---

- [ ] 9. Integration Tests
- [ ] 9.1 SafetyGuardedToolExecutor end-to-end pipeline tests
  - Full guard pipeline pass: all guards pass → wrapped `ToolExecutor` invoked → audit entry written with `success` outcome and all required fields
  - Blocked invocation: workspace guard fails → wrapped executor never called → audit entry written with `blocked` outcome and block reason before the error is returned
  - Approval flow (approved): destructive action detected → `ApprovalGateway` stub returns `'approved'` → tool executes → audit entry records `approvalDecision: 'approved'`
  - Approval flow (denied): destructive action detected → stub returns `'denied'` → tool rejected with `"permission"` error → audit entry records denial
  - Approval flow (timeout): stub returns `'timeout'` → same denial path as denied
  - Sandbox delegation: `run_test_suite` invocation → `SandboxExecutor` called instead of wrapped executor → audit entry written
  - Iteration limit boundary: execute exactly `maxIterations` invocations → next invocation rejected with graceful stop error carrying progress summary
  - _Requirements: 1.3, 5.1, 6.1, 6.3, 6.4, 7.2, 8.2, 8.3, 8.4, 10.2, 10.3, 10.4, 11.2, 11.3, 11.4, 11.5_

- [ ] 9.2 EmergencyStopHandler and AuditLogger durability integration tests
  - SIGINT simulation: send SIGINT to the test process via `process.emit('SIGINT')` → `session.emergencyStopRequested` set to true → final audit entry written with stop source → subsequent `invoke()` calls immediately rejected
  - Programmatic trigger: call `trigger({ kind: 'safety-violation', description: '...' })` → same stop sequence applied; verify audit entry contains correct `emergencyStopSource`
  - Concurrent writes: issue multiple simultaneous `AuditLogger.write()` calls and verify the resulting NDJSON file has no interleaved partial JSON lines and every entry is parseable
  - Persistence: write entries, re-open the log file in read mode (simulating process restart), and verify all previously written entries remain intact
  - _Requirements: 10.3, 12.1, 12.2, 12.3, 12.4, 12.5_
