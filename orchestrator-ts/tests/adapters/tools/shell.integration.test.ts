/**
 * Integration tests for shell tools — exercises real process execution in a
 * temporary workspace directory created for each test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile as fsWriteFile, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  runCommandTool,
  runTestSuiteTool,
  installDependenciesTool,
} from '../../../adapters/tools/shell';
import { ToolExecutor } from '../../../application/tools/executor';
import { ToolRegistry } from '../../../domain/tools/registry';
import { PermissionSystem } from '../../../domain/tools/permissions';
import type { ToolContext, PermissionSet, ToolInvocationLog } from '../../../domain/tools/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePermissions(overrides: Partial<PermissionSet> = {}): PermissionSet {
  return Object.freeze({
    filesystemRead:  true,
    filesystemWrite: true,
    shellExecution:  true,
    gitWrite:        false,
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

function makeExecutor(timeoutMs = 5000) {
  const registry = new ToolRegistry();
  registry.register(runCommandTool);
  registry.register(runTestSuiteTool);
  registry.register(installDependenciesTool);
  const permissions = new PermissionSystem();
  return new ToolExecutor(registry, permissions, { defaultTimeoutMs: timeoutMs, logMaxInputBytes: 256 });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Shell Tools – Integration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    // Resolve symlinks so that `pwd` output matches (macOS /var → /private/var)
    tmpDir = await realpath(await mkdtemp(join(tmpdir(), 'shell-tools-test-')));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // run_command
  // -------------------------------------------------------------------------

  describe('run_command', () => {
    it('captures stdout from a successful command', async () => {
      const ctx = makeContext(tmpDir);
      const result = await runCommandTool.execute(
        { command: 'echo', args: ['hello world'] },
        ctx,
      );
      expect(result.stdout.trim()).toBe('hello world');
      expect(result.exitCode).toBe(0);
    });

    it('captures stderr from a command that writes to stderr', async () => {
      const ctx = makeContext(tmpDir);
      // Write a small script that outputs to stderr
      const scriptPath = join(tmpDir, 'err.sh');
      await fsWriteFile(scriptPath, '#!/bin/sh\necho "err-output" >&2\n', 'utf-8');
      const result = await runCommandTool.execute(
        { command: 'sh', args: [scriptPath] },
        ctx,
      );
      expect(result.stderr.trim()).toBe('err-output');
      expect(result.exitCode).toBe(0);
    });

    it('forwards non-zero exit code as a valid result (not an error)', async () => {
      const ctx = makeContext(tmpDir);
      const result = await runCommandTool.execute(
        { command: 'sh', args: ['-c', 'exit 42'] },
        ctx,
      );
      expect(result.exitCode).toBe(42);
    });

    it('respects the optional cwd parameter', async () => {
      const subDir = join(tmpDir, 'sub');
      await mkdir(subDir);
      const ctx = makeContext(tmpDir);
      const result = await runCommandTool.execute(
        { command: 'pwd', args: [], cwd: subDir },
        ctx,
      );
      expect(result.stdout.trim()).toBe(subDir);
      expect(result.exitCode).toBe(0);
    });

    it('uses workingDirectory as default cwd when cwd is not provided', async () => {
      const ctx = makeContext(tmpDir);
      const result = await runCommandTool.execute(
        { command: 'pwd', args: [] },
        ctx,
      );
      expect(result.stdout.trim()).toBe(tmpDir);
    });

    it('requires shellExecution permission', () => {
      expect(runCommandTool.requiredPermissions).toContain('shellExecution');
    });

    it('captures both stdout and stderr when both are produced', async () => {
      const ctx = makeContext(tmpDir);
      const scriptPath = join(tmpDir, 'both.sh');
      await fsWriteFile(scriptPath, '#!/bin/sh\necho "out"\necho "err" >&2\n', 'utf-8');
      const result = await runCommandTool.execute(
        { command: 'sh', args: [scriptPath] },
        ctx,
      );
      expect(result.stdout.trim()).toBe('out');
      expect(result.stderr.trim()).toBe('err');
    });

    it('rejects cwd outside workspace root with a path traversal error', async () => {
      const ctx = makeContext(tmpDir);
      await expect(
        runCommandTool.execute(
          { command: 'pwd', args: [], cwd: '../outside' },
          ctx,
        ),
      ).rejects.toThrow();
    });

    it('timeout via ToolExecutor returns a runtime error result', async () => {
      // Use a very short timeout (50ms) so the sleep command exceeds it
      const executor = makeExecutor(50);
      const ctx = makeContext(tmpDir);
      const result = await executor.invoke(
        'run_command',
        { command: 'sleep', args: ['10'] },
        ctx,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('runtime');
        expect(result.error.message).toMatch(/timed out/i);
      }
    });
  });

  // -------------------------------------------------------------------------
  // run_test_suite
  // -------------------------------------------------------------------------

  describe('run_test_suite', () => {
    it('requires shellExecution permission', () => {
      expect(runTestSuiteTool.requiredPermissions).toContain('shellExecution');
    });

    it('runs bun test suite and returns structured result with pass/fail counts', async () => {
      // Create a minimal bun test fixture
      const pkgJson = join(tmpDir, 'package.json');
      await fsWriteFile(pkgJson, JSON.stringify({ name: 'test-fixture', version: '1.0.0' }), 'utf-8');
      const testFile = join(tmpDir, 'sample.test.ts');
      await fsWriteFile(
        testFile,
        `import { describe, it, expect } from 'bun:test';\ndescribe('sample', () => { it('passes', () => { expect(1 + 1).toBe(2); }); });\n`,
        'utf-8',
      );

      const ctx = makeContext(tmpDir);
      const result = await runTestSuiteTool.execute(
        { framework: 'bun' },
        ctx,
      );

      expect(result.result.passed).toBeGreaterThan(0);
      expect(result.result.failed).toBe(0);
      expect(result.result.failures).toHaveLength(0);
      expect(typeof result.stdout).toBe('string');
    });

    it('returns failed count and failure messages for failing tests', async () => {
      const pkgJson = join(tmpDir, 'package.json');
      await fsWriteFile(pkgJson, JSON.stringify({ name: 'test-fixture', version: '1.0.0' }), 'utf-8');
      const testFile = join(tmpDir, 'fail.test.ts');
      await fsWriteFile(
        testFile,
        `import { describe, it, expect } from 'bun:test';\ndescribe('fail', () => { it('fails', () => { expect(1).toBe(2); }); });\n`,
        'utf-8',
      );

      const ctx = makeContext(tmpDir);
      const result = await runTestSuiteTool.execute(
        { framework: 'bun' },
        ctx,
      );

      expect(result.result.failed).toBeGreaterThan(0);
      expect(typeof result.stdout).toBe('string');
    });

    it('applies workspace path validation when cwd is provided', async () => {
      const ctx = makeContext(tmpDir);
      await expect(
        runTestSuiteTool.execute(
          { framework: 'bun', cwd: '../outside' },
          ctx,
        ),
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // install_dependencies
  // -------------------------------------------------------------------------

  describe('install_dependencies', () => {
    it('requires shellExecution permission', () => {
      expect(installDependenciesTool.requiredPermissions).toContain('shellExecution');
    });

    it('returns stdout, stderr, and exitCode', async () => {
      // Create a minimal package.json so bun install has something to do
      await fsWriteFile(
        join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: {} }),
        'utf-8',
      );

      const ctx = makeContext(tmpDir);
      const result = await installDependenciesTool.execute(
        { packageManager: 'bun' },
        ctx,
      );

      expect(typeof result.stdout).toBe('string');
      expect(typeof result.stderr).toBe('string');
      expect(typeof result.exitCode).toBe('number');
    });

    it('applies workspace path validation when cwd is provided', async () => {
      const ctx = makeContext(tmpDir);
      await expect(
        installDependenciesTool.execute(
          { packageManager: 'bun', cwd: '../outside' },
          ctx,
        ),
      ).rejects.toThrow();
    });

    it('applies workspace path validation for nested cwd within workspace', async () => {
      const subDir = join(tmpDir, 'sub');
      await mkdir(subDir);
      await fsWriteFile(
        join(subDir, 'package.json'),
        JSON.stringify({ name: 'sub-fixture', version: '1.0.0', dependencies: {} }),
        'utf-8',
      );
      const ctx = makeContext(tmpDir);
      // Should not throw — cwd is within workspace
      const result = await installDependenciesTool.execute(
        { packageManager: 'bun', cwd: subDir },
        ctx,
      );
      expect(typeof result.exitCode).toBe('number');
    });
  });
});
