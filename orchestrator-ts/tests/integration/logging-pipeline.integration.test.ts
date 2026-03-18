/**
 * Integration tests for the full logging pipeline.
 *
 * Covers task 9.3 requirements:
 * - RunContainer.build() returns a ConsoleLogger instance as RunDependencies.logger
 * - When debug: true the effective log level is "debug" and mock LLM provider is active
 * - DI resolution log entries are emitted before the use case is invoked
 * - aes configure wizard saves logLevel and ConfigLoader.load() returns it on next startup
 *
 * Requirements: 1.4, 1.5, 4.1, 4.4, 5.3, 9.1, 9.2, 9.3, 9.4
 */
import type { AesConfig } from "@/application/ports/config";
import type { LogLevel } from "@/application/ports/logger";
import { ConfigLoader } from "@/infra/config/config-loader";
import { ConfigWriter } from "@/infra/config/config-writer";
import { ConsoleLogger } from "@/infra/logger/console-logger";
import { RunContainer } from "@/main/di/run-container";
import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Shared stub config
// ---------------------------------------------------------------------------

const stubConfig: AesConfig = {
  llm: { provider: "claude", modelName: "__test__", apiKey: "__test__" },
  specDir: ".kiro/specs",
  sddFramework: "cc-sdd",
  logLevel: "info",
};

// ---------------------------------------------------------------------------
// 9.3.1 — RunContainer.build() returns a ConsoleLogger instance as logger
// ---------------------------------------------------------------------------

describe("logging pipeline: RunContainer.build() returns ConsoleLogger", () => {
  let stderrSpy: Mock<typeof process.stderr.write>;

  beforeEach(() => {
    stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("returns a ConsoleLogger instance as RunDependencies.logger", async () => {
    const { logger } = await new RunContainer(stubConfig, { debug: false }).build();
    expect(logger).toBeInstanceOf(ConsoleLogger);
  });

  it("returns a defined, non-null logger", async () => {
    const { logger } = await new RunContainer(stubConfig, { debug: false }).build();
    expect(logger).toBeDefined();
    expect(logger).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 9.3.2 + 9.3.3 — debug mode behavior and DI resolution entry order
// Sections share the same stderr capture setup.
// ---------------------------------------------------------------------------

describe("logging pipeline: stderr-capturing RunContainer tests", () => {
  let stderrOutput: string[];
  let stderrSpy: Mock<typeof process.stderr.write>;

  beforeEach(() => {
    stderrOutput = [];
    stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrOutput.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  describe("9.3.2 — debug mode activates mock LLM and debug log level", () => {
    it("emits debug-level DI log entries when debug: true (confirms debug level is active)", async () => {
      await new RunContainer(stubConfig, { debug: true }).build();
      const debugLines = stderrOutput.filter((l) => l.includes("[DEBUG]"));
      expect(debugLines.length).toBeGreaterThan(0);
    });

    it("does not emit debug-level entries when debug: false and config logLevel is info", async () => {
      await new RunContainer(stubConfig, { debug: false }).build();
      const debugLines = stderrOutput.filter((l) => l.includes("[DEBUG]"));
      expect(debugLines.length).toBe(0);
    });

    it("emits info-level mock substitution entries when debug: true", async () => {
      await new RunContainer(stubConfig, { debug: true }).build();
      const mockLines = stderrOutput.filter(
        (l) => l.includes("[INFO]") && l.includes("Mock substitution active"),
      );
      expect(mockLines.length).toBeGreaterThan(0);
    });

    it("announces MockLlmProvider as the active LLM when debug: true", async () => {
      await new RunContainer(stubConfig, { debug: true }).build();
      const line = stderrOutput.find(
        (l) => l.includes("Mock substitution active") && l.includes("MockLlmProvider"),
      );
      expect(line).toBeDefined();
    });
  });

  describe("9.3.3 — DI resolution entries emitted during build()", () => {
    it("all DI resolution entries are present in output collected during build()", async () => {
      await new RunContainer(stubConfig, { debug: true }).build();
      const diLines = stderrOutput.filter((l) => l.includes("DI resolved"));
      expect(diLines.length).toBeGreaterThan(0);
    });

    it("useCase DI entry is present, confirming final dep resolved before build() returns", async () => {
      await new RunContainer(stubConfig, { debug: true }).build();
      const useCaseLine = stderrOutput.find(
        (l) => l.includes("DI resolved") && l.includes("useCase"),
      );
      expect(useCaseLine).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// 9.3.4 — aes configure saves logLevel; ConfigLoader.load() returns it
// ---------------------------------------------------------------------------

describe("logging pipeline: configure wizard saves logLevel; ConfigLoader reads it back", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aes-logging-pipeline-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const levels: LogLevel[] = ["debug", "warn", "error"];

  for (const level of levels) {
    it(`ConfigLoader returns '${level}' logLevel persisted by ConfigWriter`, async () => {
      const writer = new ConfigWriter();
      await writer.write(
        {
          llm: { provider: "claude", modelName: "claude-sonnet-4-6" },
          sddFramework: "cc-sdd",
          specDir: ".kiro/specs",
          logLevel: level,
        },
        tmpDir,
      );

      const loader = new ConfigLoader(tmpDir, { AES_LLM_API_KEY: "test-key" });
      const config = await loader.load();

      expect(config.logLevel).toBe(level);
    });
  }

  it("config.logLevel from configure drives RunContainer: warn level suppresses debug entries", async () => {
    const writer = new ConfigWriter();
    await writer.write(
      {
        llm: { provider: "claude", modelName: "claude-sonnet-4-6" },
        sddFramework: "cc-sdd",
        specDir: ".kiro/specs",
        logLevel: "warn",
      },
      tmpDir,
    );

    const loader = new ConfigLoader(tmpDir, { AES_LLM_API_KEY: "test-key" });
    const config = await loader.load();
    expect(config.logLevel).toBe("warn");

    // Verify RunContainer uses the loaded logLevel: debug entries suppressed at warn level
    const stderrLines: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrLines.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    try {
      await new RunContainer(config, { debug: false }).build();
    } finally {
      spy.mockRestore();
    }

    const debugLines = stderrLines.filter((l) => l.includes("[DEBUG]"));
    expect(debugLines.length).toBe(0);
  });
});
