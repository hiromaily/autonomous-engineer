/**
 * Integration tests for git tools — exercises real git operations in a
 * temporary repository initialized for each test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import {
  gitStatusTool,
  gitDiffTool,
  gitCommitTool,
  gitBranchListTool,
  gitBranchCreateTool,
  gitBranchSwitchTool,
} from '../../../adapters/tools/git';
import { ToolExecutor } from '../../../application/tools/executor';
import { ToolRegistry } from '../../../domain/tools/registry';
import { PermissionSystem } from '../../../domain/tools/permissions';
import type { ToolContext, PermissionSet, ToolInvocationLog } from '../../../domain/tools/types';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePermissions(overrides: Partial<PermissionSet> = {}): PermissionSet {
  return Object.freeze({
    filesystemRead:  true,
    filesystemWrite: true,
    shellExecution:  false,
    gitWrite:        true,
    networkAccess:   false,
    ...overrides,
  });
}

function makeLogger() {
  const logs: ToolInvocationLog[] = [];
  return {
    info:    (e: ToolInvocationLog) => logs.push(e),
    error:   (e: ToolInvocationLog) => logs.push(e),
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
  const { stdout } = await execFile('git', args, { cwd });
  return stdout.trim();
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, 'init');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await git(dir, 'config', 'user.name', 'Test User');
}

async function makeInitialCommit(dir: string): Promise<string> {
  await fsWriteFile(join(dir, 'README.md'), '# test', 'utf-8');
  await git(dir, 'add', 'README.md');
  await git(dir, 'commit', '-m', 'initial commit');
  return git(dir, 'rev-parse', 'HEAD');
}

function makeExecutor() {
  const registry = new ToolRegistry();
  const permSystem = new PermissionSystem();
  for (const tool of [gitStatusTool, gitDiffTool, gitCommitTool, gitBranchListTool, gitBranchCreateTool, gitBranchSwitchTool]) {
    registry.register(tool as Parameters<typeof registry.register>[0]);
  }
  return new ToolExecutor(registry, permSystem, { defaultTimeoutMs: 5000, logMaxInputBytes: 256 });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let executor: ReturnType<typeof makeExecutor>;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'aes-git-integ-'));
  await initRepo(tmpDir);
  executor = makeExecutor();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// git_status
// ---------------------------------------------------------------------------

describe('git_status', () => {
  it('returns empty lists in a clean repository after initial commit', async () => {
    await makeInitialCommit(tmpDir);
    const ctx = makeContext(tmpDir);
    const result = await gitStatusTool.execute({ }, ctx);

    expect(result.staged).toEqual([]);
    expect(result.unstaged).toEqual([]);
    expect(result.untracked).toEqual([]);
  });

  it('returns untracked files', async () => {
    await makeInitialCommit(tmpDir);
    await fsWriteFile(join(tmpDir, 'new.ts'), 'export {}', 'utf-8');
    const ctx = makeContext(tmpDir);
    const result = await gitStatusTool.execute({ }, ctx);

    expect(result.untracked).toContain('new.ts');
  });

  it('returns staged files after git add', async () => {
    await makeInitialCommit(tmpDir);
    await fsWriteFile(join(tmpDir, 'staged.ts'), 'export {}', 'utf-8');
    await git(tmpDir, 'add', 'staged.ts');
    const ctx = makeContext(tmpDir);
    const result = await gitStatusTool.execute({ }, ctx);

    expect(result.staged).toContain('staged.ts');
  });

  it('returns unstaged files after modifying a tracked file', async () => {
    await makeInitialCommit(tmpDir);
    await fsWriteFile(join(tmpDir, 'README.md'), '# modified', 'utf-8');
    const ctx = makeContext(tmpDir);
    const result = await gitStatusTool.execute({ }, ctx);

    expect(result.unstaged).toContain('README.md');
  });

  it('uses workingDirectory as git cwd', async () => {
    await makeInitialCommit(tmpDir);
    // If git ran in the wrong directory it would throw; getting here means cwd is correct
    const ctx = makeContext(tmpDir);
    await expect(gitStatusTool.execute({ }, ctx)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// git_diff
// ---------------------------------------------------------------------------

describe('git_diff', () => {
  it('returns empty string when there are no changes', async () => {
    await makeInitialCommit(tmpDir);
    const ctx = makeContext(tmpDir);
    const result = await gitDiffTool.execute({ }, ctx);

    expect(result.diff).toBe('');
  });

  it('returns diff content for unstaged modifications', async () => {
    await makeInitialCommit(tmpDir);
    await fsWriteFile(join(tmpDir, 'README.md'), '# modified content', 'utf-8');
    const ctx = makeContext(tmpDir);
    const result = await gitDiffTool.execute({ }, ctx);

    expect(result.diff).toContain('README.md');
    expect(result.diff).toContain('modified content');
  });

  it('returns staged diff when staged=true', async () => {
    await makeInitialCommit(tmpDir);
    await fsWriteFile(join(tmpDir, 'staged.ts'), 'staged content', 'utf-8');
    await git(tmpDir, 'add', 'staged.ts');
    const ctx = makeContext(tmpDir);
    const result = await gitDiffTool.execute({ staged: true }, ctx);

    expect(result.diff).toContain('staged.ts');
    expect(result.diff).toContain('staged content');
  });

  it('returns empty string for staged when nothing is staged', async () => {
    await makeInitialCommit(tmpDir);
    const ctx = makeContext(tmpDir);
    const result = await gitDiffTool.execute({ staged: true }, ctx);

    expect(result.diff).toBe('');
  });
});

// ---------------------------------------------------------------------------
// git_commit
// ---------------------------------------------------------------------------

describe('git_commit', () => {
  it('creates a commit and returns a valid hash', async () => {
    await makeInitialCommit(tmpDir);
    await fsWriteFile(join(tmpDir, 'feature.ts'), 'export const x = 1;', 'utf-8');
    await git(tmpDir, 'add', 'feature.ts');

    const ctx = makeContext(tmpDir);
    const result = await gitCommitTool.execute({ message: 'add feature' }, ctx);

    expect(result.hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('commit hash matches HEAD after commit', async () => {
    await makeInitialCommit(tmpDir);
    await fsWriteFile(join(tmpDir, 'b.ts'), '', 'utf-8');
    await git(tmpDir, 'add', 'b.ts');

    const ctx = makeContext(tmpDir);
    const result = await gitCommitTool.execute({ message: 'add b' }, ctx);
    const head = await git(tmpDir, 'rev-parse', 'HEAD');

    expect(result.hash).toBe(head);
  });

  it('returns gitWrite in requiredPermissions', () => {
    expect(gitCommitTool.requiredPermissions).toContain('gitWrite');
  });
});

// ---------------------------------------------------------------------------
// git_branch_list
// ---------------------------------------------------------------------------

describe('git_branch_list', () => {
  it('lists branches with current branch identified', async () => {
    await makeInitialCommit(tmpDir);
    const ctx = makeContext(tmpDir);
    const result = await gitBranchListTool.execute({ }, ctx);

    expect(result.branches.length).toBeGreaterThan(0);
    const current = result.branches.find((b) => b.current);
    expect(current).toBeDefined();
  });

  it('includes a newly created branch', async () => {
    await makeInitialCommit(tmpDir);
    await git(tmpDir, 'branch', 'feature/test');
    const ctx = makeContext(tmpDir);
    const result = await gitBranchListTool.execute({ }, ctx);

    const names = result.branches.map((b) => b.name);
    expect(names).toContain('feature/test');
  });

  it('requires no gitWrite permission', () => {
    expect(gitBranchListTool.requiredPermissions).not.toContain('gitWrite');
  });
});

// ---------------------------------------------------------------------------
// git_branch_create
// ---------------------------------------------------------------------------

describe('git_branch_create', () => {
  it('creates a new branch and returns its name', async () => {
    await makeInitialCommit(tmpDir);
    const ctx = makeContext(tmpDir);
    const result = await gitBranchCreateTool.execute({ name: 'feature/new' }, ctx);

    expect(result.name).toBe('feature/new');
    const branches = await git(tmpDir, 'branch');
    expect(branches).toContain('feature/new');
  });

  it('returns gitWrite in requiredPermissions', () => {
    expect(gitBranchCreateTool.requiredPermissions).toContain('gitWrite');
  });
});

// ---------------------------------------------------------------------------
// git_branch_switch
// ---------------------------------------------------------------------------

describe('git_branch_switch', () => {
  it('switches to an existing branch and returns its name', async () => {
    await makeInitialCommit(tmpDir);
    await git(tmpDir, 'branch', 'other-branch');

    const ctx = makeContext(tmpDir);
    const result = await gitBranchSwitchTool.execute({ name: 'other-branch' }, ctx);

    expect(result.name).toBe('other-branch');
    const current = await git(tmpDir, 'rev-parse', '--abbrev-ref', 'HEAD');
    expect(current).toBe('other-branch');
  });

  it('returns gitWrite in requiredPermissions', () => {
    expect(gitBranchSwitchTool.requiredPermissions).toContain('gitWrite');
  });
});

// ---------------------------------------------------------------------------
// Full ToolExecutor pipeline integration tests
// ---------------------------------------------------------------------------

describe('git_status via ToolExecutor', () => {
  it('returns correct staged/unstaged/untracked lists through full pipeline', async () => {
    await makeInitialCommit(tmpDir);
    await fsWriteFile(join(tmpDir, 'untracked.ts'), '', 'utf-8');
    await fsWriteFile(join(tmpDir, 'staged.ts'), '', 'utf-8');
    await git(tmpDir, 'add', 'staged.ts');
    await fsWriteFile(join(tmpDir, 'README.md'), '# changed', 'utf-8');

    const ctx = makeContext(tmpDir);
    const result = await executor.invoke('git_status', {}, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const out = result.value as { staged: string[]; unstaged: string[]; untracked: string[] };
      expect(out.staged).toContain('staged.ts');
      expect(out.unstaged).toContain('README.md');
      expect(out.untracked).toContain('untracked.ts');
    }
  });

  it('emits a log entry on success', async () => {
    await makeInitialCommit(tmpDir);
    const logger = makeLogger();
    const ctx = { ...makeContext(tmpDir), logger };
    await executor.invoke('git_status', {}, ctx);

    expect(logger.getLogs().length).toBe(1);
    expect(logger.getLogs()[0]!.resultStatus).toBe('success');
  });
});

describe('git_commit via ToolExecutor', () => {
  it('creates a real commit and returns a valid hash through full pipeline', async () => {
    await makeInitialCommit(tmpDir);
    await fsWriteFile(join(tmpDir, 'x.ts'), 'x', 'utf-8');
    await git(tmpDir, 'add', 'x.ts');

    const ctx = makeContext(tmpDir);
    const result = await executor.invoke('git_commit', { message: 'pipeline test' }, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as { hash: string }).hash).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('returns permission error when gitWrite is absent', async () => {
    await makeInitialCommit(tmpDir);
    const ctx = makeContext(tmpDir, makePermissions({ gitWrite: false }));
    const result = await executor.invoke('git_commit', { message: 'denied' }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('permission');
    }
  });
});

describe('git_branch_list via ToolExecutor', () => {
  it('returns all branches with current branch identified through full pipeline', async () => {
    await makeInitialCommit(tmpDir);
    await git(tmpDir, 'branch', 'side-branch');

    const ctx = makeContext(tmpDir);
    const result = await executor.invoke('git_branch_list', {}, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const out = result.value as { branches: Array<{ name: string; current: boolean }> };
      const names = out.branches.map((b) => b.name);
      expect(names).toContain('side-branch');
      expect(out.branches.some((b) => b.current)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Git error cases — typed runtime errors
// ---------------------------------------------------------------------------

describe('git errors produce typed runtime errors', () => {
  it('git_branch_switch to a non-existent branch yields a runtime error', async () => {
    await makeInitialCommit(tmpDir);
    const ctx = makeContext(tmpDir);
    const result = await executor.invoke('git_branch_switch', { name: 'does-not-exist' }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('runtime');
    }
  });

  it('git_commit with nothing staged yields a runtime error', async () => {
    await makeInitialCommit(tmpDir);
    const ctx = makeContext(tmpDir);
    const result = await executor.invoke('git_commit', { message: 'empty commit' }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('runtime');
    }
  });

  it('git_branch_create with a duplicate name yields a runtime error', async () => {
    await makeInitialCommit(tmpDir);
    await git(tmpDir, 'branch', 'existing');
    const ctx = makeContext(tmpDir);
    const result = await executor.invoke('git_branch_create', { name: 'existing' }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('runtime');
    }
  });
});
