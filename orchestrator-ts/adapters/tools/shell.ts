import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolContext } from "../../domain/tools/types";
import { resolveWorkspacePath } from "./filesystem";

const execFile = promisify(execFileCb);

// Hoisted at module level so it is compiled once, not on every test-output parse.
const FAILURE_MARKER_RE = /✗|● |FAILED/;

// ---------------------------------------------------------------------------
// I/O types
// ---------------------------------------------------------------------------

export interface RunCommandInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
}
export interface RunCommandOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type TestFramework = "bun" | "jest" | "vitest" | "mocha";
export interface RunTestSuiteInput {
  readonly framework: TestFramework;
  readonly pattern?: string;
  readonly cwd?: string;
}
export interface TestResult {
  readonly passed: number;
  readonly failed: number;
  readonly failures: ReadonlyArray<string>;
}
export interface RunTestSuiteOutput {
  readonly result: TestResult;
  readonly stdout: string;
  readonly stderr: string;
}

export type PackageManager = "bun" | "npm" | "pnpm" | "yarn";
export interface InstallDependenciesInput {
  readonly packageManager: PackageManager;
  readonly cwd?: string;
}
export interface InstallDependenciesOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

// ---------------------------------------------------------------------------
// Shared helper: run an executable safely (no shell interpolation)
// ---------------------------------------------------------------------------

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runExec(command: string, args: readonly string[], cwd: string): Promise<ExecResult> {
  try {
    // execFile requires mutable string[]; safe because execFile does not mutate the array.
    const { stdout, stderr } = await execFile(command, args as string[], {
      cwd,
      maxBuffer: 10 * 1024 * 1024, // 10 MB — guards against large test/install output
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string };
    const exitCode = typeof e.code === "number" ? e.code : 1;
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode,
    };
  }
}

// ---------------------------------------------------------------------------
// run_command
// ---------------------------------------------------------------------------

export const runCommandTool: Tool<RunCommandInput, RunCommandOutput> = {
  name: "run_command",
  description:
    "Execute a command with arguments via execFile (no shell interpolation). Captures stdout, stderr, and exit code; non-zero exit is a valid result, not an error.",
  requiredPermissions: ["shellExecution"],
  schema: {
    input: {
      type: "object",
      properties: {
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
      },
      required: ["command", "args"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      properties: {
        stdout: { type: "string" },
        stderr: { type: "string" },
        exitCode: { type: "number" },
      },
      required: ["stdout", "stderr", "exitCode"],
      additionalProperties: false,
    },
  },
  async execute(input: RunCommandInput, context: ToolContext): Promise<RunCommandOutput> {
    const cwd = input.cwd !== undefined
      ? resolveWorkspacePath(context.workspaceRoot, input.cwd)
      : context.workingDirectory;
    return runExec(input.command, input.args, cwd);
  },
};

// ---------------------------------------------------------------------------
// run_test_suite
// ---------------------------------------------------------------------------

/**
 * Parse test runner output (bun, jest, vitest, mocha) into structured counts.
 * Summary line examples: "3 pass\n0 fail" or "2 pass\n1 fail" (bun format).
 * Failure markers: ✗ (bun), ● (jest), FAILED (vitest/mocha).
 */
function parseTestOutput(stdout: string, stderr: string): TestResult {
  const combined = stdout + "\n" + stderr;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const line of combined.split("\n")) {
    const passMatch = line.match(/(\d+)\s+pass/);
    const failMatch = line.match(/(\d+)\s+fail/);
    if (passMatch) passed = parseInt(passMatch[1]!, 10);
    if (failMatch) failed = parseInt(failMatch[1]!, 10);
    if (FAILURE_MARKER_RE.test(line)) {
      const trimmed = line.trim();
      if (trimmed) failures.push(trimmed);
    }
  }

  return { passed, failed, failures };
}

/** Build command args for the given test framework. */
function buildTestArgs(framework: TestFramework, pattern?: string): { command: string; args: string[] } {
  switch (framework) {
    case "bun":
      return {
        command: "bun",
        args: pattern ? ["test", pattern] : ["test"],
      };
    case "jest":
      return {
        command: "npx",
        args: pattern ? ["jest", "--testPathPattern", pattern] : ["jest"],
      };
    case "vitest":
      return {
        command: "npx",
        args: pattern ? ["vitest", "run", pattern] : ["vitest", "run"],
      };
    case "mocha":
      return {
        command: "npx",
        args: pattern ? ["mocha", pattern] : ["mocha"],
      };
  }
}

export const runTestSuiteTool: Tool<RunTestSuiteInput, RunTestSuiteOutput> = {
  name: "run_test_suite",
  description:
    "Invoke a test framework runner and parse output into a structured result with passed/failed counts and failure messages.",
  requiredPermissions: ["shellExecution"],
  schema: {
    input: {
      type: "object",
      properties: {
        framework: { type: "string", enum: ["bun", "jest", "vitest", "mocha"] },
        pattern: { type: "string" },
        cwd: { type: "string" },
      },
      required: ["framework"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      properties: {
        result: {
          type: "object",
          properties: {
            passed: { type: "number" },
            failed: { type: "number" },
            failures: { type: "array", items: { type: "string" } },
          },
          required: ["passed", "failed", "failures"],
          additionalProperties: false,
        },
        stdout: { type: "string" },
        stderr: { type: "string" },
      },
      required: ["result", "stdout", "stderr"],
      additionalProperties: false,
    },
  },
  async execute(input: RunTestSuiteInput, context: ToolContext): Promise<RunTestSuiteOutput> {
    const cwd = input.cwd !== undefined
      ? resolveWorkspacePath(context.workspaceRoot, input.cwd)
      : context.workingDirectory;

    const { command, args } = buildTestArgs(input.framework, input.pattern);
    const { stdout, stderr } = await runExec(command, args, cwd);
    const result = parseTestOutput(stdout, stderr);
    return { result, stdout, stderr };
  },
};

// ---------------------------------------------------------------------------
// install_dependencies
// ---------------------------------------------------------------------------

function buildInstallArgs(packageManager: PackageManager): { command: string; args: string[] } {
  switch (packageManager) {
    case "bun":
      return { command: "bun", args: ["install"] };
    case "npm":
      return { command: "npm", args: ["install"] };
    case "pnpm":
      return { command: "pnpm", args: ["install"] };
    case "yarn":
      return { command: "yarn", args: ["install"] };
  }
}

export const installDependenciesTool: Tool<InstallDependenciesInput, InstallDependenciesOutput> = {
  name: "install_dependencies",
  description: "Run the appropriate package manager install command and return stdout, stderr, and exit code.",
  requiredPermissions: ["shellExecution"],
  schema: {
    input: {
      type: "object",
      properties: {
        packageManager: { type: "string", enum: ["bun", "npm", "pnpm", "yarn"] },
        cwd: { type: "string" },
      },
      required: ["packageManager"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      properties: {
        stdout: { type: "string" },
        stderr: { type: "string" },
        exitCode: { type: "number" },
      },
      required: ["stdout", "stderr", "exitCode"],
      additionalProperties: false,
    },
  },
  async execute(input: InstallDependenciesInput, context: ToolContext): Promise<InstallDependenciesOutput> {
    const cwd = input.cwd !== undefined
      ? resolveWorkspacePath(context.workspaceRoot, input.cwd)
      : context.workingDirectory;

    const { command, args } = buildInstallArgs(input.packageManager);
    return runExec(command, args, cwd);
  },
};
