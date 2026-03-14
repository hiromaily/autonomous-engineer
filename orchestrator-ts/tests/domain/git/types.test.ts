import { describe, expect, it } from "bun:test";
import type {
  BranchCreationResult,
  CommitResult,
  GitChangesResult,
  GitEvent,
  GitIntegrationConfig,
  PullRequestParams,
  PullRequestResult,
  PushResult,
} from "../../../domain/git/types";

// ---------------------------------------------------------------------------
// GitIntegrationConfig shape check
// ---------------------------------------------------------------------------

describe("GitIntegrationConfig shape", () => {
  it("accepts a valid config object", () => {
    const config: GitIntegrationConfig = {
      baseBranch: "main",
      remote: "origin",
      maxFilesPerCommit: 50,
      maxDiffTokens: 4096,
      protectedBranches: ["main", "master", "production", "release/*"],
      protectedFilePatterns: [".env", "secrets.json", "*.key", "*.pem"],
      forcePushEnabled: false,
      workspaceRoot: "/workspace",
      isDraft: false,
    };

    expect(config.baseBranch).toBe("main");
    expect(config.remote).toBe("origin");
    expect(config.maxFilesPerCommit).toBe(50);
    expect(config.maxDiffTokens).toBe(4096);
    expect(config.protectedBranches).toHaveLength(4);
    expect(config.protectedFilePatterns).toHaveLength(4);
    expect(config.forcePushEnabled).toBe(false);
    expect(config.workspaceRoot).toBe("/workspace");
    expect(config.isDraft).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Result type shapes
// ---------------------------------------------------------------------------

describe("GitChangesResult shape", () => {
  it("accepts a valid result with empty arrays", () => {
    const result: GitChangesResult = {
      staged: [],
      unstaged: [],
      untracked: [],
    };
    expect(result.staged).toHaveLength(0);
    expect(result.unstaged).toHaveLength(0);
    expect(result.untracked).toHaveLength(0);
  });

  it("accepts a result with file lists", () => {
    const result: GitChangesResult = {
      staged: ["src/index.ts"],
      unstaged: ["README.md"],
      untracked: ["new-file.ts"],
    };
    expect(result.staged).toContain("src/index.ts");
    expect(result.unstaged).toContain("README.md");
    expect(result.untracked).toContain("new-file.ts");
  });
});

describe("BranchCreationResult shape", () => {
  it("accepts a valid result", () => {
    const result: BranchCreationResult = {
      branchName: "agent/my-feature",
      baseBranch: "main",
      conflictResolved: false,
    };
    expect(result.branchName).toBe("agent/my-feature");
    expect(result.baseBranch).toBe("main");
    expect(result.conflictResolved).toBe(false);
  });

  it("accepts a conflict-resolved result", () => {
    const result: BranchCreationResult = {
      branchName: "agent/my-feature-2",
      baseBranch: "main",
      conflictResolved: true,
    };
    expect(result.conflictResolved).toBe(true);
  });
});

describe("CommitResult shape", () => {
  it("accepts a valid commit result", () => {
    const result: CommitResult = {
      hash: "abc123def456",
      message: "feat: implement git validator",
      fileCount: 3,
    };
    expect(result.hash).toBe("abc123def456");
    expect(result.message).toBe("feat: implement git validator");
    expect(result.fileCount).toBe(3);
  });
});

describe("PushResult shape", () => {
  it("accepts a valid push result", () => {
    const result: PushResult = {
      remote: "origin",
      branchName: "agent/my-feature",
      commitHash: "abc123",
    };
    expect(result.remote).toBe("origin");
    expect(result.branchName).toBe("agent/my-feature");
    expect(result.commitHash).toBe("abc123");
  });
});

describe("PullRequestResult shape", () => {
  it("accepts a valid PR result", () => {
    const result: PullRequestResult = {
      url: "https://github.com/owner/repo/pull/42",
      title: "feat: implement git integration",
      targetBranch: "main",
      isDraft: false,
    };
    expect(result.url).toContain("pull/42");
    expect(result.title).toBe("feat: implement git integration");
    expect(result.targetBranch).toBe("main");
    expect(result.isDraft).toBe(false);
  });
});

describe("PullRequestParams shape", () => {
  it("accepts a valid params object", () => {
    const params: PullRequestParams = {
      specName: "git-integration",
      branchName: "agent/git-integration",
      targetBranch: "main",
      title: "feat: add git integration",
      body: "## Summary\n- Implemented GitValidator",
      isDraft: true,
      specArtifactPath: ".kiro/specs/git-integration",
      completedTasks: ["1.1", "1.2"],
    };
    expect(params.specName).toBe("git-integration");
    expect(params.completedTasks).toHaveLength(2);
    expect(params.isDraft).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GitEvent discriminated union — all 11 variants
// ---------------------------------------------------------------------------

describe("GitEvent discriminated union", () => {
  it("narrows branch-created event correctly", () => {
    const event: GitEvent = {
      type: "branch-created",
      branchName: "agent/my-feature",
      baseBranch: "main",
      timestamp: "2026-03-14T00:00:00Z",
    };
    if (event.type === "branch-created") {
      expect(event.branchName).toBe("agent/my-feature");
      expect(event.baseBranch).toBe("main");
      expect(event.timestamp).toBe("2026-03-14T00:00:00Z");
    } else {
      throw new Error("Expected branch-created event");
    }
  });

  it("narrows commit-created event correctly", () => {
    const event: GitEvent = {
      type: "commit-created",
      hash: "abc123",
      message: "feat: add types",
      fileCount: 2,
      timestamp: "2026-03-14T00:00:00Z",
    };
    if (event.type === "commit-created") {
      expect(event.hash).toBe("abc123");
      expect(event.fileCount).toBe(2);
    } else {
      throw new Error("Expected commit-created event");
    }
  });

  it("narrows branch-pushed event correctly", () => {
    const event: GitEvent = {
      type: "branch-pushed",
      remote: "origin",
      branchName: "agent/my-feature",
      commitHash: "abc123",
      timestamp: "2026-03-14T00:00:00Z",
    };
    if (event.type === "branch-pushed") {
      expect(event.remote).toBe("origin");
      expect(event.commitHash).toBe("abc123");
    } else {
      throw new Error("Expected branch-pushed event");
    }
  });

  it("narrows pull-request-created event correctly", () => {
    const event: GitEvent = {
      type: "pull-request-created",
      url: "https://github.com/owner/repo/pull/1",
      title: "feat: implement git integration",
      targetBranch: "main",
      timestamp: "2026-03-14T00:00:00Z",
    };
    if (event.type === "pull-request-created") {
      expect(event.url).toContain("pull/1");
      expect(event.targetBranch).toBe("main");
    } else {
      throw new Error("Expected pull-request-created event");
    }
  });

  it("narrows commit-size-limit-exceeded event correctly", () => {
    const event: GitEvent = {
      type: "commit-size-limit-exceeded",
      fileCount: 75,
      maxAllowed: 50,
      timestamp: "2026-03-14T00:00:00Z",
    };
    if (event.type === "commit-size-limit-exceeded") {
      expect(event.fileCount).toBe(75);
      expect(event.maxAllowed).toBe(50);
    } else {
      throw new Error("Expected commit-size-limit-exceeded event");
    }
  });

  it("narrows no-changes-to-commit event correctly", () => {
    const event: GitEvent = {
      type: "no-changes-to-commit",
      timestamp: "2026-03-14T00:00:00Z",
    };
    if (event.type === "no-changes-to-commit") {
      expect(event.timestamp).toBeDefined();
    } else {
      throw new Error("Expected no-changes-to-commit event");
    }
  });

  it("narrows protected-file-detected event correctly", () => {
    const event: GitEvent = {
      type: "protected-file-detected",
      files: [".env", "secrets.json"],
      timestamp: "2026-03-14T00:00:00Z",
    };
    if (event.type === "protected-file-detected") {
      expect(event.files).toContain(".env");
      expect(event.files).toHaveLength(2);
    } else {
      throw new Error("Expected protected-file-detected event");
    }
  });

  it("narrows protected-branch-push-rejected event correctly", () => {
    const event: GitEvent = {
      type: "protected-branch-push-rejected",
      branchName: "main",
      timestamp: "2026-03-14T00:00:00Z",
    };
    if (event.type === "protected-branch-push-rejected") {
      expect(event.branchName).toBe("main");
    } else {
      throw new Error("Expected protected-branch-push-rejected event");
    }
  });

  it("narrows push-rejected-non-fast-forward event correctly", () => {
    const event: GitEvent = {
      type: "push-rejected-non-fast-forward",
      remote: "origin",
      branchName: "agent/my-feature",
      timestamp: "2026-03-14T00:00:00Z",
    };
    if (event.type === "push-rejected-non-fast-forward") {
      expect(event.remote).toBe("origin");
      expect(event.branchName).toBe("agent/my-feature");
    } else {
      throw new Error("Expected push-rejected-non-fast-forward event");
    }
  });

  it("narrows pr-creation-auth-failed event correctly", () => {
    const event: GitEvent = {
      type: "pr-creation-auth-failed",
      provider: "github",
      guidance: "Check your GITHUB_TOKEN environment variable",
      timestamp: "2026-03-14T00:00:00Z",
    };
    if (event.type === "pr-creation-auth-failed") {
      expect(event.provider).toBe("github");
      expect(event.guidance).toContain("GITHUB_TOKEN");
    } else {
      throw new Error("Expected pr-creation-auth-failed event");
    }
  });

  it("narrows repeated-git-failure event correctly", () => {
    const event: GitEvent = {
      type: "repeated-git-failure",
      operation: "commit",
      attemptCount: 3,
      timestamp: "2026-03-14T00:00:00Z",
    };
    if (event.type === "repeated-git-failure") {
      expect(event.operation).toBe("commit");
      expect(event.attemptCount).toBe(3);
    } else {
      throw new Error("Expected repeated-git-failure event");
    }
  });
});

// Compile-time exhaustive check: all 11 GitEvent variants must be handled
const _exhaustiveGitEventCheck = (event: GitEvent): string => {
  switch (event.type) {
    case "branch-created":
      return "branch-created";
    case "commit-created":
      return "commit-created";
    case "branch-pushed":
      return "branch-pushed";
    case "pull-request-created":
      return "pull-request-created";
    case "commit-size-limit-exceeded":
      return "commit-size-limit-exceeded";
    case "no-changes-to-commit":
      return "no-changes-to-commit";
    case "protected-file-detected":
      return "protected-file-detected";
    case "protected-branch-push-rejected":
      return "protected-branch-push-rejected";
    case "push-rejected-non-fast-forward":
      return "push-rejected-non-fast-forward";
    case "pr-creation-auth-failed":
      return "pr-creation-auth-failed";
    case "repeated-git-failure":
      return "repeated-git-failure";
  }
};
