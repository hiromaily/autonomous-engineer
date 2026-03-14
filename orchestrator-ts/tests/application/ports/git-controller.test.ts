import { describe, expect, it } from "bun:test";
import type { GitResult, IGitController } from "../../../application/ports/git-controller";
import type { BranchCreationResult, CommitResult, GitChangesResult, PushResult } from "../../../domain/git/types";
// ---------------------------------------------------------------------------
// Helper: build a minimal stub that satisfies IGitController
// ---------------------------------------------------------------------------

function makeController(
  overrides?: Partial<{
    listBranches: GitResult<ReadonlyArray<string>>;
    detectChanges: GitResult<GitChangesResult>;
    createAndCheckoutBranch: GitResult<BranchCreationResult>;
    stageAndCommit: GitResult<CommitResult>;
    push: GitResult<PushResult>;
  }>,
): IGitController {
  const ok = <T>(value: T): GitResult<T> => ({ ok: true, value });

  return {
    listBranches: async () => overrides?.listBranches ?? ok(["main", "agent/feature-1"]),
    detectChanges: async () =>
      overrides?.detectChanges
        ?? ok({ staged: [], unstaged: [], untracked: [] }),
    createAndCheckoutBranch: async (_branch, _base) =>
      overrides?.createAndCheckoutBranch
        ?? ok({ branchName: _branch, baseBranch: _base, conflictResolved: false }),
    stageAndCommit: async (_files, _msg) =>
      overrides?.stageAndCommit
        ?? ok({ hash: "abc123", message: _msg, fileCount: _files.length }),
    push: async (_branch, _remote) =>
      overrides?.push ?? ok({ remote: _remote, branchName: _branch, commitHash: "abc123" }),
  };
}

// ---------------------------------------------------------------------------
// GitResult discriminated union
// ---------------------------------------------------------------------------

describe("GitResult discriminated union", () => {
  it("narrows to value on ok: true", () => {
    const result: GitResult<string> = { ok: true, value: "hello" };
    if (result.ok) {
      expect(result.value).toBe("hello");
    } else {
      throw new Error("Expected ok: true");
    }
  });

  it("narrows to error on ok: false", () => {
    const result: GitResult<string> = { ok: false, error: { type: "runtime", message: "git failed" } };
    if (!result.ok) {
      expect(result.error.type).toBe("runtime");
      expect(result.error.message).toBe("git failed");
    } else {
      throw new Error("Expected ok: false");
    }
  });

  it("works with permission error type", () => {
    const result: GitResult<void> = {
      ok: false,
      error: { type: "permission", message: "gitWrite permission denied" },
    };
    if (!result.ok) {
      expect(result.error.type).toBe("permission");
    }
  });

  it("works with validation error type", () => {
    const result: GitResult<string> = {
      ok: false,
      error: { type: "validation", message: "invalid branch name" },
    };
    if (!result.ok) {
      expect(result.error.type).toBe("validation");
    }
  });
});

// ---------------------------------------------------------------------------
// IGitController contract via stub
// ---------------------------------------------------------------------------

describe("IGitController contract (stub implementation)", () => {
  it("listBranches() returns GitResult<ReadonlyArray<string>>", async () => {
    const controller = makeController();
    const result = await controller.listBranches();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.isArray(result.value)).toBe(true);
      expect(result.value).toContain("main");
    }
  });

  it("listBranches() can return permission error", async () => {
    const controller = makeController({
      listBranches: { ok: false, error: { type: "permission", message: "denied" } },
    });
    const result = await controller.listBranches();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe("permission");
  });

  it("detectChanges() returns GitResult<GitChangesResult>", async () => {
    const controller = makeController({
      detectChanges: {
        ok: true,
        value: {
          staged: ["src/index.ts"],
          unstaged: ["README.md"],
          untracked: ["new.ts"],
        },
      },
    });
    const result = await controller.detectChanges();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.staged).toContain("src/index.ts");
      expect(result.value.unstaged).toContain("README.md");
      expect(result.value.untracked).toContain("new.ts");
    }
  });

  it("detectChanges() returns empty arrays when working directory is clean", async () => {
    const controller = makeController();
    const result = await controller.detectChanges();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.staged).toHaveLength(0);
      expect(result.value.unstaged).toHaveLength(0);
      expect(result.value.untracked).toHaveLength(0);
    }
  });

  it("createAndCheckoutBranch() returns BranchCreationResult on success", async () => {
    const controller = makeController();
    const result = await controller.createAndCheckoutBranch("agent/my-feature", "main");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.branchName).toBe("agent/my-feature");
      expect(result.value.baseBranch).toBe("main");
      expect(result.value.conflictResolved).toBe(false);
    }
  });

  it("createAndCheckoutBranch() returns error on base branch missing", async () => {
    const controller = makeController({
      createAndCheckoutBranch: {
        ok: false,
        error: { type: "runtime", message: "base branch not found" },
      },
    });
    const result = await controller.createAndCheckoutBranch("agent/feature", "missing-base");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("base branch");
  });

  it("stageAndCommit() returns CommitResult on success", async () => {
    const controller = makeController();
    const result = await controller.stageAndCommit(["src/a.ts", "src/b.ts"], "feat: add files");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hash).toBe("abc123");
      expect(result.value.message).toBe("feat: add files");
      expect(result.value.fileCount).toBe(2);
    }
  });

  it("stageAndCommit() can return protected-file error", async () => {
    const controller = makeController({
      stageAndCommit: {
        ok: false,
        error: { type: "validation", message: "protected file detected: .env" },
      },
    });
    const result = await controller.stageAndCommit([".env"], "bad commit");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain(".env");
  });

  it("push() returns PushResult on success", async () => {
    const controller = makeController();
    const result = await controller.push("agent/my-feature", "origin");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.remote).toBe("origin");
      expect(result.value.branchName).toBe("agent/my-feature");
      expect(result.value.commitHash).toBeDefined();
    }
  });

  it("push() returns runtime error on non-fast-forward rejection", async () => {
    const controller = makeController({
      push: {
        ok: false,
        error: { type: "runtime", message: "! [rejected] agent/my-feature -> agent/my-feature (non-fast-forward)" },
      },
    });
    const result = await controller.push("agent/my-feature", "origin");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("[rejected]");
  });

  it("push() returns permission error when gitWrite is false", async () => {
    const controller = makeController({
      push: { ok: false, error: { type: "permission", message: "gitWrite permission denied" } },
    });
    const result = await controller.push("agent/feature", "origin");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe("permission");
  });
});
