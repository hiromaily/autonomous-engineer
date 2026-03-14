// ---------------------------------------------------------------------------
// IGitController port — application/ports/git-controller.ts
//
// Port contract defining all local git CLI operations.
// No implementation code — interface definitions only.
// ---------------------------------------------------------------------------

import type { BranchCreationResult, CommitResult, GitChangesResult, PushResult } from "../../domain/git/types";
import type { ToolError } from "../../domain/tools/types";

/**
 * Discriminated union result type for git controller operations.
 * Follows the same pattern as ToolResult<T> but scoped to git operations.
 */
export type GitResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ToolError };

/**
 * Port contract for all local git CLI operations.
 * Implemented by GitControllerAdapter in the adapter layer.
 * No direct child_process or git SDK calls are permitted in the application layer.
 */
export interface IGitController {
  /**
   * List existing local branches.
   */
  listBranches(): Promise<GitResult<ReadonlyArray<string>>>;

  /**
   * Check for staged/unstaged/untracked changes in the working directory.
   */
  detectChanges(): Promise<GitResult<GitChangesResult>>;

  /**
   * Create a new branch from baseBranch and check it out.
   * Preconditions: branchName passes GitValidator.isValidBranchName; working directory is clean.
   */
  createAndCheckoutBranch(branchName: string, baseBranch: string): Promise<GitResult<BranchCreationResult>>;

  /**
   * Stage the given files and create a commit with the provided message.
   * Protected files must be excluded by the caller before invoking this method.
   * Preconditions: files is non-empty; all paths are within workspaceRoot.
   */
  stageAndCommit(files: ReadonlyArray<string>, message: string): Promise<GitResult<CommitResult>>;

  /**
   * Push the local branch to the named remote.
   * Force push is never performed; non-fast-forward is surfaced as an error.
   */
  push(branchName: string, remote: string): Promise<GitResult<PushResult>>;
}
