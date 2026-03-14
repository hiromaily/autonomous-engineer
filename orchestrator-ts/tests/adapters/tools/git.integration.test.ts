/**
 * Integration tests for git tools — exercises real git operations in a
 * temporary repository initialized for each test.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  gitAddTool,
  gitBranchCreateTool,
  gitBranchListTool,
  gitBranchSwitchTool,
  gitCommitTool,
  gitDiffTool,
  gitPushTool,
  gitStatusTool,
} from "../../../src/adapters/tools/git";
import { ToolExecutor } from "../../../src/application/tools/executor";
import { PermissionSystem } from "../../../src/domain/tools/permissions";
import { ToolRegistry } from "../../../src/domain/tools/registry";
import type { PermissionSet, ToolContext, ToolInvocationLog } from "../../../src/domain/tools/types";

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePermissions(overrides: Partial<PermissionSet> = {}): PermissionSet {
  return Object.freeze({
    filesystemRead: true,
    filesystemWrite: true,
    shellExecution: false,
    gitWrite: true,
    networkAccess: false,
    ...overrides,
  });
}

function makeLogger() {
  const logs: ToolInvocationLog[] = [];
  return {
    info: (e: ToolInvocationLog) => logs.push(e),
    error: (e: ToolInvocationLog) => logs.push(e),
    getLogs: () => logs,
  };
}

function makeContext(workspaceRoot: string, permissions: PermissionSet = makePermissions()): ToolContext {
  return {
    workspaceRoot,
    workingDirectory: workspaceRoot,
    permissions,
    memory: { search: async () => [] },
    logger: makeLogger(),
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, "init");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "Test User");
}

async function makeInitialCommit(dir: string): Promise<string> {
  await fsWriteFile(join(dir, "README.md"), "# test", "utf-8");
  await git(dir, "add", "README.md");
  await git(dir, "commit", "-m", "initial commit");
  return git(dir, "rev-parse", "HEAD");
}

function makeExecutor() {
  const registry = new ToolRegistry();
  const permSystem = new PermissionSystem();
  for (
    const tool of [
      gitStatusTool,
      gitDiffTool,
      gitCommitTool,
      gitBranchListTool,
      gitBranchCreateTool,
      gitBranchSwitchTool,
      gitAddTool,
      gitPushTool,
    ]
  ) {
    registry.register(tool as Parameters<typeof registry.register>[0]);
  }
  return new ToolExecutor(registry, permSystem, { defaultTimeoutMs: 5000, logMaxInputBytes: 256 });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let executor: ReturnType<typeof makeExecutor>;
const remoteDirs: string[] = [];

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "aes-git-integ-"));
  await initRepo(tmpDir);
  executor = makeExecutor();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  for (const remoteDir of remoteDirs) {
    await rm(remoteDir, { recursive: true, force: true });
  }
  remoteDirs.length = 0;
});

// ---------------------------------------------------------------------------
// git_status
// ---------------------------------------------------------------------------

describe("git_status", () => {
  it("returns empty lists in a clean repository after initial commit", async () => {
    await makeInitialCommit(tmpDir);
    const ctx = makeContext(tmpDir);
    const result = await gitStatusTool.execute({}, ctx);

    expect(result.staged).toEqual([]);
    expect(result.unstaged).toEqual([]);
    expect(result.untracked).toEqual([]);
  });

  it("returns untracked files", async () => {
    await makeInitialCommit(tmpDir);
    await fsWriteFile(join(tmpDir, "new.ts"), "export {}", "utf-8");
    const ctx = makeContext(tmpDir);
    const result = await gitStatusTool.execute({}, ctx);

    expect(result.untracked).toContain("new.ts");
  });

  it("returns staged files after git add", async () => {
    await makeInitialCommit(tmpDir);
    await fsWriteFile(join(tmpDir, "staged.ts"), "export {}", "utf-8");
    await git(tmpDir, "add", "staged.ts");
    const ctx = makeContext(tmpDir);
    const result = await gitStatusTool.execute({}, ctx);

    expect(result.staged).toContain("staged.ts");
  });

  it("returns unstaged files after modifying a tracked file", async () => {
    await makeInitialCommit(tmpDir);
    await fsWriteFile(join(tmpDir, "README.md"), "# modified", "utf-8");
    const ctx = makeContext(tmpDir);
    const result = await gitStatusTool.execute({}, ctx);

    expect(result.unstaged).toContain("README.md");
  });

  it("uses workingDirectory as git cwd", async () => {
    await makeInitialCommit(tmpDir);
    // If git ran in the wrong directory it would throw; getting here means cwd is correct
    const ctx = makeContext(tmpDir);
    await expect(gitStatusTool.execute({}, ctx)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// git_diff
// ---------------------------------------------------------------------------

describe("git_diff", () => {
  it("returns empty string when there are no changes", async () => {
    await makeInitialCommit(tmpDir);
    const ctx = makeContext(tmpDir);
    const result = await gitDiffTool.execute({}, ctx);

    expect(result.diff).toBe("");
  });

  it("returns diff content for unstaged modifications", async () => {
    await makeInitialCommit(tmpDir);
    await fsWriteFile(join(tmpDir, "README.md"), "# modified content", "utf-8");
    const ctx = makeContext(tmpDir);
    const result = await gitDiffTool.execute({}, ctx);

    expect(result.diff).toContain("README.md");
    expect(result.diff).toContain("modified content");
  });

  it("returns staged diff when staged=true", async () => {
    await makeInitialCommit(tmpDir);
    await fsWriteFile(join(tmpDir, "staged.ts"), "staged content", "utf-8");
    await git(tmpDir, "add", "staged.ts");
    const ctx = makeContext(tmpDir);
    const result = await gitDiffTool.execute({ staged: true }, ctx);

    expect(result.diff).toContain("staged.ts");
    expect(result.diff).toContain("staged content");
  });

  it("returns empty string for staged when nothing is staged", async () => {
    await makeInitialCommit(tmpDir);
    const ctx = makeContext(tmpDir);
    const result = await gitDiffTool.execute({ staged: true }, ctx);

    expect(result.diff).toBe("");
  });
});

// ---------------------------------------------------------------------------
// git_commit
// ---------------------------------------------------------------------------

describe("git_commit", () => {
  it("creates a commit and returns a valid hash", async () => {
    await makeInitialCommit(tmpDir);
    await fsWriteFile(join(tmpDir, "feature.ts"), "export const x = 1;", "utf-8");
    await git(tmpDir, "add", "feature.ts");

    const ctx = makeContext(tmpDir);
    const result = await gitCommitTool.execute({ message: "add feature" }, ctx);

    expect(result.hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("commit hash matches HEAD after commit", async () => {
    await makeInitialCommit(tmpDir);
    await fsWriteFile(join(tmpDir, "b.ts"), "", "utf-8");
    await git(tmpDir, "add", "b.ts");

    const ctx = makeContext(tmpDir);
    const result = await gitCommitTool.execute({ message: "add b" }, ctx);
    const head = await git(tmpDir, "rev-parse", "HEAD");

    expect(result.hash).toBe(head);
  });

  it("returns gitWrite in requiredPermissions", () => {
    expect(gitCommitTool.requiredPermissions).toContain("gitWrite");
  });
});

// ---------------------------------------------------------------------------
// git_branch_list
// ---------------------------------------------------------------------------

describe("git_branch_list", () => {
  it("lists branches with current branch identified", async () => {
    await makeInitialCommit(tmpDir);
    const ctx = makeContext(tmpDir);
    const result = await gitBranchListTool.execute({}, ctx);

    expect(result.branches.length).toBeGreaterThan(0);
    const current = result.branches.find((b) => b.current);
    expect(current).toBeDefined();
  });

  it("includes a newly created branch", async () => {
    await makeInitialCommit(tmpDir);
    await git(tmpDir, "branch", "feature/test");
    const ctx = makeContext(tmpDir);
    const result = await gitBranchListTool.execute({}, ctx);

    const names = result.branches.map((b) => b.name);
    expect(names).toContain("feature/test");
  });

  it("requires no gitWrite permission", () => {
    expect(gitBranchListTool.requiredPermissions).not.toContain("gitWrite");
  });
});

// ---------------------------------------------------------------------------
// git_branch_create
// ---------------------------------------------------------------------------

describe("git_branch_create", () => {
  it("creates a new branch and returns its name", async () => {
    await makeInitialCommit(tmpDir);
    const ctx = makeContext(tmpDir);
    const result = await gitBranchCreateTool.execute({ name: "feature/new" }, ctx);

    expect(result.name).toBe("feature/new");
    const branches = await git(tmpDir, "branch");
    expect(branches).toContain("feature/new");
  });

  it("returns gitWrite in requiredPermissions", () => {
    expect(gitBranchCreateTool.requiredPermissions).toContain("gitWrite");
  });
});

// ---------------------------------------------------------------------------
// git_branch_switch
// ---------------------------------------------------------------------------

describe("git_branch_switch", () => {
  it("switches to an existing branch and returns its name", async () => {
    await makeInitialCommit(tmpDir);
    await git(tmpDir, "branch", "other-branch");

    const ctx = makeContext(tmpDir);
    const result = await gitBranchSwitchTool.execute({ name: "other-branch" }, ctx);

    expect(result.name).toBe("other-branch");
    const current = await git(tmpDir, "rev-parse", "--abbrev-ref", "HEAD");
    expect(current).toBe("other-branch");
  });

  it("returns gitWrite in requiredPermissions", () => {
    expect(gitBranchSwitchTool.requiredPermissions).toContain("gitWrite");
  });
});

// ---------------------------------------------------------------------------
// Full ToolExecutor pipeline integration tests
// ---------------------------------------------------------------------------

describe("git_status via ToolExecutor", () => {
  it("returns correct staged/unstaged/untracked lists through full pipeline", async () => {
    await makeInitialCommit(tmpDir);
    await fsWriteFile(join(tmpDir, "untracked.ts"), "", "utf-8");
    await fsWriteFile(join(tmpDir, "staged.ts"), "", "utf-8");
    await git(tmpDir, "add", "staged.ts");
    await fsWriteFile(join(tmpDir, "README.md"), "# changed", "utf-8");

    const ctx = makeContext(tmpDir);
    const result = await executor.invoke("git_status", {}, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const out = result.value as { staged: string[]; unstaged: string[]; untracked: string[] };
      expect(out.staged).toContain("staged.ts");
      expect(out.unstaged).toContain("README.md");
      expect(out.untracked).toContain("untracked.ts");
    }
  });

  it("emits a log entry on success", async () => {
    await makeInitialCommit(tmpDir);
    const logger = makeLogger();
    const ctx = { ...makeContext(tmpDir), logger };
    await executor.invoke("git_status", {}, ctx);

    expect(logger.getLogs().length).toBe(1);
    expect(logger.getLogs()[0]?.resultStatus).toBe("success");
  });
});

describe("git_commit via ToolExecutor", () => {
  it("creates a real commit and returns a valid hash through full pipeline", async () => {
    await makeInitialCommit(tmpDir);
    await fsWriteFile(join(tmpDir, "x.ts"), "x", "utf-8");
    await git(tmpDir, "add", "x.ts");

    const ctx = makeContext(tmpDir);
    const result = await executor.invoke("git_commit", { message: "pipeline test" }, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as { hash: string }).hash).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("returns permission error when gitWrite is absent", async () => {
    await makeInitialCommit(tmpDir);
    const ctx = makeContext(tmpDir, makePermissions({ gitWrite: false }));
    const result = await executor.invoke("git_commit", { message: "denied" }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("permission");
    }
  });
});

describe("git_branch_list via ToolExecutor", () => {
  it("returns all branches with current branch identified through full pipeline", async () => {
    await makeInitialCommit(tmpDir);
    await git(tmpDir, "branch", "side-branch");

    const ctx = makeContext(tmpDir);
    const result = await executor.invoke("git_branch_list", {}, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const out = result.value as { branches: Array<{ name: string; current: boolean }> };
      const names = out.branches.map((b) => b.name);
      expect(names).toContain("side-branch");
      expect(out.branches.some((b) => b.current)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// git_add
// ---------------------------------------------------------------------------

describe("git_add", () => {
  it("stages specified files and returns them in the staged list", async () => {
    await makeInitialCommit(tmpDir);
    await fsWriteFile(join(tmpDir, "a.ts"), "export const a = 1;", "utf-8");
    await fsWriteFile(join(tmpDir, "b.ts"), "export const b = 2;", "utf-8");

    const ctx = makeContext(tmpDir);
    const result = await gitAddTool.execute({ files: ["a.ts", "b.ts"] }, ctx);

    expect(result.staged).toContain("a.ts");
    expect(result.staged).toContain("b.ts");
  });

  it("staged files appear in git status after git_add", async () => {
    await makeInitialCommit(tmpDir);
    await fsWriteFile(join(tmpDir, "new.ts"), "x", "utf-8");

    const ctx = makeContext(tmpDir);
    await gitAddTool.execute({ files: ["new.ts"] }, ctx);
    const status = await gitStatusTool.execute({}, ctx);

    expect(status.staged).toContain("new.ts");
    expect(status.untracked).not.toContain("new.ts");
  });

  it("only stages the files specified, leaving others untracked", async () => {
    await makeInitialCommit(tmpDir);
    await fsWriteFile(join(tmpDir, "staged.ts"), "x", "utf-8");
    await fsWriteFile(join(tmpDir, "untracked.ts"), "y", "utf-8");

    const ctx = makeContext(tmpDir);
    await gitAddTool.execute({ files: ["staged.ts"] }, ctx);
    const status = await gitStatusTool.execute({}, ctx);

    expect(status.staged).toContain("staged.ts");
    expect(status.untracked).toContain("untracked.ts");
  });

  it("returns gitWrite in requiredPermissions", () => {
    expect(gitAddTool.requiredPermissions).toContain("gitWrite");
  });
});

describe("git_add via ToolExecutor", () => {
  it("stages files through full pipeline and returns staged list", async () => {
    await makeInitialCommit(tmpDir);
    await fsWriteFile(join(tmpDir, "pipeline.ts"), "x", "utf-8");

    const ctx = makeContext(tmpDir);
    const result = await executor.invoke("git_add", { files: ["pipeline.ts"] }, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const out = result.value as { staged: string[] };
      expect(out.staged).toContain("pipeline.ts");
    }
  });

  it("returns permission error when gitWrite is absent", async () => {
    await makeInitialCommit(tmpDir);
    await fsWriteFile(join(tmpDir, "denied.ts"), "x", "utf-8");
    const ctx = makeContext(tmpDir, makePermissions({ gitWrite: false }));
    const result = await executor.invoke("git_add", { files: ["denied.ts"] }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("permission");
    }
  });
});

// ---------------------------------------------------------------------------
// git_push
// ---------------------------------------------------------------------------

async function initBareRepo(dir: string): Promise<void> {
  await execFile("git", ["init", "--bare", dir]);
}

async function setupRepoWithRemote(): Promise<string> {
  const remoteDir = await mkdtemp(join(tmpdir(), "aes-git-remote-"));
  remoteDirs.push(remoteDir);
  await initBareRepo(remoteDir);
  await git(tmpDir, "remote", "add", "origin", remoteDir);
  return remoteDir;
}

describe("git_push", () => {
  it("pushes a branch to the remote and returns remote and branch", async () => {
    await makeInitialCommit(tmpDir);
    const remoteDir = await setupRepoWithRemote();

    const ctx = makeContext(tmpDir);
    const currentBranch = await git(tmpDir, "rev-parse", "--abbrev-ref", "HEAD");
    const result = await gitPushTool.execute({ remote: "origin", branch: currentBranch }, ctx);

    expect(result.remote).toBe("origin");
    expect(result.branch).toBe(currentBranch);

    // Verify the remote actually received the commit
    const remoteHead = await git(remoteDir, "rev-parse", "HEAD");
    const localHead = await git(tmpDir, "rev-parse", "HEAD");
    expect(remoteHead).toBe(localHead);
  });

  it("returns gitWrite in requiredPermissions", () => {
    expect(gitPushTool.requiredPermissions).toContain("gitWrite");
  });

  it("never accepts a --force flag (tool definition has no force option)", () => {
    // The schema input properties must not include 'force'
    const inputProps = gitPushTool.schema.input.properties as Record<string, unknown>;
    expect(inputProps).not.toHaveProperty("force");
  });

  it("returns a runtime error on non-fast-forward rejection", async () => {
    await makeInitialCommit(tmpDir);
    const remoteDir = await setupRepoWithRemote();
    const currentBranch = await git(tmpDir, "rev-parse", "--abbrev-ref", "HEAD");

    // Push initial commit to remote
    const ctx = makeContext(tmpDir);
    await gitPushTool.execute({ remote: "origin", branch: currentBranch }, ctx);

    // Create a second clone, add a commit, and push to advance the remote
    const clone2 = await mkdtemp(join(tmpdir(), "aes-git-clone2-"));
    try {
      await execFile("git", ["clone", remoteDir, clone2]);
      await execFile("git", ["config", "user.email", "test@example.com"], { cwd: clone2 });
      await execFile("git", ["config", "user.name", "Test User"], { cwd: clone2 });
      await fsWriteFile(join(clone2, "clone2.ts"), "x", "utf-8");
      await execFile("git", ["add", "clone2.ts"], { cwd: clone2 });
      await execFile("git", ["commit", "-m", "clone2 commit"], { cwd: clone2 });
      await execFile("git", ["push", "origin", currentBranch], { cwd: clone2 });
    } finally {
      await rm(clone2, { recursive: true, force: true });
    }

    // Now attempt to push from original dir — should fail (non-fast-forward)
    await fsWriteFile(join(tmpDir, "extra.ts"), "y", "utf-8");
    await git(tmpDir, "add", "extra.ts");
    await git(tmpDir, "commit", "-m", "extra commit");

    const result = await executor.invoke("git_push", { remote: "origin", branch: currentBranch }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("runtime");
    }
  });
});

describe("git_push via ToolExecutor", () => {
  it("pushes branch through full pipeline and returns remote and branch", async () => {
    await makeInitialCommit(tmpDir);
    await setupRepoWithRemote();
    const currentBranch = await git(tmpDir, "rev-parse", "--abbrev-ref", "HEAD");

    const ctx = makeContext(tmpDir);
    const result = await executor.invoke("git_push", { remote: "origin", branch: currentBranch }, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const out = result.value as { remote: string; branch: string };
      expect(out.remote).toBe("origin");
      expect(out.branch).toBe(currentBranch);
    }
  });

  it("returns permission error when gitWrite is absent", async () => {
    await makeInitialCommit(tmpDir);
    const ctx = makeContext(tmpDir, makePermissions({ gitWrite: false }));
    const result = await executor.invoke("git_push", { remote: "origin", branch: "main" }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("permission");
    }
  });
});

// ---------------------------------------------------------------------------
// Git error cases — typed runtime errors
// ---------------------------------------------------------------------------

describe("git errors produce typed runtime errors", () => {
  it("git_branch_switch to a non-existent branch yields a runtime error", async () => {
    await makeInitialCommit(tmpDir);
    const ctx = makeContext(tmpDir);
    const result = await executor.invoke("git_branch_switch", { name: "does-not-exist" }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("runtime");
    }
  });

  it("git_commit with nothing staged yields a runtime error", async () => {
    await makeInitialCommit(tmpDir);
    const ctx = makeContext(tmpDir);
    const result = await executor.invoke("git_commit", { message: "empty commit" }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("runtime");
    }
  });

  it("git_branch_create with a duplicate name yields a runtime error", async () => {
    await makeInitialCommit(tmpDir);
    await git(tmpDir, "branch", "existing");
    const ctx = makeContext(tmpDir);
    const result = await executor.invoke("git_branch_create", { name: "existing" }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("runtime");
    }
  });
});
