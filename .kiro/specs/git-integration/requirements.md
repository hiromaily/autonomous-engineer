# Requirements Document

## Introduction

The git-integration spec (spec8) provides all repository operations required for the automated development pipeline of the Autonomous Engineer system. It implements a Git Controller that encapsulates branch creation, commit automation, push operations, and pull request creation behind a clean port interface. All other system components — particularly the implementation-loop and task-planning — interact with Git exclusively through this controller via the tool-system. The Git Controller must operate autonomously with no manual intervention while enforcing safety constraints defined by the agent-safety spec.

## Requirements

### Requirement 1: Feature Branch Management

**Objective:** As the implementation engine, I want to create isolated feature branches for each specification, so that changes are isolated from protected branches and traceable to specific development work.

#### Acceptance Criteria

1. When a new specification is ready for implementation, the Git Integration Service shall create a feature branch from the configured base branch (default: `main`).
2. When creating a feature branch, the Git Integration Service shall derive the branch name from spec and task metadata using the pattern `agent/<spec-name>` or `agent/<task-slug>` (e.g., `agent/cache-implementation`).
3. If a branch with the derived name already exists, the Git Integration Service shall append a numeric suffix (e.g., `agent/cache-implementation-2`) and notify the caller of the conflict resolution.
4. If the configured base branch does not exist in the remote, the Git Integration Service shall return a structured error indicating the missing base branch and halt branch creation.
5. The Git Integration Service shall verify the working directory is clean (no uncommitted changes) before creating a new branch.
6. When branch creation succeeds, the Git Integration Service shall emit a `branch-created` event containing the branch name and base branch reference.

---

### Requirement 2: Commit Automation

**Objective:** As the implementation engine, I want to automatically generate meaningful commit messages and commit staged changes, so that the repository history accurately reflects each development step without manual authorship.

#### Acceptance Criteria

1. When the agent loop completes a task section, the Git Integration Service shall detect all staged and unstaged changes using `git status` and `git diff`.
2. When changes are detected, the Git Integration Service shall invoke the LLM provider to generate a descriptive commit message summarizing the changes, referencing the spec name and task title.
3. The Git Integration Service shall validate the commit against safety limits: the number of changed files must not exceed the configured `maxFilesPerCommit` threshold (default: 50).
4. If the change size exceeds `maxFilesPerCommit`, the Git Integration Service shall reject the commit, emit a `commit-size-limit-exceeded` event, and request human review before proceeding.
5. When a generated commit message is available and safety limits pass, the Git Integration Service shall stage all changed files excluding those matching protected patterns and execute the commit.
6. If no changes are detected after a task section completes, the Git Integration Service shall skip the commit step and log a `no-changes-to-commit` warning.
7. The Git Integration Service shall never commit files matching protected patterns (`.env`, `secrets.json`, `*.key`, `*.pem`) and shall emit a `protected-file-detected` error if such files are staged.
8. When a commit succeeds, the Git Integration Service shall emit a `commit-created` event containing the commit hash, message, and file count.

---

### Requirement 3: Push Operations

**Objective:** As the workflow engine, I want to push the feature branch to the remote repository after implementation completes, so that the changes are available for review and pull request creation.

#### Acceptance Criteria

1. When all task sections for a specification are committed, the Git Integration Service shall push the current feature branch to the configured remote (default: `origin`).
2. If the target branch matches the protected branch list (default: `main`, `master`, `production`, `release/*`), the Git Integration Service shall abort the push operation and emit a `protected-branch-push-rejected` error.
3. The Git Integration Service shall never perform a force push unless explicitly authorized via configuration; by default force push is prohibited for all branches.
4. If the remote branch has diverged from the local branch (non-fast-forward), the Git Integration Service shall emit a `push-rejected-non-fast-forward` error and request human intervention rather than force-pushing.
5. When push succeeds, the Git Integration Service shall emit a `branch-pushed` event containing the remote name, branch name, and commit hash.

---

### Requirement 4: Pull Request Creation

**Objective:** As the development workflow, I want to automatically create a pull request after pushing the feature branch, so that the implementation is ready for human review without manual PR authorship.

#### Acceptance Criteria

1. When the feature branch is successfully pushed, the Git Integration Service shall create a pull request targeting the configured base branch via the repository hosting API (GitHub and GitLab are the primary supported providers).
2. When creating a pull request, the Git Integration Service shall invoke the LLM provider to generate a descriptive PR title (under 72 characters) and body summarizing the implementation.
3. The Git Integration Service shall include in the PR body: the spec name, a link to the relevant spec artifacts, a summary of completed tasks, and an implementation overview.
4. If the repository hosting API returns an authentication error, the Git Integration Service shall emit a `pr-creation-auth-failed` error with guidance to check the configured API token.
5. If a pull request for the same branch already exists, the Git Integration Service shall update the existing PR description rather than creating a duplicate.
6. When pull request creation succeeds, the Git Integration Service shall emit a `pull-request-created` event containing the PR URL, title, and target branch.
7. Where the repository hosting provider supports draft pull requests, the Git Integration Service shall set the pull request to draft status when the workflow indicates the implementation is incomplete or requires further review cycles.

---

### Requirement 5: Git Controller Port Interface

**Objective:** As a developer integrating git operations into the workflow, I want a clean port interface for all git operations, so that the core application logic is decoupled from specific Git hosting providers and CLI implementations.

#### Acceptance Criteria

1. The Git Integration Service shall expose all operations through a `IGitController` port interface defined in the application ports layer (`application/ports/git-controller-port.ts`).
2. The Git Integration Service shall implement the `IGitController` interface in an adapter (`adapters/git/`) that can be replaced without changing core application logic.
3. Where multiple repository hosting providers are required, the Git Integration Service shall support provider-specific adapters (e.g., `GitHubAdapter`, `GitLabAdapter`) that implement the same `IPullRequestProvider` interface.
4. The Git Integration Service shall use the tool-system's git tools (`git_status`, `git_diff`, `git_commit`, `git_branch`) for all local Git CLI operations.
5. The Git Integration Service shall not import directly from Git CLI libraries or repository API SDKs in the application or domain layers; all such dependencies shall reside in the adapter and infra layers.

---

### Requirement 6: Safety and Guardrails

**Objective:** As the agent-safety subsystem, I want git operations to enforce safety constraints, so that the automated agent cannot cause destructive or irreversible changes to the repository.

#### Acceptance Criteria

1. The Git Integration Service shall enforce workspace isolation: all git operations must target the configured workspace root and reject any operation referencing paths outside it.
2. The Git Integration Service shall write an audit log entry to record the start and outcome of each git operation, containing: timestamp, operation type, parameters, and outcome.
3. If a git operation fails due to a permission denied error, the Git Integration Service shall emit a structured `ToolError` with category `"permission"` and halt the operation.
4. The Git Integration Service shall respect the `PermissionSet` flags from the tool-system: `gitWrite` must be `true` for all write operations (commit, push, branch creation); operations shall be rejected with a `"permission"` error if `gitWrite` is `false`.
5. If the same git operation fails identically three consecutive times, the Git Integration Service shall pause execution, emit a `repeated-git-failure` event, and escalate to human review.
6. The Git Integration Service shall validate that all branch names conform to Git ref-name rules before creating or checking out a branch, rejecting names containing invalid characters.
