// ---------------------------------------------------------------------------
// GitControllerAdapter — adapters/git/git-controller-adapter.ts
//
// Implements IGitController by delegating all local git CLI operations to
// IToolExecutor. Never calls child_process or git SDKs directly.
// ---------------------------------------------------------------------------

import type { IToolExecutor } from "../../application/tools/executor";
import type { GitResult, IGitController } from "../../application/ports/git-controller";
import type { IGitValidator } from "../../domain/git/git-validator";
import type { BranchCreationResult, CommitResult, GitChangesResult, PushResult } from "../../domain/git/types";
import type { ToolError, ToolContext, ToolResult } from "../../domain/tools/types";
import {
  gitAddTool,
  gitBranchCreateTool,
  gitBranchListTool,
  gitBranchSwitchTool,
  gitCommitTool,
  gitPushTool,
  gitStatusTool,
  type GitAddOutput,
  type GitBranchCreateOutput,
  type GitBranchListOutput,
  type GitBranchSwitchOutput,
  type GitCommitOutput,
  type GitPushOutput,
  type GitStatusOutput,
} from "../tools/git";

export class GitControllerAdapter implements IGitController {
  constructor(
    private readonly executor: IToolExecutor,
    private readonly validator: IGitValidator,
    private readonly context: ToolContext,
    private readonly protectedFilePatterns: ReadonlyArray<string>,
  ) {}

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Returns a permission error result if gitWrite is false, otherwise null. */
  private requireGitWrite(operation: string): { ok: false; error: ToolError } | null {
    if (!this.context.permissions.gitWrite) {
      return {
        ok: false,
        error: { type: "permission", message: `gitWrite permission is required to ${operation}` },
      };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // listBranches
  // ---------------------------------------------------------------------------

  async listBranches(): Promise<GitResult<ReadonlyArray<string>>> {
    const result = (await this.executor.invoke(
      gitBranchListTool.name,
      {},
      this.context,
    )) as ToolResult<GitBranchListOutput>;

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    return { ok: true, value: result.value.branches.map((b) => b.name) };
  }

  // ---------------------------------------------------------------------------
  // detectChanges
  // ---------------------------------------------------------------------------

  async detectChanges(): Promise<GitResult<GitChangesResult>> {
    const result = (await this.executor.invoke(
      gitStatusTool.name,
      {},
      this.context,
    )) as ToolResult<GitStatusOutput>;

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    return {
      ok: true,
      value: {
        staged: result.value.staged,
        unstaged: result.value.unstaged,
        untracked: result.value.untracked,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // createAndCheckoutBranch
  // ---------------------------------------------------------------------------

  async createAndCheckoutBranch(
    branchName: string,
    baseBranch: string,
  ): Promise<GitResult<BranchCreationResult>> {
    const permError = this.requireGitWrite("create a branch");
    if (permError) return permError;

    const createResult = (await this.executor.invoke(
      gitBranchCreateTool.name,
      { name: branchName },
      this.context,
    )) as ToolResult<GitBranchCreateOutput>;

    if (!createResult.ok) {
      return { ok: false, error: createResult.error };
    }

    const switchResult = (await this.executor.invoke(
      gitBranchSwitchTool.name,
      { name: branchName },
      this.context,
    )) as ToolResult<GitBranchSwitchOutput>;

    if (!switchResult.ok) {
      return { ok: false, error: switchResult.error };
    }

    return {
      ok: true,
      value: { branchName, baseBranch, conflictResolved: false },
    };
  }

  // ---------------------------------------------------------------------------
  // stageAndCommit
  // ---------------------------------------------------------------------------

  async stageAndCommit(
    files: ReadonlyArray<string>,
    message: string,
  ): Promise<GitResult<CommitResult>> {
    const permError = this.requireGitWrite("stage and commit");
    if (permError) return permError;

    // Protected file guard: reject the entire commit if any file is blocked
    const { safe, blocked } = this.validator.filterProtectedFiles(
      files,
      this.protectedFilePatterns,
    );

    if (blocked.length > 0) {
      return {
        ok: false,
        error: {
          type: "validation",
          message: `protected-file-detected: ${blocked.join(", ")}`,
          details: { blockedFiles: blocked },
        },
      };
    }

    const addResult = (await this.executor.invoke(
      gitAddTool.name,
      { files: safe },
      this.context,
    )) as ToolResult<GitAddOutput>;

    if (!addResult.ok) {
      return { ok: false, error: addResult.error };
    }

    const commitResult = (await this.executor.invoke(
      gitCommitTool.name,
      { message },
      this.context,
    )) as ToolResult<GitCommitOutput>;

    if (!commitResult.ok) {
      return { ok: false, error: commitResult.error };
    }

    return {
      ok: true,
      value: {
        hash: commitResult.value.hash,
        message,
        fileCount: files.length,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // push
  // ---------------------------------------------------------------------------

  async push(branchName: string, remote: string): Promise<GitResult<PushResult>> {
    const permError = this.requireGitWrite("push");
    if (permError) return permError;

    const result = (await this.executor.invoke(
      gitPushTool.name,
      { remote, branch: branchName },
      this.context,
    )) as ToolResult<GitPushOutput>;

    if (!result.ok) {
      // Non-fast-forward: git outputs "[rejected]" in the push error message
      if (result.error.message.includes("[rejected]")) {
        return {
          ok: false,
          error: {
            type: "runtime",
            message: result.error.message,
            details: { reason: "non-fast-forward" },
          },
        };
      }

      // Map permission-type errors and HTTP 403 responses to permission error
      if (result.error.type === "permission" || result.error.message.includes("403")) {
        return {
          ok: false,
          error: { type: "permission", message: result.error.message },
        };
      }

      return { ok: false, error: result.error };
    }

    return {
      ok: true,
      value: {
        remote,
        branchName,
        // Note: git_push tool does not return the HEAD commit hash.
        // The caller (GitIntegrationService) can enrich this from the CommitResult
        // produced by the preceding stageAndCommit operation.
        commitHash: "",
      },
    };
  }
}
