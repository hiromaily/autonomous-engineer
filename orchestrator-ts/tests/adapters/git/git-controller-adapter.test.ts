import { describe, expect, it } from "bun:test";
import { GitControllerAdapter } from "../../../src/adapters/git/git-controller-adapter";
import type { IToolExecutor } from "../../../src/application/tools/executor";
import type { IGitValidator } from "../../../src/domain/git/git-validator";
import type { ToolContext, ToolResult } from "../../../src/domain/tools/types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type MockResults = Record<string, ToolResult<unknown>>;

function makeExecutor(
  results: MockResults = {},
): IToolExecutor & { calls: Array<{ name: string; input: unknown }> } {
  const calls: Array<{ name: string; input: unknown }> = [];
  return {
    calls,
    invoke: async (name: string, input: unknown, _ctx: ToolContext) => {
      calls.push({ name, input });
      if (name in results) return results[name] ?? { ok: false, error: { type: "runtime" as const, message: `No result for: ${name}` } };
      return { ok: false, error: { type: "runtime" as const, message: `Unexpected tool: ${name}` } };
    },
  };
}

function makeValidator(overrides?: Partial<IGitValidator>): IGitValidator {
  return {
    isValidBranchName: () => true,
    matchesProtectedPattern: () => false,
    isWithinWorkspace: () => true,
    filterProtectedFiles: (files) => ({ safe: files, blocked: [] }),
    ...overrides,
  };
}

function makeContext(gitWrite = true): ToolContext {
  return {
    workspaceRoot: "/workspace",
    workingDirectory: "/workspace",
    permissions: {
      filesystemRead: true,
      filesystemWrite: true,
      shellExecution: false,
      gitWrite,
      networkAccess: false,
    },
    memory: { search: async () => [] },
    logger: {
      info: () => {},
      error: () => {},
    },
  };
}

function makeAdapter(
  executor: IToolExecutor,
  validator: IGitValidator = makeValidator(),
  gitWrite = true,
  protectedPatterns: ReadonlyArray<string> = [],
): GitControllerAdapter {
  return new GitControllerAdapter(executor, validator, makeContext(gitWrite), protectedPatterns);
}

// ---------------------------------------------------------------------------
// listBranches
// ---------------------------------------------------------------------------

describe("GitControllerAdapter.listBranches()", () => {
  it("returns branch name strings from git_branch_list output", async () => {
    const executor = makeExecutor({
      git_branch_list: {
        ok: true,
        value: {
          branches: [
            { name: "main", current: true },
            { name: "agent/feature-1", current: false },
          ],
        },
      },
    });
    const adapter = makeAdapter(executor);
    const result = await adapter.listBranches();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(["main", "agent/feature-1"]);
    }
  });

  it("returns error when git_branch_list fails", async () => {
    const executor = makeExecutor({
      git_branch_list: { ok: false, error: { type: "runtime", message: "not a git repo" } },
    });
    const adapter = makeAdapter(executor);
    const result = await adapter.listBranches();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("not a git repo");
    }
  });

  it("returns empty array when no branches exist", async () => {
    const executor = makeExecutor({
      git_branch_list: { ok: true, value: { branches: [] } },
    });
    const adapter = makeAdapter(executor);
    const result = await adapter.listBranches();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// detectChanges
// ---------------------------------------------------------------------------

describe("GitControllerAdapter.detectChanges()", () => {
  it("returns GitChangesResult from git_status output", async () => {
    const executor = makeExecutor({
      git_status: {
        ok: true,
        value: {
          staged: ["src/index.ts"],
          unstaged: ["README.md"],
          untracked: ["new-file.ts"],
        },
      },
    });
    const adapter = makeAdapter(executor);
    const result = await adapter.detectChanges();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.staged).toEqual(["src/index.ts"]);
      expect(result.value.unstaged).toEqual(["README.md"]);
      expect(result.value.untracked).toEqual(["new-file.ts"]);
    }
  });

  it("returns empty arrays when working directory is clean", async () => {
    const executor = makeExecutor({
      git_status: { ok: true, value: { staged: [], unstaged: [], untracked: [] } },
    });
    const adapter = makeAdapter(executor);
    const result = await adapter.detectChanges();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.staged).toHaveLength(0);
      expect(result.value.unstaged).toHaveLength(0);
      expect(result.value.untracked).toHaveLength(0);
    }
  });

  it("returns error when git_status fails", async () => {
    const executor = makeExecutor({
      git_status: { ok: false, error: { type: "runtime", message: "git status failed" } },
    });
    const adapter = makeAdapter(executor);
    const result = await adapter.detectChanges();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("git status failed");
    }
  });
});

