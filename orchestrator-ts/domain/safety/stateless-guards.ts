import { resolve, basename } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { ISafetyGuard, SafetyCheckResult, SafetyContext } from './guards';
import { allowedResult, blockedResult } from './guards';
import type { SafetyConfig } from './types';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// 2.1 WorkspaceIsolationGuard
// ---------------------------------------------------------------------------

/**
 * Exhaustive map from tool name to the path fields in rawInput that must be
 * checked against the workspace boundary. Tools absent from this map have no
 * file path arguments and are always passed through.
 */
const PATH_FIELDS: Readonly<Record<string, ReadonlyArray<string>>> = {
  read_file:      ['path'],
  write_file:     ['path'],
  list_directory: ['path'],
  search_files:   ['directory'],
  run_command:    ['cwd'],   // optional field; guard skips if absent
};

function isWithinWorkspace(workspaceRoot: string, requestedPath: string): boolean {
  const resolved = resolve(workspaceRoot, requestedPath);
  const rootWithSep = workspaceRoot.endsWith('/') ? workspaceRoot : workspaceRoot + '/';
  return resolved === workspaceRoot || resolved.startsWith(rootWithSep);
}

export class WorkspaceIsolationGuard implements ISafetyGuard {
  readonly name = 'workspace-isolation';

  async check(toolName: string, rawInput: unknown, context: SafetyContext): Promise<SafetyCheckResult> {
    const fields = PATH_FIELDS[toolName];
    if (!fields || fields.length === 0) {
      // Tool has no file path inputs — pass through
      return allowedResult();
    }

    const input = rawInput as Record<string, unknown>;
    const workspaceRoot = context.config.workspaceRoot;

    for (const field of fields) {
      const value = input[field];
      if (value === undefined || value === null) continue; // optional field absent
      if (typeof value !== 'string') continue;

      if (!isWithinWorkspace(workspaceRoot, value)) {
        return blockedResult({
          type: 'permission',
          message: `Path '${value}' resolves outside workspace root '${workspaceRoot}'`,
        });
      }
    }

    return allowedResult();
  }
}

// ---------------------------------------------------------------------------
// 2.2 FilesystemGuard
// ---------------------------------------------------------------------------

/**
 * Returns true when the normalized path matches the given protected pattern.
 * Matching checks both basename (e.g. `.env`) and substring (e.g. `.git/config`).
 */
function matchesProtectedPattern(normalizedPath: string, pattern: string): boolean {
  // Directory-anchored patterns (e.g. `.git/config`) — full-path substring match
  if (pattern.includes('/')) {
    return normalizedPath.includes(pattern);
  }
  // Simple basename patterns (e.g. `.env`, `secrets.json`)
  return basename(normalizedPath) === pattern;
}

export class FilesystemGuard implements ISafetyGuard {
  readonly name = 'filesystem';

  async check(toolName: string, rawInput: unknown, context: SafetyContext): Promise<SafetyCheckResult> {
    // Only intercept write operations
    if (toolName !== 'write_file') return allowedResult();

    const input = rawInput as { path: string };
    const normalizedPath = resolve(context.config.workspaceRoot, input.path);

    for (const pattern of context.config.protectedFilePatterns) {
      if (matchesProtectedPattern(normalizedPath, pattern)) {
        return blockedResult({
          type: 'permission',
          message: `Write to '${input.path}' is blocked: file matches protected pattern '${pattern}'`,
        });
      }
    }

    return allowedResult();
  }
}

// ---------------------------------------------------------------------------
// 2.3 GitSafetyGuard
// ---------------------------------------------------------------------------

export type GitRunner = (args: string[], cwd: string) => Promise<string>;

const defaultGitRunner: GitRunner = async (args, cwd) => {
  const { stdout } = await execFile('git', args, { cwd });
  return stdout;
};

export class GitSafetyGuard implements ISafetyGuard {
  readonly name = 'git-safety';
  private readonly gitRunner: GitRunner;

  constructor(gitRunner: GitRunner = defaultGitRunner) {
    this.gitRunner = gitRunner;
  }

  async check(toolName: string, rawInput: unknown, context: SafetyContext): Promise<SafetyCheckResult> {
    const { config } = context;
    const cwd = context.workingDirectory;

    if (toolName === 'git_commit') {
      return this.checkCommit(rawInput, config, cwd);
    }

    if (toolName === 'git_branch_create') {
      return this.checkBranchCreate(rawInput, config);
    }

    // git_branch_switch, git_status, git_diff, git_branch_list — pass through
    return allowedResult();
  }

