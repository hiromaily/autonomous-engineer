import { describe, expect, it } from "bun:test";
import { TempDirSandboxExecutor } from "../../../src/adapters/safety/sandbox-executor";
import type { SandboxExecutionRequest } from "../../../src/application/safety/ports";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<SandboxExecutionRequest> = {}): SandboxExecutionRequest {
  return {
    command: "echo",
    args: ["hello"],
    workingDirectory: "/tmp",
    method: "temp-directory",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// TempDirSandboxExecutor tests
// ---------------------------------------------------------------------------

describe("TempDirSandboxExecutor", () => {
  describe("execute()", () => {
    it("captures stdout from the command", async () => {
      const executor = new TempDirSandboxExecutor();
      const result = await executor.execute(makeRequest({ command: "echo", args: ["hello world"] }), 5_000);

      expect(result.stdout.trim()).toBe("hello world");
      expect(result.exitCode).toBe(0);
    });

    it("captures stderr from the command", async () => {
      const executor = new TempDirSandboxExecutor();
      const result = await executor.execute(
        makeRequest({ command: "sh", args: ["-c", "echo err >&2"] }),
        5_000,
      );

      expect(result.stderr.trim()).toBe("err");
    });

    it("returns the correct non-zero exit code", async () => {
      const executor = new TempDirSandboxExecutor();
      const result = await executor.execute(
        makeRequest({ command: "sh", args: ["-c", "exit 42"] }),
        5_000,
      );

      expect(result.exitCode).toBe(42);
    });

    it("reports positive durationMs", async () => {
      const executor = new TempDirSandboxExecutor();
      const result = await executor.execute(makeRequest({ command: "echo", args: ["hi"] }), 5_000);

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("rejects when the command is not found (setup failure)", async () => {
      const executor = new TempDirSandboxExecutor();

      await expect(
        executor.execute(makeRequest({ command: "non_existent_cmd_xyz_abc_123" }), 5_000),
      ).rejects.toThrow();
    });

    it("rejects with timeout error when execution exceeds timeoutMs", async () => {
      const executor = new TempDirSandboxExecutor();

      await expect(
        executor.execute(
          makeRequest({ command: "sh", args: ["-c", "sleep 10"] }),
          50, // 50ms timeout — will expire before sleep finishes
        ),
      ).rejects.toThrow(/timeout/i);
    });

    it("cleans up the temp directory after successful execution", async () => {
      const executor = new TempDirSandboxExecutor();
      let capturedTempDir = "";

      // Run a command that writes to $PWD so we can observe the temp dir path
      const result = await executor.execute(
        makeRequest({ command: "sh", args: ["-c", "echo $PWD"] }),
        5_000,
      );
      capturedTempDir = result.stdout.trim();

      // The working directory used during execution should no longer exist
      const { access } = await import("node:fs/promises");
      await expect(access(capturedTempDir)).rejects.toThrow();
    });

    it("cleans up temp directory even when the command fails", async () => {
      const executor = new TempDirSandboxExecutor();

      const result = await executor.execute(
        makeRequest({ command: "sh", args: ["-c", "echo $PWD; exit 1"] }),
        5_000,
      );
      const tempDir = result.stdout.trim();

      const { access } = await import("node:fs/promises");
      await expect(access(tempDir)).rejects.toThrow();
    });
  });
});