// ---------------------------------------------------------------------------
// createAndCheckoutBranch
// ---------------------------------------------------------------------------

describe("GitControllerAdapter.createAndCheckoutBranch()", () => {
  it("creates and checks out a branch on success", async () => {
    const executor = makeExecutor({
      git_branch_create: { ok: true, value: { name: "agent/my-feature" } },
      git_branch_switch: { ok: true, value: { name: "agent/my-feature" } },
    });
    const adapter = makeAdapter(executor);
    const result = await adapter.createAndCheckoutBranch("agent/my-feature", "main");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.branchName).toBe("agent/my-feature");
      expect(result.value.baseBranch).toBe("main");
      expect(result.value.conflictResolved).toBe(false);
    }
  });

  it("calls git_branch_create with correct branch name", async () => {
    const executor = makeExecutor({
      git_branch_create: { ok: true, value: { name: "agent/test" } },
      git_branch_switch: { ok: true, value: { name: "agent/test" } },
    });
    const adapter = makeAdapter(executor);
    await adapter.createAndCheckoutBranch("agent/test", "main");
    const createCall = executor.calls.find(c => c.name === "git_branch_create");
    expect(createCall?.input).toEqual({ name: "agent/test" });
  });

  it("returns permission error when gitWrite is false", async () => {
    const executor = makeExecutor();
    const adapter = makeAdapter(executor, makeValidator(), false);
    const result = await adapter.createAndCheckoutBranch("agent/feature", "main");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("permission");
    }
    expect(executor.calls).toHaveLength(0);
  });

  it("returns error when git_branch_create fails", async () => {
    const executor = makeExecutor({
      git_branch_create: {
        ok: false,
        error: { type: "runtime", message: "branch already exists: agent/feature" },
      },
    });
    const adapter = makeAdapter(executor);
    const result = await adapter.createAndCheckoutBranch("agent/feature", "main");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("branch already exists");
    }
  });

  it("returns error when git_branch_switch fails without calling additional tools", async () => {
    const executor = makeExecutor({
      git_branch_create: { ok: true, value: { name: "agent/feature" } },
      git_branch_switch: {
        ok: false,
        error: { type: "runtime", message: "pathspec 'agent/feature' did not match" },
      },
    });
    const adapter = makeAdapter(executor);
    const result = await adapter.createAndCheckoutBranch("agent/feature", "main");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("pathspec");
    }
  });
});

// ---------------------------------------------------------------------------
// stageAndCommit
// ---------------------------------------------------------------------------

