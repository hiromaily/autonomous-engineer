import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool, ToolContext } from '../../domain/tools/types';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Shared git runner
// ---------------------------------------------------------------------------

class GitError extends Error {
  readonly toolErrorType = 'runtime' as const;
  constructor(message: string, public readonly stderr: string) {
    super(message);
    this.name = 'GitError';
  }
}

async function runGit(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFile('git', args, { cwd });
    return stdout;
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    const stderr = e.stderr ?? '';
    const message = e.message ?? 'git command failed';
    throw new GitError(message, stderr);
  }
}

// ---------------------------------------------------------------------------
// I/O types
// ---------------------------------------------------------------------------

export interface GitStatusInput  { readonly [key: string]: never }
export interface GitStatusOutput {
  readonly staged:    ReadonlyArray<string>;
  readonly unstaged:  ReadonlyArray<string>;
  readonly untracked: ReadonlyArray<string>;
}

export interface GitDiffInput {
  readonly staged?: boolean;
  readonly base?:   string;
  readonly head?:   string;
}
export interface GitDiffOutput { readonly diff: string }

export interface GitCommitInput  { readonly message: string }
export interface GitCommitOutput { readonly hash: string }

export interface GitBranchListInput  { readonly [key: string]: never }
export interface GitBranchEntry {
  readonly name: string;
  readonly current: boolean;
}
export interface GitBranchListOutput { readonly branches: ReadonlyArray<GitBranchEntry> }

export interface GitBranchCreateInput  { readonly name: string }
export interface GitBranchCreateOutput { readonly name: string }

export interface GitBranchSwitchInput  { readonly name: string }
export interface GitBranchSwitchOutput { readonly name: string }

// ---------------------------------------------------------------------------
// git_status
// ---------------------------------------------------------------------------

export const gitStatusTool: Tool<GitStatusInput, GitStatusOutput> = {
  name: 'git_status',
  description: 'Return structured git status: staged, unstaged, and untracked file lists.',
  requiredPermissions: [],
  schema: {
    input: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: {
        staged:    { type: 'array', items: { type: 'string' } },
        unstaged:  { type: 'array', items: { type: 'string' } },
        untracked: { type: 'array', items: { type: 'string' } },
      },
      required: ['staged', 'unstaged', 'untracked'],
      additionalProperties: false,
    },
  },
  async execute(_input: GitStatusInput, context: ToolContext): Promise<GitStatusOutput> {
    // --porcelain=v1 format:
    //   XY PATH   — X = index (staged), Y = worktree (unstaged)
    //   ?? PATH   — untracked
    const raw = await runGit(['status', '--porcelain=v1'], context.workingDirectory);

    const staged:    string[] = [];
    const unstaged:  string[] = [];
    const untracked: string[] = [];

    for (const line of raw.split('\n')) {
      if (!line) continue;
      const x    = line[0]!;
      const y    = line[1]!;
      const path = line.slice(3).trim();

      if (x === '?' && y === '?') {
        untracked.push(path);
      } else {
        if (x !== ' ' && x !== '?') staged.push(path);
        if (y !== ' ' && y !== '?') unstaged.push(path);
      }
    }

    return { staged, unstaged, untracked };
  },
};

// ---------------------------------------------------------------------------
// git_diff
// ---------------------------------------------------------------------------

export const gitDiffTool: Tool<GitDiffInput, GitDiffOutput> = {
  name: 'git_diff',
  description: 'Return the raw git diff. Accepts optional staged, base, and head options.',
  requiredPermissions: [],
  schema: {
    input: {
      type: 'object',
      properties: {
        staged: { type: 'boolean' },
        base:   { type: 'string' },
        head:   { type: 'string' },
      },
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: { diff: { type: 'string' } },
      required: ['diff'],
      additionalProperties: false,
    },
  },
  async execute(input: GitDiffInput, context: ToolContext): Promise<GitDiffOutput> {
    const args = ['diff'];

    if (input.staged) {
      args.push('--staged');
    } else if (input.base !== undefined && input.head !== undefined) {
      args.push(input.base, input.head);
    } else if (input.base !== undefined) {
      args.push(input.base);
    }

    const diff = await runGit(args, context.workingDirectory);
    return { diff };
  },
};

// ---------------------------------------------------------------------------
// git_commit
// ---------------------------------------------------------------------------

export const gitCommitTool: Tool<GitCommitInput, GitCommitOutput> = {
  name: 'git_commit',
  description: 'Create a commit from currently staged changes with the provided message; returns the commit hash.',
  requiredPermissions: ['gitWrite'],
  schema: {
    input: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: { hash: { type: 'string' } },
      required: ['hash'],
      additionalProperties: false,
    },
  },
  async execute(input: GitCommitInput, context: ToolContext): Promise<GitCommitOutput> {
    await runGit(['commit', '-m', input.message], context.workingDirectory);
    const hash = (await runGit(['rev-parse', 'HEAD'], context.workingDirectory)).trim();
    return { hash };
  },
};

// ---------------------------------------------------------------------------
// git_branch_list
// ---------------------------------------------------------------------------

export const gitBranchListTool: Tool<GitBranchListInput, GitBranchListOutput> = {
  name: 'git_branch_list',
  description: 'List all branches and identify the current branch.',
  requiredPermissions: [],
  schema: {
    input: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: {
        branches: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name:    { type: 'string' },
              current: { type: 'boolean' },
            },
            required: ['name', 'current'],
            additionalProperties: false,
          },
        },
      },
      required: ['branches'],
      additionalProperties: false,
    },
  },
  async execute(_input: GitBranchListInput, context: ToolContext): Promise<GitBranchListOutput> {
    // --format=%(refname:short) %(HEAD) — space-separated, '*' marks current
    const raw = await runGit(['branch', '--format=%(refname:short) %(HEAD)'], context.workingDirectory);

    const branches: GitBranchEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const parts   = line.trim().split(' ');
      const name    = parts[0]!;
      const current = parts[1] === '*';
      branches.push({ name, current });
    }

    return { branches };
  },
};

// ---------------------------------------------------------------------------
// git_branch_create
// ---------------------------------------------------------------------------

export const gitBranchCreateTool: Tool<GitBranchCreateInput, GitBranchCreateOutput> = {
  name: 'git_branch_create',
  description: 'Create a new branch at HEAD and return its name.',
  requiredPermissions: ['gitWrite'],
  schema: {
    input: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  async execute(input: GitBranchCreateInput, context: ToolContext): Promise<GitBranchCreateOutput> {
    await runGit(['branch', input.name], context.workingDirectory);
    return { name: input.name };
  },
};

// ---------------------------------------------------------------------------
// git_branch_switch
// ---------------------------------------------------------------------------

export const gitBranchSwitchTool: Tool<GitBranchSwitchInput, GitBranchSwitchOutput> = {
  name: 'git_branch_switch',
  description: 'Check out an existing branch and return the branch switched to.',
  requiredPermissions: ['gitWrite'],
  schema: {
    input: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  async execute(input: GitBranchSwitchInput, context: ToolContext): Promise<GitBranchSwitchOutput> {
    await runGit(['checkout', input.name], context.workingDirectory);
    return { name: input.name };
  },
};
