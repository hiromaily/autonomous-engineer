// ---------------------------------------------------------------------------
// Git Integration Domain Types
// domain/git/types.ts
//
// Pure value types, result types, event union, and configuration.
// No I/O or mutable state permitted in this file.
// ---------------------------------------------------------------------------

export interface GitIntegrationConfig {
  readonly baseBranch: string;
  readonly remote: string;
  readonly maxFilesPerCommit: number;
  readonly maxDiffTokens: number;
  readonly protectedBranches: ReadonlyArray<string>;
  readonly protectedFilePatterns: ReadonlyArray<string>;
  readonly forcePushEnabled: boolean;
  readonly workspaceRoot: string;
  readonly isDraft: boolean;
}

export interface GitChangesResult {
  readonly staged: ReadonlyArray<string>;
  readonly unstaged: ReadonlyArray<string>;
  readonly untracked: ReadonlyArray<string>;
}

export interface BranchCreationResult {
  readonly branchName: string;
  readonly baseBranch: string;
  readonly conflictResolved: boolean;
}

export interface CommitResult {
  readonly hash: string;
  readonly message: string;
  readonly fileCount: number;
}

export interface PushResult {
  readonly remote: string;
  readonly branchName: string;
  readonly commitHash: string;
}

export interface PullRequestResult {
  readonly url: string;
  readonly title: string;
  readonly targetBranch: string;
  readonly isDraft: boolean;
}

export interface PullRequestParams {
  readonly specName: string;
  readonly branchName: string;
  readonly targetBranch: string;
  readonly title: string;
  readonly body: string;
  readonly isDraft: boolean;
  readonly specArtifactPath: string;
  readonly completedTasks: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// GitEvent — exhaustive 11-variant discriminated union
// Every variant carries a `timestamp: string` (ISO 8601 UTC).
// ---------------------------------------------------------------------------

export type GitEvent =
  | {
    readonly type: "branch-created";
    readonly branchName: string;
    readonly baseBranch: string;
    readonly timestamp: string;
  }
  | {
    readonly type: "commit-created";
    readonly hash: string;
    readonly message: string;
    readonly fileCount: number;
    readonly timestamp: string;
  }
  | {
    readonly type: "branch-pushed";
    readonly remote: string;
    readonly branchName: string;
    readonly commitHash: string;
    readonly timestamp: string;
  }
  | {
    readonly type: "pull-request-created";
    readonly url: string;
    readonly title: string;
    readonly targetBranch: string;
    readonly timestamp: string;
  }
  | {
    readonly type: "commit-size-limit-exceeded";
    readonly fileCount: number;
    readonly maxAllowed: number;
    readonly timestamp: string;
  }
  | { readonly type: "no-changes-to-commit"; readonly timestamp: string }
  | { readonly type: "protected-file-detected"; readonly files: ReadonlyArray<string>; readonly timestamp: string }
  | { readonly type: "protected-branch-push-rejected"; readonly branchName: string; readonly timestamp: string }
  | {
    readonly type: "push-rejected-non-fast-forward";
    readonly remote: string;
    readonly branchName: string;
    readonly timestamp: string;
  }
  | {
    readonly type: "pr-creation-auth-failed";
    readonly provider: string;
    readonly guidance: string;
    readonly timestamp: string;
  }
  | {
    readonly type: "repeated-git-failure";
    readonly operation: string;
    readonly attemptCount: number;
    readonly timestamp: string;
  };
