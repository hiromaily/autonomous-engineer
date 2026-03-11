# Requirements Document

## Project Description (Input)
agent-safety

See section `spec3: agent-safety` at @docs/agent/dev-agent-v1-specs.md.

## Introduction

The Agent Safety System is the operational safety layer for the AI Dev Agent. It wraps all tool execution and enforces policies and guardrails that prevent the agent from causing unintended or destructive changes to the development environment. The system sits between the tool system (spec2) and the rest of the agent stack, providing layered protection through workspace isolation, filesystem guardrails, git safety, shell restrictions, sandboxing, iteration limits, failure detection, destructive action detection, rate limiting, audit logging, a human approval workflow, and an emergency stop mechanism.

This specification covers all sub-components described in `spec3: agent-safety` in the architecture reference and directly depends on `spec2: tool-system`.

---

## Requirements

### Requirement 1: Workspace Isolation

**Objective:** As an operator, I want the agent to be confined to a configured workspace directory, so that it cannot accidentally or maliciously modify files outside the project.

#### Acceptance Criteria

1. The Agent Safety System shall enforce a configured `workspaceRoot` path as the exclusive boundary for all file read and write operations.
2. When a tool requests access to a file path, the Agent Safety System shall normalize the path to its canonical absolute form before performing any boundary check.
3. If a normalized file path resolves to a location outside the `workspaceRoot`, the Agent Safety System shall reject the operation and return a `"permission"` category `ToolError` without executing the tool.
4. If a file path contains traversal sequences (e.g., `../`), the Agent Safety System shall resolve and normalize the full path and apply the workspace boundary check to the resolved path.
5. The Agent Safety System shall apply workspace boundary checks to all filesystem tool categories: `read_file`, `write_file`, `list_directory`, and `search_files`.

---

### Requirement 2: Filesystem Guardrails

**Objective:** As an operator, I want sensitive and system-critical files to be protected from agent modification, so that credentials, secrets, and repository configuration remain intact.

#### Acceptance Criteria

1. The Agent Safety System shall maintain a configurable list of protected file patterns including at minimum `.env`, `secrets.json`, and `.git/config`.
2. When a write operation targets a file matching a protected file pattern, the Agent Safety System shall reject the operation and return a `"permission"` category `ToolError`.
3. The Agent Safety System shall perform path normalization before matching file paths against protected file patterns.
4. Where the operator configures additional protected file patterns, the Agent Safety System shall include those patterns in all write validation checks.
5. The Agent Safety System shall apply filesystem guardrail checks after workspace boundary checks in the validation pipeline.

---

### Requirement 3: Git Safety

**Objective:** As an operator, I want the agent to be prevented from pushing directly to protected branches and from making oversized commits, so that repository integrity and review workflows are preserved.

#### Acceptance Criteria

1. The Agent Safety System shall maintain a configurable list of protected branch names including at minimum `main` and `production`.
2. When the agent attempts a `git_commit` or push operation while the current branch is a protected branch, the Agent Safety System shall reject the operation and return a `"permission"` category `ToolError`.
3. The Agent Safety System shall enforce a configurable maximum number of files changed per commit (default: 50); if exceeded, the Agent Safety System shall reject the commit and return a `"validation"` category `ToolError`.
4. When the agent creates a new branch, the Agent Safety System shall enforce a configurable naming convention (default pattern: `agent/<description>`); if the branch name does not match, the Agent Safety System shall reject the operation and return a `"validation"` category `ToolError`.
5. Where the operator configures additional protected branch names, the Agent Safety System shall apply the same push-rejection policy to those branches.

---

### Requirement 4: Shell Command Restrictions

**Objective:** As an operator, I want the agent's shell execution capability to be limited to safe, explicitly permitted commands, so that destructive or system-level commands cannot be run.

#### Acceptance Criteria

1. The Agent Safety System shall validate every shell command against a configurable blocklist of patterns before execution; commands matching any blocklist pattern shall be rejected with a `"permission"` category `ToolError`.
2. The Agent Safety System shall block commands matching destructive patterns including at minimum `rm -rf /`, `shutdown`, and `reboot`.
3. Where the operator configures an allowlist of permitted commands, the Agent Safety System shall reject any command not matching an allowlist pattern, even if it does not match the blocklist.
4. The Agent Safety System shall perform command validation before passing the command to the shell executor.
5. If a shell command is blocked, the Agent Safety System shall include the blocked command pattern in the error message returned to the caller.

---

### Requirement 5: Execution Sandboxing

**Objective:** As an operator, I want untrusted code execution and test runners to run in isolated environments, so that a failing or malicious script cannot affect the host system.

#### Acceptance Criteria

1. The Agent Safety System shall execute `run_test_suite` and `install_dependencies` tool invocations in an isolated execution environment (container, restricted shell, or temporary directory).
2. While a sandboxed process is running, the Agent Safety System shall prevent the process from writing to paths outside the designated sandbox working directory.
3. When a sandboxed execution completes or times out, the Agent Safety System shall clean up all temporary resources created for that execution.
4. Where the operator configures a container-based sandboxing method, the Agent Safety System shall pass the configured container image to the execution environment.
5. The Agent Safety System shall report sandbox setup failures as `"runtime"` category `ToolError` before attempting execution.

---

### Requirement 6: Iteration Limits

**Objective:** As an operator, I want the agent session to be bounded by configurable iteration and runtime limits, so that runaway loops cannot consume unbounded resources.

#### Acceptance Criteria

