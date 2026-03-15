/**
 * E2E tests for `aes run` missing-configuration error messages.
 *
 * Verifies that when configuration is missing or incomplete:
 * - Req 1.1: stderr includes an instruction to run `aes configure`
 * - Req 1.2: stderr warns about AES_LLM_API_KEY when that variable is absent
 * - Req 1.3: no interactive prompts are launched
 *
 * Task 5.2 / 7.2 — Requirements: 1.1, 1.2, 1.3
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "../../src/cli/index.ts");

async function runCli(args: string[], opts: { cwd: string; env?: Record<string, string | undefined> }): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const env: Record<string, string> = {};
  // Copy only defined env vars, stripping undefined
  for (const [k, v] of Object.entries(opts.env ?? process.env)) {
    if (v !== undefined) env[k] = v;
  }
  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [exitCode, stdoutBuf, stderrBuf] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout: stdoutBuf, stderr: stderrBuf };
}

describe("aes run: missing-configuration error messages", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aes-missing-config-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("Req 1.1: instructs user to run aes configure", () => {
    it("stderr contains 'aes configure' when no config file and no env vars", async () => {
      const { exitCode, stderr } = await runCli(["run", "my-spec"], {
        cwd: tmpDir,
        env: {
          // Explicitly omit all AES_ config env vars so config fails
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
      });

      expect(exitCode).toBe(1);
      expect(stderr).toContain("aes configure");
    });

    it("exits with code 1 when configuration is missing", async () => {
      const { exitCode } = await runCli(["run", "my-spec"], {
        cwd: tmpDir,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
      });

      expect(exitCode).toBe(1);
    });
  });

  describe("Req 1.2: warns about AES_LLM_API_KEY when it is absent", () => {
    it("stderr warns about AES_LLM_API_KEY when API key is missing but other fields present", async () => {
      // Write a config file that has provider and model but no apiKey
      await writeFile(
        join(tmpDir, "aes.config.json"),
        JSON.stringify({
          llm: { provider: "claude", modelName: "claude-sonnet-4-6" },
          specDir: ".kiro/specs",
          sddFramework: "cc-sdd",
        }),
      );

      const { exitCode, stderr } = await runCli(["run", "my-spec"], {
        cwd: tmpDir,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          // AES_LLM_API_KEY intentionally absent
        },
      });

      expect(exitCode).toBe(1);
      expect(stderr).toContain("AES_LLM_API_KEY");
    });

    it("does NOT warn about AES_LLM_API_KEY when it is set via env var but other fields missing", async () => {
      const { exitCode, stderr } = await runCli(["run", "my-spec"], {
        cwd: tmpDir,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          AES_LLM_API_KEY: "some-key",
          // provider and modelName intentionally absent
        },
      });

      expect(exitCode).toBe(1);
      expect(stderr).not.toContain("AES_LLM_API_KEY");
    });
  });

  describe("Req 1.3: no interactive prompts launched from aes run", () => {
    it("exits immediately without blocking when stdin is not a TTY", async () => {
      const start = Date.now();

      const { exitCode } = await runCli(["run", "my-spec"], {
        cwd: tmpDir,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
      });

      const elapsed = Date.now() - start;
      expect(exitCode).toBe(1);
      // Should exit quickly (< 10 seconds), confirming no blocking prompt
      expect(elapsed).toBeLessThan(10_000);
    });
  });
});