describe("GitControllerAdapter.stageAndCommit()", () => {
  it("stages safe files and commits on success", async () => {
    const executor = makeExecutor({
      git_add: { ok: true, value: { staged: ["src/a.ts", "src/b.ts"] } },
      git_commit: { ok: true, value: { hash: "abc123" } },
    });
    const adapter = makeAdapter(executor);
    const result = await adapter.stageAndCommit(["src/a.ts", "src/b.ts"], "feat: add files");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hash).toBe("abc123");
      expect(result.value.message).toBe("feat: add files");
      expect(result.value.fileCount).toBe(2);
    }
  });

  it("calls git_add with safe files list", async () => {
    const executor = makeExecutor({
      git_add: { ok: true, value: { staged: ["src/a.ts"] } },
      git_commit: { ok: true, value: { hash: "def456" } },
    });
    const adapter = makeAdapter(executor);
    await adapter.stageAndCommit(["src/a.ts"], "fix: something");
    const addCall = executor.calls.find(c => c.name === "git_add");
    expect(addCall?.input).toEqual({ files: ["src/a.ts"] });
  });

  it("returns validation error when protected files are present", async () => {
    const validator = makeValidator({
      filterProtectedFiles: () => ({
        safe: ["src/index.ts"],
        blocked: [".env", "secrets.key"],
      }),
    });
    const executor = makeExecutor();
    const adapter = makeAdapter(executor, validator, true, ["*.env", "*.key"]);
    const result = await adapter.stageAndCommit(["src/index.ts", ".env", "secrets.key"], "bad commit");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("validation");
      expect(result.error.message).toContain(".env");
    }
    // Ensure git_add was NOT called
    expect(executor.calls.find(c => c.name === "git_add")).toBeUndefined();
  });

  it("returns permission error when gitWrite is false", async () => {
    const executor = makeExecutor();
    const adapter = makeAdapter(executor, makeValidator(), false);
    const result = await adapter.stageAndCommit(["src/a.ts"], "feat: add");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("permission");
    }
    expect(executor.calls).toHaveLength(0);
  });

  it("returns error when git_add fails", async () => {
    const executor = makeExecutor({
      git_add: { ok: false, error: { type: "runtime", message: "pathspec not found" } },
    });
    const adapter = makeAdapter(executor);
    const result = await adapter.stageAndCommit(["missing.ts"], "feat: add missing");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("pathspec not found");
    }
  });

  it("returns error when git_commit fails", async () => {
    const executor = makeExecutor({
      git_add: { ok: true, value: { staged: ["src/a.ts"] } },
      git_commit: { ok: false, error: { type: "runtime", message: "nothing to commit" } },
    });
    const adapter = makeAdapter(executor);
    const result = await adapter.stageAndCommit(["src/a.ts"], "test commit");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("nothing to commit");
    }
  });
});

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

describe("GitControllerAdapter.push()", () => {
  it("returns PushResult on successful push", async () => {
    const executor = makeExecutor({
      git_push: { ok: true, value: { remote: "origin", branch: "agent/my-feature" } },
    });
    const adapter = makeAdapter(executor);
    const result = await adapter.push("agent/my-feature", "origin");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.remote).toBe("origin");
      expect(result.value.branchName).toBe("agent/my-feature");
      expect(typeof result.value.commitHash).toBe("string");
    }
  });

  it("calls git_push with correct remote and branch", async () => {
    const executor = makeExecutor({
      git_push: { ok: true, value: { remote: "upstream", branch: "agent/feat" } },
    });
    const adapter = makeAdapter(executor);
    await adapter.push("agent/feat", "upstream");
    const pushCall = executor.calls.find(c => c.name === "git_push");
    expect(pushCall?.input).toEqual({ remote: "upstream", branch: "agent/feat" });
  });

  it("returns permission error when gitWrite is false", async () => {
    const executor = makeExecutor();
    const adapter = makeAdapter(executor, makeValidator(), false);
    const result = await adapter.push("agent/feature", "origin");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("permission");
    }
    expect(executor.calls).toHaveLength(0);
  });

  it("classifies [rejected] error as non-fast-forward with runtime type", async () => {
    const executor = makeExecutor({
      git_push: {
        ok: false,
        error: {
          type: "runtime",
          message: "! [rejected] agent/feature -> agent/feature (non-fast-forward)",
        },
      },
    });
    const adapter = makeAdapter(executor);
    const result = await adapter.push("agent/feature", "origin");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("runtime");
      expect(result.error.message).toContain("[rejected]");
    }
  });

  it("maps permission-type tool error to permission GitResult error", async () => {
    const executor = makeExecutor({
      git_push: {
        ok: false,
        error: { type: "permission", message: "gitWrite permission denied" },
      },
    });
    const adapter = makeAdapter(executor);
    const result = await adapter.push("agent/feature", "origin");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("permission");
    }
  });

  it("maps 403 error message to permission error", async () => {
    const executor = makeExecutor({
      git_push: {
        ok: false,
        error: { type: "runtime", message: "remote: Permission to repo.git denied (403)" },
      },
    });
    const adapter = makeAdapter(executor);
    const result = await adapter.push("agent/feature", "origin");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("permission");
    }
  });

  it("passes through other runtime errors unchanged", async () => {
    const executor = makeExecutor({
      git_push: {
        ok: false,
        error: { type: "runtime", message: "network error: connection refused" },
      },
    });
    const adapter = makeAdapter(executor);
    const result = await adapter.push("agent/feature", "origin");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("runtime");
      expect(result.error.message).toContain("network error");
    }
  });
});