  private async checkCommit(
    _rawInput: unknown,
    config: SafetyConfig,
    cwd: string,
  ): Promise<SafetyCheckResult> {
    // Check current branch
    const branchOutput = await this.gitRunner(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    const currentBranch = branchOutput.trim();

    if (config.protectedBranches.includes(currentBranch)) {
      return blockedResult({
        type: 'permission',
        message: `Commits to protected branch '${currentBranch}' are not allowed`,
      });
    }

    // Check staged file count
    const stagedOutput = await this.gitRunner(['diff', '--staged', '--name-only'], cwd);
    const stagedFiles = stagedOutput.split('\n').filter(line => line.trim() !== '');

    if (stagedFiles.length > config.maxFilesPerCommit) {
      return blockedResult({
        type: 'validation',
        message: `Staged file count (${stagedFiles.length}) exceeds maxFilesPerCommit limit (${config.maxFilesPerCommit})`,
      });
    }

    return allowedResult();
  }

  private checkBranchCreate(rawInput: unknown, config: SafetyConfig): SafetyCheckResult {
    const input = rawInput as { name: string };
    const branchName = input.name;
    const pattern = new RegExp(config.branchNamePattern);

    if (!pattern.test(branchName)) {
      return blockedResult({
        type: 'validation',
        message: `Branch name '${branchName}' does not match required pattern '${config.branchNamePattern}'`,
      });
    }

    return allowedResult();
  }
}

// ---------------------------------------------------------------------------
// 2.4 ShellRestrictionGuard
// ---------------------------------------------------------------------------

interface CompiledPattern {
  readonly source: string;
  readonly regex: RegExp;
}

const SHELL_TOOL_NAMES = new Set(['run_command', 'run_test_suite', 'install_dependencies']);

function buildCommandString(toolName: string, rawInput: unknown): string | null {
  if (toolName === 'run_command') {
    const inp = rawInput as { command: string; args?: string[] };
    return [inp.command, ...(inp.args ?? [])].join(' ');
  }
  // run_test_suite and install_dependencies use fixed, predefined commands —
  // the blocklist/allowlist is applied to these too via the synthesized string
  if (toolName === 'run_test_suite') {
    const inp = rawInput as { framework: string; pattern?: string };
    return `${inp.framework} test${inp.pattern !== undefined ? ` ${inp.pattern}` : ''}`;
  }
  if (toolName === 'install_dependencies') {
    const inp = rawInput as { packageManager: string };
    return `${inp.packageManager} install`;
  }
  return null;
}

export class ShellRestrictionGuard implements ISafetyGuard {
  readonly name = 'shell-restriction';
  private readonly blocklistPatterns: ReadonlyArray<CompiledPattern>;
  private readonly allowlistPatterns: ReadonlyArray<CompiledPattern> | null;

  constructor(config: SafetyConfig) {
    this.blocklistPatterns = config.shellBlocklist.map(source => ({
      source,
      regex: new RegExp(source),
    }));
    this.allowlistPatterns = config.shellAllowlist !== null
      ? config.shellAllowlist.map(source => ({ source, regex: new RegExp(source) }))
      : null;
  }

  async check(toolName: string, rawInput: unknown, _context: SafetyContext): Promise<SafetyCheckResult> {
    if (!SHELL_TOOL_NAMES.has(toolName)) return allowedResult();

    const commandString = buildCommandString(toolName, rawInput);
    if (commandString === null) return allowedResult();

    // Blocklist check
    for (const { source, regex } of this.blocklistPatterns) {
      if (regex.test(commandString)) {
        return blockedResult({
          type: 'permission',
          message: `Command '${commandString}' is blocked by pattern '${source}'`,
        });
      }
    }

    // Allowlist check (only when allowlist is configured)
    if (this.allowlistPatterns !== null) {
      const isAllowed = this.allowlistPatterns.some(({ regex }) => regex.test(commandString));
      if (!isAllowed) {
        return blockedResult({
          type: 'permission',
          message: `Command '${commandString}' is not permitted: does not match any allowlist pattern`,
        });
      }
    }

    return allowedResult();
  }
}
