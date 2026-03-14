/**
 * Integration tests for GitControllerAdapter with real ToolExecutor
 *
 * Task 10.1: GitControllerAdapter integration with real git operations
 *
 * Integration scope:
 * - Real temporary git repository per test
 * - Real ToolExecutor with git tools registered
 * - Real GitValidator
 * - Real GitControllerAdapter
 * - Real GitIntegrationService (for branch collision resolution test)
 *
 * Requirements: 1.3, 1.5, 2.7, 3.4, 5.2
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { GitControllerAdapter } from "../../../src/adapters/git/git-controller-adapter";
import { GitIntegrationService } from "../../../src/application/git/git-integration-service";
import type { IAuditLogger } from "../../../src/application/safety/ports";
import type { LlmProviderPort } from "../../../src/application/ports/llm";
import type { IPullRequestProvider } from "../../../src/application/ports/pr-provider";
import { ToolExecutor } from "../../../src/application/tools/executor";
import { GitValidator } from "../../../src/domain/git/git-validator";
import type { GitIntegrationConfig } from "../../../src/domain/git/types";
import { PermissionSystem } from "../../../src/domain/tools/permissions";
import { ToolRegistry } from "../../../src/domain/tools/registry";
import type { PermissionSet, ToolContext, ToolInvocationLog } from "../../../src/domain/tools/types";
import { GitEventBus } from "../../../src/infra/events/git-event-bus";
import {
  gitAddTool,
  gitBranchCreateTool,
  gitBranchListTool,
  gitBranchSwitchTool,
  gitCommitTool,
  gitPushTool,
  gitStatusTool,
} from "../../../src/adapters/tools/git";

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Test infrastructure helpers
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

async function makeInitialCommit(dir: string): Promise<void> {
  await fsWriteFile(join(dir, "README.md"), "# test", "utf-8");
  await git(dir, "add", "README.md");
  await git(dir, "commit", "-m", "initial commit");
}

function makeExecutor() {
  const registry = new ToolRegistry();
  const permSystem = new PermissionSystem();
  for (const tool of [
    gitStatusTool,
    gitCommitTool,
    gitBranchListTool,
    gitBranchCreateTool,
    gitBranchSwitchTool,
    gitAddTool,
    gitPushTool,
  ]) {
    registry.register(tool as Parameters<typeof registry.register>[0]);
  }
  return new ToolExecutor(registry, permSystem, { defaultTimeoutMs: 5000, logMaxInputBytes: 256 });
}

function makeNoopAuditLogger(): IAuditLogger {
  return {
    write: async () => {},
    flush: async () => {},
  };
}

function makeNoopLlm(): LlmProviderPort {
  return {
    complete: async () => ({
      ok: true as const,
      value: { content: "feat: add new feature", usage: { inputTokens: 10, outputTokens: 5 } },
    }),
    clearContext: () => {},
  };
}

function makeNoopPrProvider(): IPullRequestProvider {
  return {
    createOrUpdate: async () => ({
      ok: true as const,
      value: { url: "https://github.com/owner/repo/pull/1", title: "feat: test", targetBranch: "main", isDraft: false },
    }),
  };
}

function makeConfig(workspaceRoot: string, overrides?: Partial<GitIntegrationConfig>): GitIntegrationConfig {
  return {
    baseBranch: "main",
    remote: "origin",
    maxFilesPerCommit: 50,
    maxDiffTokens: 4096,
    protectedBranches: ["main", "master"],
    protectedFilePatterns: [".env"],
    forcePushEnabled: false,
    workspaceRoot,
    isDraft: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Per-test setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let executor: ReturnType<typeof makeExecutor>;
const remoteDirs: string[] = [];

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "aes-git-ctrl-integ-"));
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

function makeAdapter(protectedPatterns: ReadonlyArray<string> = [".env"]): GitControllerAdapter {
  const validator = new GitValidator();
  const context = makeContext(tmpDir);
  return new GitControllerAdapter(executor, validator, context, protectedPatterns);
}

// ---------------------------------------------------------------------------
// Test 1: Branch creation collision resolution
// ---------------------------------------------------------------------------

describe("GitIntegrationService.createBranch with real GitControllerAdapter — collision resolution", () => {
  it("appends -2 suffix when the candidate branch name already exists", async () => {
    await makeInitialCommit(tmpDir);

    const validator = new GitValidator();
    const context = makeContext(tmpDir);
    const adapter = new GitControllerAdapter(executor, validator, context, []);
    const eventBus = new GitEventBus();
    const config = makeConfig(tmpDir);

    const service = new GitIntegrationService(
      adapter,
      makeNoopPrProvider(),
      makeNoopLlm(),
      eventBus,
      makeNoopAuditLogger(),
      validator,
      config,
    );

    // First call — creates "agent/my-spec"
    const first = await service.createBranch("my-spec", "my-task");
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.value.branchName).toBe("agent/my-spec");
      expect(first.value.conflictResolved).toBe(false);
    }

    // Second call from same state — "agent/my-spec" now exists, should append -2
    const second = await service.createBranch("my-spec", "my-task");
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.branchName).toBe("agent/my-spec-2");
      expect(second.value.conflictResolved).toBe(true);
    }

    // Verify both branches exist in the real git repository
    const branches = await git(tmpDir, "branch");
    expect(branches).toContain("agent/my-spec");
    expect(branches).toContain("agent/my-spec-2");
  });

  it("appends -3 suffix when both -2 and the original already exist", async () => {
    await makeInitialCommit(tmpDir);

    const validator = new GitValidator();
    const context = makeContext(tmpDir);
    const adapter = new GitControllerAdapter(executor, validator, context, []);
    const eventBus = new GitEventBus();
    const config = makeConfig(tmpDir);

    const service = new GitIntegrationService(
      adapter,
      makeNoopPrProvider(),
      makeNoopLlm(),
      eventBus,
      makeNoopAuditLogger(),
      validator,
      config,
    );

    // Create "agent/my-spec" and "agent/my-spec-2"
    const first = await service.createBranch("my-spec", "my-task");
    expect(first.ok).toBe(true);

    const second = await service.createBranch("my-spec", "my-task");
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.branchName).toBe("agent/my-spec-2");
    }

    // Third call — should use -3 suffix
    const third = await service.createBranch("my-spec", "my-task");
    expect(third.ok).toBe(true);
    if (third.ok) {
      expect(third.value.branchName).toBe("agent/my-spec-3");
    }

    const branches = await git(tmpDir, "branch");
    expect(branches).toContain("agent/my-spec-3");
  });
});

// ---------------------------------------------------------------------------
// Test 2: Protected-file staging rejection
// ---------------------------------------------------------------------------

describe("GitControllerAdapter.stageAndCommit with real ToolExecutor — protected-file rejection", () => {
  it("returns ok: false when a .env file is in the staged list and does not call git commit", async () => {
    await makeInitialCommit(tmpDir);

    // Create a .env file in the workspace
    await fsWriteFile(join(tmpDir, ".env"), "SECRET=hunter2", "utf-8");

    const adapter = makeAdapter([".env"]);

    // Attempt to stage and commit the protected file
    const result = await adapter.stageAndCommit([".env"], "add secrets");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("validation");
      expect(result.error.message).toContain("protected-file-detected");
    }

    // Verify no extra commit was created — only the initial commit should exist
    const logOutput = await git(tmpDir, "log", "--oneline");
    const commitLines = logOutput.split("\n").filter((l) => l.trim().length > 0);
    expect(commitLines.length).toBe(1);

    // The .env file must remain untracked (never staged or committed)
    const status = await git(tmpDir, "status", "--porcelain");
    expect(status).toContain(".env");
  });

  it("commits safe files successfully when no protected patterns are matched", async () => {
    await makeInitialCommit(tmpDir);
    await fsWriteFile(join(tmpDir, "safe.ts"), "export const x = 1;", "utf-8");

    const adapter = makeAdapter([".env"]);

    const result = await adapter.stageAndCommit(["safe.ts"], "add safe file");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hash).toMatch(/^[0-9a-f]{40}$/);
      expect(result.value.fileCount).toBe(1);
    }

    // The commit should now exist in the git log
    const logOutput = await git(tmpDir, "log", "--oneline");
    expect(logOutput).toContain("add safe file");
  });

  it("blocks the entire commit when a mix of safe and protected files is provided", async () => {
    await makeInitialCommit(tmpDir);
    await fsWriteFile(join(tmpDir, "safe.ts"), "x", "utf-8");
    await fsWriteFile(join(tmpDir, ".env"), "SECRET=x", "utf-8");

    const adapter = makeAdapter([".env"]);

    // Providing both safe and protected files — whole commit should be rejected
    const result = await adapter.stageAndCommit(["safe.ts", ".env"], "mixed commit");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("protected-file-detected");
    }

    // No commit should have been added
    const logOutput = await git(tmpDir, "log", "--oneline");
    const commitLines = logOutput.split("\n").filter((l) => l.trim().length > 0);
    expect(commitLines.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Push non-fast-forward error detection
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

describe("GitControllerAdapter.push with real ToolExecutor — non-fast-forward detection", () => {
  it("returns ok: false with reason non-fast-forward when remote has diverged commits", async () => {
    await makeInitialCommit(tmpDir);
    const remoteDir = await setupRepoWithRemote();
    const currentBranch = await git(tmpDir, "rev-parse", "--abbrev-ref", "HEAD");

    // Push the initial commit to the remote
    await git(tmpDir, "push", "origin", currentBranch);

    // Create a second clone that advances the remote beyond our local history
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

    // Add a local commit that creates a diverging history
    await fsWriteFile(join(tmpDir, "local.ts"), "y", "utf-8");
    await git(tmpDir, "add", "local.ts");
    await git(tmpDir, "commit", "-m", "local diverge");

    const adapter = makeAdapter([]);

    // Push should fail with non-fast-forward classification
    const result = await adapter.push(currentBranch, "origin");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details?.["reason"]).toBe("non-fast-forward");
    }
  });

  it("returns ok: true when push succeeds to an up-to-date remote", async () => {
    await makeInitialCommit(tmpDir);
    await setupRepoWithRemote();
    const currentBranch = await git(tmpDir, "rev-parse", "--abbrev-ref", "HEAD");

    const adapter = makeAdapter([]);

    const result = await adapter.push(currentBranch, "origin");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.branchName).toBe(currentBranch);
      expect(result.value.remote).toBe("origin");
    }
  });
});
