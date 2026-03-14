/**
 * Unit tests for QualityGateRunner service (Task 2.2)
 *
 * Tests cover:
 * - Required check with exit code 0 → outcome: "passed"
 * - Required check with exit code 1 → outcome: "failed", details populated
 * - Advisory check failure does not affect required check result (required: false)
 * - Config-driven check selection (only configured checks are run)
 * - Tool executor failure (process crash) → check marked "failed", exception not propagated
 * - NoopQualityGate stub returns empty array
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5
 */
import type { QualityGateConfig } from "@/application/ports/implementation-loop";
import {
  NoopQualityGate,
  QualityGateRunner,
} from "@/application/implementation-loop/quality-gate-runner";
import type { IToolExecutor } from "@/application/tools/executor";
import type { MemoryEntry, ToolContext, ToolResult } from "@/domain/tools/types";
import { describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeContext(): ToolContext {
  return {
    workspaceRoot: "/workspace",
    workingDirectory: "/workspace",
    permissions: {
      filesystemRead: true,
      filesystemWrite: false,
      shellExecution: true,
      gitWrite: false,
      networkAccess: false,
    },
    memory: {
      async search(): Promise<ReadonlyArray<MemoryEntry>> {
        return [];
      },
    },
    logger: { info() {}, error() {} },
  };
}

function makeExecutorWithExitCode(
  exitCode: number,
  stdout = "",
  stderr = "",
): IToolExecutor {
  return {
    async invoke(): Promise<ToolResult<unknown>> {
      return { ok: true, value: { stdout, stderr, exitCode } };
    },
  };
}

function makeCrashingExecutor(): IToolExecutor {
  return {
    async invoke(): Promise<never> {
      throw new Error("Process crashed unexpectedly");
    },
  };
}

function makeToolErrorExecutor(): IToolExecutor {
  return {
    async invoke(): Promise<ToolResult<unknown>> {
      return {
        ok: false,
        error: { type: "runtime", message: "Tool invocation failed" },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// QualityGateRunner: required check pass
// ---------------------------------------------------------------------------

describe("QualityGateRunner — required check passes", () => {
  it("returns outcome: passed when exit code is 0", async () => {
    const runner = new QualityGateRunner(makeExecutorWithExitCode(0, "Lint OK"), makeContext());
    const config: QualityGateConfig = {
      checks: [{ name: "lint", command: "bun run lint", required: true }],
    };

    const results = await runner.run(config);

    expect(results).toHaveLength(1);
    expect(results[0]?.checkName).toBe("lint");
    expect(results[0]?.outcome).toBe("passed");
    expect(results[0]?.required).toBe(true);
  });

  it("returns details from stdout on pass", async () => {
    const runner = new QualityGateRunner(makeExecutorWithExitCode(0, "All good"), makeContext());
    const config: QualityGateConfig = {
      checks: [{ name: "test", command: "bun test", required: true }],
    };

    const results = await runner.run(config);

    expect(results[0]?.outcome).toBe("passed");
    expect(results[0]?.details).toContain("All good");
  });
});

// ---------------------------------------------------------------------------
// QualityGateRunner: required check fails
// ---------------------------------------------------------------------------

describe("QualityGateRunner — required check fails", () => {
  it("returns outcome: failed when exit code is non-zero", async () => {
    const runner = new QualityGateRunner(
      makeExecutorWithExitCode(1, "", "Lint errors found"),
      makeContext(),
    );
    const config: QualityGateConfig = {
      checks: [{ name: "lint", command: "bun run lint", required: true }],
    };

    const results = await runner.run(config);

    expect(results[0]?.outcome).toBe("failed");
    expect(results[0]?.required).toBe(true);
  });

  it("populates details with exit code info on failure", async () => {
    const runner = new QualityGateRunner(
      makeExecutorWithExitCode(1, "", "3 errors"),
      makeContext(),
    );
    const config: QualityGateConfig = {
      checks: [{ name: "lint", command: "bun run lint", required: true }],
    };

    const results = await runner.run(config);

    expect(results[0]?.details).toBeTruthy();
    expect(results[0]?.details.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// QualityGateRunner: advisory check
// ---------------------------------------------------------------------------

describe("QualityGateRunner — advisory check", () => {
  it("returns required: false for advisory checks", async () => {
    const runner = new QualityGateRunner(
      makeExecutorWithExitCode(1, "", "naming warnings"),
      makeContext(),
    );
    const config: QualityGateConfig = {
      checks: [{ name: "naming-check", command: "bun run check-names", required: false }],
    };

    const results = await runner.run(config);

    expect(results[0]?.outcome).toBe("failed");
    expect(results[0]?.required).toBe(false);
  });

  it("advisory failed check does not change its own outcome to passed", async () => {
    const runner = new QualityGateRunner(makeExecutorWithExitCode(1), makeContext());
    const config: QualityGateConfig = {
      checks: [{ name: "advisory", command: "bun run advisory", required: false }],
    };

    const results = await runner.run(config);

    // Advisory check failure is captured — the gate runner records the failure
    // but the required field lets the consumer decide whether to block the commit
    expect(results[0]?.outcome).toBe("failed");
    expect(results[0]?.required).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// QualityGateRunner: config-driven check selection
// ---------------------------------------------------------------------------

describe("QualityGateRunner — config-driven check selection", () => {
  it("returns one result per configured check", async () => {
    const invocations: unknown[] = [];
    const executor: IToolExecutor = {
      async invoke(_name, input): Promise<ToolResult<unknown>> {
        invocations.push(input);
        return { ok: true, value: { stdout: "", stderr: "", exitCode: 0 } };
      },
    };

    const config: QualityGateConfig = {
      checks: [
        { name: "lint", command: "bun run lint", required: true },
        { name: "test", command: "bun test", required: true },
        { name: "types", command: "bun run typecheck", required: false },
      ],
    };

    const runner = new QualityGateRunner(executor, makeContext());
    const results = await runner.run(config);

    expect(results).toHaveLength(3);
    expect(invocations).toHaveLength(3);
    expect(results[0]?.checkName).toBe("lint");
    expect(results[1]?.checkName).toBe("test");
    expect(results[2]?.checkName).toBe("types");
  });

  it("returns empty array when no checks are configured", async () => {
    const runner = new QualityGateRunner(makeExecutorWithExitCode(0), makeContext());
    const config: QualityGateConfig = { checks: [] };

    const results = await runner.run(config);

    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// QualityGateRunner: tool executor failure
// ---------------------------------------------------------------------------

describe("QualityGateRunner — tool executor failure", () => {
  it("marks check as failed when executor throws, does not propagate", async () => {
    const runner = new QualityGateRunner(makeCrashingExecutor(), makeContext());
    const config: QualityGateConfig = {
      checks: [{ name: "lint", command: "bun run lint", required: true }],
    };

    // Must not throw
    const results = await runner.run(config);

    expect(results).toHaveLength(1);
    expect(results[0]?.outcome).toBe("failed");
    expect(results[0]?.required).toBe(true);
    expect(results[0]?.details).toContain("crashed");
  });

  it("marks check as failed when executor returns ok: false", async () => {
    const runner = new QualityGateRunner(makeToolErrorExecutor(), makeContext());
    const config: QualityGateConfig = {
      checks: [{ name: "test", command: "bun test", required: true }],
    };

    const results = await runner.run(config);

    expect(results[0]?.outcome).toBe("failed");
    expect(results[0]?.details).toBeTruthy();
  });

  it("continues running remaining checks even when one executor call throws", async () => {
    let callCount = 0;
    const partialExecutor: IToolExecutor = {
      async invoke(): Promise<ToolResult<unknown>> {
        callCount++;
        if (callCount === 1) {
          throw new Error("First check crashed");
        }
        return { ok: true, value: { stdout: "", stderr: "", exitCode: 0 } };
      },
    };

    const config: QualityGateConfig = {
      checks: [
        { name: "lint", command: "bun run lint", required: true },
        { name: "test", command: "bun test", required: true },
      ],
    };

    const runner = new QualityGateRunner(partialExecutor, makeContext());
    const results = await runner.run(config);

    expect(results).toHaveLength(2);
    expect(results[0]?.outcome).toBe("failed");
    expect(results[1]?.outcome).toBe("passed");
  });
});

// ---------------------------------------------------------------------------
// QualityGateRunner: command parsing
// ---------------------------------------------------------------------------

describe("QualityGateRunner — command parsing", () => {
  it("passes the tool name run_command to the executor", async () => {
    const invokedNames: string[] = [];
    const executor: IToolExecutor = {
      async invoke(name): Promise<ToolResult<unknown>> {
        invokedNames.push(name);
        return { ok: true, value: { stdout: "", stderr: "", exitCode: 0 } };
      },
    };

    const runner = new QualityGateRunner(executor, makeContext());
    await runner.run({
      checks: [{ name: "lint", command: "bun run lint", required: true }],
    });

    expect(invokedNames[0]).toBe("run_command");
  });

  it("splits multi-part command string into command and args", async () => {
    const capturedInputs: unknown[] = [];
    const executor: IToolExecutor = {
      async invoke(_name, input): Promise<ToolResult<unknown>> {
        capturedInputs.push(input);
        return { ok: true, value: { stdout: "", stderr: "", exitCode: 0 } };
      },
    };

    const runner = new QualityGateRunner(executor, makeContext());
    await runner.run({
      checks: [{ name: "lint", command: "bun run lint", required: true }],
    });

    const input = capturedInputs[0] as { command: string; args: string[] };
    expect(input.command).toBe("bun");
    expect(input.args).toEqual(["run", "lint"]);
  });

  it("includes workingDirectory in invocation when specified", async () => {
    const capturedInputs: unknown[] = [];
    const executor: IToolExecutor = {
      async invoke(_name, input): Promise<ToolResult<unknown>> {
        capturedInputs.push(input);
        return { ok: true, value: { stdout: "", stderr: "", exitCode: 0 } };
      },
    };

    const runner = new QualityGateRunner(executor, makeContext());
    await runner.run({
      checks: [
        {
          name: "test",
          command: "bun test",
          required: true,
          workingDirectory: "./orchestrator-ts",
        },
      ],
    });

    const input = capturedInputs[0] as { command: string; args: string[]; cwd?: string };
    expect(input.cwd).toBe("./orchestrator-ts");
  });
});

// ---------------------------------------------------------------------------
// NoopQualityGate stub
// ---------------------------------------------------------------------------

describe("NoopQualityGate", () => {
  it("returns empty array regardless of config", async () => {
    const gate = new NoopQualityGate();
    const config: QualityGateConfig = {
      checks: [
        { name: "lint", command: "bun run lint", required: true },
        { name: "test", command: "bun test", required: false },
      ],
    };

    const results = await gate.run(config);

    expect(results).toHaveLength(0);
  });

  it("does not throw for empty config", async () => {
    const gate = new NoopQualityGate();
    await expect(gate.run({ checks: [] })).resolves.toHaveLength(0);
  });
});