1. The Agent Safety System shall enforce a configurable `maxIterations` limit per agent session (default: 50); when the iteration count reaches the limit, the Agent Safety System shall trigger a graceful stop.
2. The Agent Safety System shall enforce a configurable `maxRuntime` limit per agent session (default: 10 minutes); when elapsed runtime reaches the limit, the Agent Safety System shall trigger a graceful stop.
3. When a graceful stop is triggered by an iteration or runtime limit, the Agent Safety System shall record a progress summary before halting further tool invocations.
4. When a graceful stop is triggered, the Agent Safety System shall emit a human-readable message explaining which limit was reached and the current progress state.
5. While an agent session is active, the Agent Safety System shall track the current iteration count and elapsed runtime and make these values available for observability metrics.

---

### Requirement 7: Failure Detection

**Objective:** As an operator, I want the system to detect repeated identical failures and pause execution, so that the agent does not loop indefinitely on a stuck state.

#### Acceptance Criteria

1. The Agent Safety System shall track the signature of each tool invocation failure (tool name + error type + error message) across iterations within a session.
2. If the same failure signature occurs 3 or more consecutive times, the Agent Safety System shall pause further tool invocations and request human review.
3. When execution is paused by failure detection, the Agent Safety System shall emit a structured notification identifying the repeated failure and the number of occurrences.
4. When human review is requested due to repeated failures, the Agent Safety System shall not resume tool execution until an explicit resume signal is received.
5. The Agent Safety System shall reset the failure count for a given signature when a different result is observed for the same tool invocation.

---

### Requirement 8: Destructive Action Detection

**Objective:** As an operator, I want high-impact, potentially irreversible operations to be routed through a human approval gate, so that mass file deletions, force-pushes, and critical configuration changes require explicit authorization.

#### Acceptance Criteria

1. The Agent Safety System shall classify an operation as destructive if it involves: deleting more than a configurable file threshold (default: 10 files), a git force-push, or overwriting a file matching the protected file patterns defined in Requirement 2.
2. When a destructive operation is detected, the Agent Safety System shall pause execution and present the proposed operation to the human approval workflow before executing the tool.
3. If the operator denies a destructive operation, the Agent Safety System shall reject the tool invocation with a `"permission"` category `ToolError` and resume the agent with the denial recorded in the audit log.
4. If the operator approves a destructive operation, the Agent Safety System shall allow the tool to execute and record the approval in the audit log.
5. The Agent Safety System shall evaluate destructive action thresholds before sandbox and rate-limit checks in the validation pipeline.

---

### Requirement 9: Rate Limiting

**Objective:** As an operator, I want per-category frequency limits on tool execution, repository modifications, and external API requests, so that runaway automation cannot exceed safe operational throughput.

#### Acceptance Criteria

1. The Agent Safety System shall enforce a configurable maximum number of tool invocations per minute across all tool categories (default: 60 invocations/minute).
2. The Agent Safety System shall enforce a configurable maximum number of repository write operations (commits, branch creations) per session (default: 20 operations/session).
3. The Agent Safety System shall enforce a configurable maximum number of external API requests per minute (default: 30 requests/minute).
4. If a rate limit is exceeded, the Agent Safety System shall reject the tool invocation with a `"runtime"` category `ToolError` including the limit category and current rate in the error message.
5. While an agent session is active, the Agent Safety System shall maintain rolling counters for each rate-limit category and make these available for observability metrics.

---

### Requirement 10: Audit Logging

**Objective:** As an operator, I want every tool invocation to be recorded in an immutable, structured audit log, so that agent behavior is fully traceable and reviewable.

#### Acceptance Criteria

1. The Agent Safety System shall write a structured log entry for every tool invocation, including: ISO 8601 timestamp, tool name, input parameters, result status (success/failure), and error details if applicable.
2. For tool invocations that are executed (not blocked by a safety check), the Agent Safety System shall write the audit log entry after the tool result is known.
3. The Agent Safety System shall write audit log entries to append-only storage; previously written entries shall not be modified or deleted by any agent operation.
4. When a tool invocation is blocked by any safety check (workspace, guardrail, git, shell, destructive, rate limit), the Agent Safety System shall write a log entry recording the block reason before returning the error.
5. The Agent Safety System shall include the session ID and iteration number in every audit log entry to enable per-session and per-iteration traceability.

---

### Requirement 11: Human Approval Workflow

**Objective:** As an operator, I want a structured approval gate for high-risk operations, so that humans can review, approve, or deny proposed changes before they are executed.

#### Acceptance Criteria

1. The Agent Safety System shall expose a human approval interface that presents the proposed operation description, risk classification, and expected impact before awaiting a decision.
2. When the Agent Safety System routes an operation to the human approval workflow, the agent loop shall be paused and no further tool invocations shall proceed until a decision is received.
3. The Agent Safety System shall support three approval outcomes: `approved` (proceed), `denied` (reject with error), and `timeout` (configurable wait period exceeded — treat as denied).
4. When an approval request times out, the Agent Safety System shall emit a timeout notification and treat the outcome as a denial.
5. The Agent Safety System shall record every approval decision (approved/denied/timeout) in the audit log with the operator identity if available.

---

### Requirement 12: Emergency Stop

**Objective:** As an operator, I want the ability to immediately terminate all agent activity, so that I can regain full control of the system at any time.

#### Acceptance Criteria

1. The Agent Safety System shall register a signal handler for SIGINT and SIGTERM that triggers an immediate emergency stop of all active agent operations.
2. The Agent Safety System shall support programmatic emergency stop triggers from internal sources: a safety policy violation that cannot be recovered automatically, and resource exhaustion (e.g., disk full, memory limit exceeded).
3. When an emergency stop is triggered, the Agent Safety System shall halt the agent loop, all in-flight tool executions, and all background processes immediately.
4. When an emergency stop is triggered, the Agent Safety System shall write a final audit log entry recording the stop event, trigger source, and last known agent state; in-progress audit log writes shall complete before the process terminates.
5. While an emergency stop is in progress, the Agent Safety System shall not accept new tool invocation requests.
