import type { ISandboxExecutor, SandboxExecutionRequest, SandboxExecutionResult } from "@/application/safety/ports";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Sandbox executor using an isolated temporary directory.
 *
 * For each execution:
 *  1. Creates a fresh temp directory under os.tmpdir().
 *  2. Spawns the command with the temp dir as its working directory.
 *  3. Enforces the timeoutMs; rejects with a timeout error if exceeded.
 *  4. Removes the temp directory after execution, even on failure.
 *
 * Only the 'temp-directory' method is supported by this adapter; the
 * 'container' method requires a separate implementation.
 */
export class TempDirSandboxExecutor implements ISandboxExecutor {
  async execute(request: SandboxExecutionRequest, timeoutMs: number): Promise<SandboxExecutionResult> {
    const tempDir = await mkdtemp(join(tmpdir(), "aes-sandbox-"));

    try {
      return await this.runWithTimeout(request, tempDir, timeoutMs);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private runWithTimeout(
    request: SandboxExecutionRequest,
    cwd: string,
    timeoutMs: number,
  ): Promise<SandboxExecutionResult> {
    return new Promise((resolve, reject) => {
      const startMs = Date.now();

      const proc = Bun.spawn([request.command, ...request.args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill();
        } catch { /* ignore */ }
        reject(new Error(`Sandbox execution timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.exited.then(async (exitCode) => {
        clearTimeout(timer);
        if (timedOut) return; // outer promise already rejected
        const durationMs = Date.now() - startMs;

        const stdoutBuf = await new Response(proc.stdout).text();
        const stderrBuf = await new Response(proc.stderr).text();

        resolve({
          stdout: stdoutBuf,
          stderr: stderrBuf,
          exitCode,
          durationMs,
        });
      }).catch((err: unknown) => {
        clearTimeout(timer);
        if (!timedOut) reject(err);
      });
    });
  }
}
