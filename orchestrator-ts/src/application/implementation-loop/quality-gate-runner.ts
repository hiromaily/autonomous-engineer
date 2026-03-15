import { runCommandTool } from "@/adapters/tools/shell";
import type { RunCommandOutput } from "@/adapters/tools/shell";
import type { IQualityGate, QualityGateCheck, QualityGateConfig } from "@/application/ports/implementation-loop";
import type { IToolExecutor } from "@/application/tools/executor";
import type { ReviewCheckResult } from "@/domain/implementation-loop/types";
import type { ToolContext } from "@/domain/tools/types";

// ---------------------------------------------------------------------------
// QualityGateRunner — stateless IQualityGate implementation
// ---------------------------------------------------------------------------

/**
 * Stateless service that runs quality gate checks by invoking shell commands
 * via the tool executor. Never throws — all errors surface as failed check results.
 *
 * Each `QualityGateCheck.command` string (e.g. `"bun run lint"`) is split on
 * whitespace into a command and args array and passed to the `run_command` tool.
 */
export class QualityGateRunner implements IQualityGate {
  readonly #toolExecutor: IToolExecutor;
  readonly #context: ToolContext;

  constructor(toolExecutor: IToolExecutor, context: ToolContext) {
    this.#toolExecutor = toolExecutor;
    this.#context = context;
  }

  async run(config: QualityGateConfig): Promise<ReadonlyArray<ReviewCheckResult>> {
    return Promise.all(config.checks.map((check) => this.#runCheck(check)));
  }

  async #runCheck(check: QualityGateCheck): Promise<ReviewCheckResult> {
    const { command, args } = parseCommand(check.command);
    const input: { command: string; args: string[]; cwd?: string } = {
      command,
      args,
      ...(check.workingDirectory !== undefined ? { cwd: check.workingDirectory } : {}),
    };

    try {
      const result = await this.#toolExecutor.invoke(runCommandTool.name, input, this.#context);

      if (!result.ok) {
        return {
          checkName: check.name,
          outcome: "failed",
          required: check.required,
          details: result.error.message,
        };
      }

      const output = result.value as RunCommandOutput;
      const passed = output.exitCode === 0;

      return {
        checkName: check.name,
        outcome: passed ? "passed" : "failed",
        required: check.required,
        details: passed
          ? output.stdout
          : `Exit code ${output.exitCode}: ${output.stderr || output.stdout}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        checkName: check.name,
        outcome: "failed",
        required: check.required,
        details: `Command execution failed: ${message}`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// NoopQualityGate — stub for unit tests
// ---------------------------------------------------------------------------

/**
 * No-op stub implementation of `IQualityGate` for use in unit tests.
 * Returns an empty array for all checks without invoking any commands.
 */
export class NoopQualityGate implements IQualityGate {
  async run(_config: QualityGateConfig): Promise<ReadonlyArray<ReviewCheckResult>> {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Split a shell command string (e.g. `"bun run lint"` or `'my-tool --msg "hello world"'`)
 * into a command and args array suitable for `run_command` tool invocation.
 * Handles single- and double-quoted arguments containing spaces.
 */
function parseCommand(command: string): { command: string; args: string[] } {
  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";

  for (const char of command.trim()) {
    if (inQuote) {
      if (char === quoteChar) {
        inQuote = false;
      } else {
        current += char;
      }
    } else if (char === "\"" || char === "'") {
      inQuote = true;
      quoteChar = char;
    } else if (/\s/.test(char)) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current.length > 0) {
    parts.push(current);
  }

  const cmd = parts[0] ?? command;
  const args = parts.slice(1);
  return { command: cmd, args };
}
