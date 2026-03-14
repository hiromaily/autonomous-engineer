// ---------------------------------------------------------------------------
// GitIntegrationService — application/git/git-integration-service.ts
//
// Orchestrates the full git workflow: branch creation, commit automation,
// remote push, and PR creation. Depends on injected ports only; never calls
// child_process, fetch, or git SDKs directly.
// ---------------------------------------------------------------------------

import type { IAuditLogger } from "../safety/ports";
import type { LlmProviderPort } from "../ports/llm";
import type { IGitController, GitResult } from "../ports/git-controller";
import type { IGitEventBus } from "../ports/git-event-bus";
import type { IPullRequestProvider } from "../ports/pr-provider";
import type { IGitValidator } from "../../domain/git/git-validator";
import type { PermissionSet } from "../../domain/tools/types";
import type {
  BranchCreationResult,
  CommitResult,
  GitIntegrationConfig,
  PullRequestParams,
  PullRequestResult,
  PushResult,
} from "../../domain/git/types";

// ---------------------------------------------------------------------------
// Public service contract types
// ---------------------------------------------------------------------------

export interface GitWorkflowParams {
  readonly specName: string;
  readonly taskTitle: string;
  readonly taskSlug: string;
  readonly specArtifactPath: string;
  readonly completedTasks: ReadonlyArray<string>;
  readonly isDraft: boolean;
}

export interface IGitIntegrationService {
  /**
   * Create an isolated feature branch for the given spec.
   * Derives candidate name as agent/<specName> or agent/<taskSlug>.
   * Appends a numeric suffix (-2 through -99) if the name already exists.
   * Preconditions: working directory must be clean.
   */
  createBranch(specName: string, taskSlug: string): Promise<GitResult<BranchCreationResult>>;

  /**
   * Detect changes, generate a commit message via LLM, and commit after safety checks.
   */
  generateAndCommit(specName: string, taskTitle: string): Promise<GitResult<CommitResult>>;

  /**
   * Push the current branch to the configured remote, enforcing protected-branch rules.
   */
  push(branchName: string): Promise<GitResult<PushResult>>;

  /**
   * Create or update a pull request for the feature branch.
   * Preconditions: permissions.networkAccess must be true.
   */
  createOrUpdatePullRequest(params: GitWorkflowParams): Promise<GitResult<PullRequestResult>>;

  /**
   * Execute the full workflow: createBranch → generateAndCommit → push → createOrUpdatePullRequest.
   * Halts and returns the first error encountered.
   */
  runFullWorkflow(params: GitWorkflowParams): Promise<GitResult<PullRequestResult>>;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type GitOperationType = "create-branch" | "commit" | "push" | "create-pr";

const CONSECUTIVE_FAILURE_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class GitIntegrationService implements IGitIntegrationService {
  /** Tracks consecutive failure counts per operation type. Resets to 0 on success. */
  private readonly consecutiveFailureCounts: Map<GitOperationType, number> = new Map();
  private iterationNumber = 0;

  constructor(
    private readonly gitController: IGitController,
    private readonly prProvider: IPullRequestProvider,
    private readonly llm: LlmProviderPort,
    private readonly eventBus: IGitEventBus,
    private readonly auditLogger: IAuditLogger,
    private readonly validator: IGitValidator,
    private readonly config: GitIntegrationConfig,
    private readonly sessionId: string = "default",
    private readonly permissions: PermissionSet | null = null,
  ) {}

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private getFailureCount(op: GitOperationType): number {
    return this.consecutiveFailureCounts.get(op) ?? 0;
  }

  /** Increments and returns the new count. */
  private incrementFailure(op: GitOperationType): number {
    const count = this.getFailureCount(op) + 1;
    this.consecutiveFailureCounts.set(op, count);
    return count;
  }

  private resetFailure(op: GitOperationType): void {
    this.consecutiveFailureCounts.set(op, 0);
  }

  /**
   * Emits `repeated-git-failure` when count reaches the threshold.
   * Called after incrementing; only emits at exactly the threshold to avoid
   * duplicate events on every subsequent failure.
   */
  private maybeEmitRepeatedFailure(op: GitOperationType, count: number): void {
    if (count >= CONSECUTIVE_FAILURE_THRESHOLD) {
      this.eventBus.emit({
        type: "repeated-git-failure",
        operation: op,
        attemptCount: count,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // createBranch — Task 5.1
  // ---------------------------------------------------------------------------

  async createBranch(specName: string, taskSlug: string): Promise<GitResult<BranchCreationResult>> {
    // Derive candidate branch name
    const candidateName = specName ? `agent/${specName}` : `agent/${taskSlug}`;

    // Validate the candidate name before any I/O
    if (!this.validator.isValidBranchName(candidateName)) {
      return {
        ok: false,
        error: {
          type: "validation",
          message: `Invalid branch name: ${candidateName}`,
        },
      };
    }

    // Verify clean working directory
    const changesResult = await this.gitController.detectChanges();
    if (!changesResult.ok) {
      return changesResult;
    }
    const { staged, unstaged, untracked } = changesResult.value;
    if (staged.length > 0 || unstaged.length > 0 || untracked.length > 0) {
      return {
        ok: false,
        error: {
          type: "validation",
          message: "dirty-working-directory: working directory has uncommitted changes",
        },
      };
    }

    // Resolve branch name collision: append numeric suffix -2 through -99
    const branchesResult = await this.gitController.listBranches();
    if (!branchesResult.ok) {
      return branchesResult;
    }

    const existingBranches = new Set(branchesResult.value);
    let finalName = candidateName;
    let conflictResolved = false;

    if (existingBranches.has(candidateName)) {
      conflictResolved = true;
      let resolved = false;
      for (let suffix = 2; suffix <= 99; suffix++) {
        const candidate = `${candidateName}-${suffix}`;
        if (this.validator.isValidBranchName(candidate) && !existingBranches.has(candidate)) {
          finalName = candidate;
          resolved = true;
          break;
        }
      }
      if (!resolved) {
        const failCount = this.incrementFailure("create-branch");
        this.maybeEmitRepeatedFailure("create-branch", failCount);
        return {
          ok: false,
          error: {
            type: "runtime",
            message: `Could not resolve branch name collision for ${candidateName}: all suffixes -2 through -99 are taken`,
          },
        };
      }
    }

    // Create and checkout the branch via the controller adapter
    const createResult = await this.gitController.createAndCheckoutBranch(finalName, this.config.baseBranch);
    if (!createResult.ok) {
      const failCount = this.incrementFailure("create-branch");
      this.maybeEmitRepeatedFailure("create-branch", failCount);
      return createResult;
    }

    // Success path: reset counter, emit event, write audit entry
    this.resetFailure("create-branch");
    const timestamp = new Date().toISOString();

    this.eventBus.emit({
      type: "branch-created",
      branchName: finalName,
      baseBranch: this.config.baseBranch,
      timestamp,
    });

    this.iterationNumber++;
    await this.auditLogger.write({
      timestamp,
      sessionId: this.sessionId,
      iterationNumber: this.iterationNumber,
      toolName: "create-branch",
      inputSummary: `branch=${finalName}, base=${this.config.baseBranch}`,
      outcome: "success",
    });

    return {
      ok: true,
      value: {
        branchName: finalName,
        baseBranch: this.config.baseBranch,
        conflictResolved,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // generateAndCommit — Task 5.2
  // ---------------------------------------------------------------------------

  async generateAndCommit(specName: string, taskTitle: string): Promise<GitResult<CommitResult>> {
    // 1. Detect changes
    const changesResult = await this.gitController.detectChanges();
    if (!changesResult.ok) {
      const failCount = this.incrementFailure("commit");
      this.maybeEmitRepeatedFailure("commit", failCount);
      return changesResult;
    }

    const { staged, unstaged, untracked } = changesResult.value;
    const allFiles = [...staged, ...unstaged, ...untracked];

    // 2. If no changes, emit no-changes-to-commit and return Ok(skipped)
    if (allFiles.length === 0) {
      this.eventBus.emit({ type: "no-changes-to-commit", timestamp: new Date().toISOString() });
      return { ok: true, value: { hash: "", message: "", fileCount: 0 } };
    }

    // 3. Filter protected files from all changed files
    const { safe, blocked } = this.validator.filterProtectedFiles(allFiles, this.config.protectedFilePatterns);

    if (blocked.length > 0) {
      this.eventBus.emit({
        type: "protected-file-detected",
        files: blocked,
        timestamp: new Date().toISOString(),
      });
      const failCount = this.incrementFailure("commit");
      this.maybeEmitRepeatedFailure("commit", failCount);
      return {
        ok: false,
        error: { type: "validation", message: `protected-file-detected: ${blocked.join(", ")}` },
      };
    }

    // 4. Validate file count BEFORE LLM call
    if (safe.length > this.config.maxFilesPerCommit) {
      this.eventBus.emit({
        type: "commit-size-limit-exceeded",
        fileCount: safe.length,
        maxAllowed: this.config.maxFilesPerCommit,
        timestamp: new Date().toISOString(),
      });
      const failCount = this.incrementFailure("commit");
      this.maybeEmitRepeatedFailure("commit", failCount);
      return {
        ok: false,
        error: {
          type: "validation",
          message: `commit-size-limit-exceeded: ${safe.length} files exceeds maximum of ${this.config.maxFilesPerCommit}`,
        },
      };
    }

    // 5. Build diff summary and truncate to maxDiffTokens
    const diffContent = this.buildDiffSummary(staged, unstaged, untracked);
    const truncatedDiff = this.truncateToTokens(diffContent, this.config.maxDiffTokens);

    // 6. Invoke LLM to generate commit message
    const prompt = this.buildCommitPrompt(specName, taskTitle, truncatedDiff);
    const llmResult = await this.llm.complete(prompt);

    if (!llmResult.ok) {
      const failCount = this.incrementFailure("commit");
      this.maybeEmitRepeatedFailure("commit", failCount);
      return {
        ok: false,
        error: { type: "runtime", message: `LLM failed to generate commit message: ${llmResult.error.message}` },
      };
    }

    // 7. Truncate subject line to 72 characters
    const message = this.truncateSubjectLine(llmResult.value.content.trim());

    // 8. Stage and commit with safe files
    const commitResult = await this.gitController.stageAndCommit(safe, message);

    if (!commitResult.ok) {
      const failCount = this.incrementFailure("commit");
      this.maybeEmitRepeatedFailure("commit", failCount);
      return commitResult;
    }

    // 9. Success path: reset counter, emit event, write audit entry
    this.resetFailure("commit");
    const timestamp = new Date().toISOString();

    this.eventBus.emit({
      type: "commit-created",
      hash: commitResult.value.hash,
      message: commitResult.value.message,
      fileCount: commitResult.value.fileCount,
      timestamp,
    });

    this.iterationNumber++;
    await this.auditLogger.write({
      timestamp,
      sessionId: this.sessionId,
      iterationNumber: this.iterationNumber,
      toolName: "commit",
      inputSummary: `files=${safe.length}, specName=${specName}`,
      outcome: "success",
    });

    return { ok: true, value: commitResult.value };
  }

  // ---------------------------------------------------------------------------
  // Private helpers for generateAndCommit
  // ---------------------------------------------------------------------------

  /** Builds a text summary of changed files for use as LLM diff input. */
  private buildDiffSummary(
    staged: ReadonlyArray<string>,
    unstaged: ReadonlyArray<string>,
    untracked: ReadonlyArray<string>,
  ): string {
    const lines: string[] = ["Changed files:"];
    if (staged.length > 0) lines.push(`  staged:\n${staged.map((f) => `    ${f}`).join("\n")}`);
    if (unstaged.length > 0) lines.push(`  unstaged:\n${unstaged.map((f) => `    ${f}`).join("\n")}`);
    if (untracked.length > 0) lines.push(`  untracked:\n${untracked.map((f) => `    ${f}`).join("\n")}`);
    return lines.join("\n");
  }

  /**
   * Truncates content to approximately maxTokens tokens.
   * Uses a 1 token ≈ 4 character approximation.
   */
  private truncateToTokens(content: string, maxTokens: number): string {
    const maxChars = maxTokens * 4;
    if (content.length <= maxChars) return content;
    return content.slice(0, maxChars);
  }

  /** Builds the commit message prompt for the LLM. */
  private buildCommitPrompt(specName: string, taskTitle: string, diff: string): string {
    return [
      "Generate a concise git commit message for the following changes.",
      `Spec: ${specName}`,
      `Task: ${taskTitle}`,
      `Diff (truncated to ${this.config.maxDiffTokens} tokens):`,
      diff,
      "",
      "Output only the commit message, no other text. Subject line must be ≤72 characters.",
    ].join("\n");
  }

  /**
   * Truncates the subject line (first line) of a commit message to 72 characters.
   * Preserves any body lines after the first.
   */
  private truncateSubjectLine(message: string): string {
    const newlineIdx = message.indexOf("\n");
    if (newlineIdx === -1) {
      return message.slice(0, 72);
    }
    const subject = message.slice(0, newlineIdx).slice(0, 72);
    const body = message.slice(newlineIdx);
    return `${subject}${body}`;
  }

  // ---------------------------------------------------------------------------
  // push — Task 5.3
  // ---------------------------------------------------------------------------

  async push(branchName: string): Promise<GitResult<PushResult>> {
    // 1. Reject push to protected branches
    if (this.validator.matchesProtectedPattern(branchName, this.config.protectedBranches)) {
      this.eventBus.emit({
        type: "protected-branch-push-rejected",
        branchName,
        timestamp: new Date().toISOString(),
      });
      const failCount = this.incrementFailure("push");
      this.maybeEmitRepeatedFailure("push", failCount);
      return {
        ok: false,
        error: {
          type: "validation",
          message: `Push to protected branch rejected: ${branchName}`,
        },
      };
    }

    // 2. Call the adapter — force push is prohibited by the git_push tool (never adds --force)
    const pushResult = await this.gitController.push(branchName, this.config.remote);

    if (!pushResult.ok) {
      // Detect non-fast-forward rejection via the details field set by the adapter
      if (pushResult.error.details?.["reason"] === "non-fast-forward") {
        this.eventBus.emit({
          type: "push-rejected-non-fast-forward",
          remote: this.config.remote,
          branchName,
          timestamp: new Date().toISOString(),
        });
      }
      const failCount = this.incrementFailure("push");
      this.maybeEmitRepeatedFailure("push", failCount);
      return pushResult;
    }

    // 3. Success path: reset counter, emit event, write audit entry
    this.resetFailure("push");
    const timestamp = new Date().toISOString();

    this.eventBus.emit({
      type: "branch-pushed",
      remote: pushResult.value.remote,
      branchName: pushResult.value.branchName,
      commitHash: pushResult.value.commitHash,
      timestamp,
    });

    this.iterationNumber++;
    await this.auditLogger.write({
      timestamp,
      sessionId: this.sessionId,
      iterationNumber: this.iterationNumber,
      toolName: "push",
      inputSummary: `branch=${branchName}, remote=${this.config.remote}`,
      outcome: "success",
    });

    return { ok: true, value: pushResult.value };
  }

  // ---------------------------------------------------------------------------
  // createOrUpdatePullRequest — Task 5.4
  // ---------------------------------------------------------------------------

  async createOrUpdatePullRequest(params: GitWorkflowParams): Promise<GitResult<PullRequestResult>> {
    // 1. Verify networkAccess permission
    if (this.permissions !== null && !this.permissions.networkAccess) {
      return {
        ok: false,
        error: { type: "permission", message: "networkAccess permission is required to create a pull request" },
      };
    }

    // 2. Invoke LLM to generate PR title and body
    const prompt = this.buildPrPrompt(params);
    const llmResult = await this.llm.complete(prompt);

    if (!llmResult.ok) {
      const failCount = this.incrementFailure("create-pr");
      this.maybeEmitRepeatedFailure("create-pr", failCount);
      return {
        ok: false,
        error: { type: "runtime", message: `LLM failed to generate PR content: ${llmResult.error.message}` },
      };
    }

    // 3. Parse JSON response for { title, body }
    let prTitle: string;
    let prBody: string;
    try {
      const parsed = JSON.parse(llmResult.value.content.trim()) as Record<string, unknown>;
      prTitle = typeof parsed["title"] === "string" ? parsed["title"] : "";
      prBody = typeof parsed["body"] === "string" ? parsed["body"] : "";
      if (!prTitle) throw new Error("Missing title in LLM response");
    } catch {
      const failCount = this.incrementFailure("create-pr");
      this.maybeEmitRepeatedFailure("create-pr", failCount);
      return {
        ok: false,
        error: { type: "runtime", message: "Failed to parse PR title/body from LLM response" },
      };
    }

    // 4. Cap title at 72 characters
    prTitle = prTitle.slice(0, 72);

    // 5. Derive branch name (same pattern as createBranch)
    const branchName = params.specName ? `agent/${params.specName}` : `agent/${params.taskSlug}`;

    // 6. Construct PullRequestParams
    const prParams: PullRequestParams = {
      specName: params.specName,
      branchName,
      targetBranch: this.config.baseBranch,
      title: prTitle,
      body: prBody,
      isDraft: params.isDraft,
      specArtifactPath: params.specArtifactPath,
      completedTasks: params.completedTasks,
    };

    // 7. Call the PR provider
    const prResult = await this.prProvider.createOrUpdate(prParams);

    if (!prResult.ok) {
      // Emit auth failure event with guidance
      if (prResult.error.category === "auth") {
        this.eventBus.emit({
          type: "pr-creation-auth-failed",
          provider: "github",
          guidance: "Ensure a valid GitHub token is configured with 'repo' scope.",
          timestamp: new Date().toISOString(),
        });
      }
      const failCount = this.incrementFailure("create-pr");
      this.maybeEmitRepeatedFailure("create-pr", failCount);
      return {
        ok: false,
        error: { type: "runtime", message: prResult.error.message },
      };
    }

    // 8. Success: reset counter, emit event, write audit entry
    this.resetFailure("create-pr");
    const timestamp = new Date().toISOString();

    this.eventBus.emit({
      type: "pull-request-created",
      url: prResult.value.url,
      title: prResult.value.title,
      targetBranch: prResult.value.targetBranch,
      timestamp,
    });

    this.iterationNumber++;
    await this.auditLogger.write({
      timestamp,
      sessionId: this.sessionId,
      iterationNumber: this.iterationNumber,
      toolName: "create-pr",
      inputSummary: `specName=${params.specName}, branch=${branchName}`,
      outcome: "success",
    });

    return { ok: true, value: prResult.value };
  }

  // ---------------------------------------------------------------------------
  // Private helpers for createOrUpdatePullRequest
  // ---------------------------------------------------------------------------

  /** Builds the PR body prompt for the LLM. */
  private buildPrPrompt(params: GitWorkflowParams): string {
    const tasksSummary = params.completedTasks.join("\n- ");
    return [
      "Generate a GitHub pull request title (≤72 characters) and body for:",
      `Spec: ${params.specName}`,
      `Completed tasks:\n- ${tasksSummary}`,
      `Spec artifact path: ${params.specArtifactPath}`,
      "",
      'Output JSON only: {"title": "...", "body": "..."}',
    ].join("\n");
  }

  // ---------------------------------------------------------------------------
  // runFullWorkflow — Task 5.5
  // ---------------------------------------------------------------------------

  /**
   * Execute the full git workflow in sequence:
   *   createBranch → generateAndCommit → push → createOrUpdatePullRequest
   *
   * Halts and returns the first Err encountered; on all four stages completing
   * successfully, returns Ok(PullRequestResult).
   */
  async runFullWorkflow(params: GitWorkflowParams): Promise<GitResult<PullRequestResult>> {
    // Stage 1: Create feature branch
    const branchResult = await this.createBranch(params.specName, params.taskSlug);
    if (!branchResult.ok) return branchResult;

    // Stage 2: Generate commit message via LLM and commit changes
    const commitResult = await this.generateAndCommit(params.specName, params.taskTitle);
    if (!commitResult.ok) return commitResult;

    // Stage 3: Push the branch to the configured remote
    const pushResult = await this.push(branchResult.value.branchName);
    if (!pushResult.ok) return pushResult;

    // Stage 4: Create or update the pull request
    return this.createOrUpdatePullRequest(params);
  }
}
