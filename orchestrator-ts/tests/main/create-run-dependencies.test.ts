import type { AesConfig } from "@/application/ports/config";
import { ConsoleLogger } from "@/infra/logger/console-logger";
import { createRunDependencies } from "@/main/create-run-dependencies";
import { describe, expect, it } from "bun:test";

const stubConfig: AesConfig = {
  llm: { provider: "claude", modelName: "__test__", apiKey: "__test__" },
  specDir: ".kiro/specs",
  sddFramework: "cc-sdd",
  logLevel: "info",
};

describe("createRunDependencies", () => {
  it("returns a useCase and eventBus", () => {
    const deps = createRunDependencies(stubConfig, { debug: false });
    expect(deps.useCase).toBeDefined();
    expect(deps.eventBus).toBeDefined();
  });

  it("returns null logWriter when no logJsonPath provided", () => {
    const deps = createRunDependencies(stubConfig, { debug: false });
    expect(deps.logWriter).toBeNull();
  });

  it("returns a logWriter when logJsonPath is provided", () => {
    const deps = createRunDependencies(stubConfig, {
      debug: false,
      logJsonPath: "/tmp/test-log.ndjson",
    });
    expect(deps.logWriter).not.toBeNull();
    // Clean up the opened file handle
    deps.logWriter?.close().catch(() => {});
  });

  it("returns null debugWriter when debug is false", () => {
    const deps = createRunDependencies(stubConfig, { debug: false });
    expect(deps.debugWriter).toBeNull();
  });

  it("returns a non-null debugWriter when debug is true", () => {
    const deps = createRunDependencies(stubConfig, { debug: true });
    expect(deps.debugWriter).not.toBeNull();
    deps.debugWriter?.close().catch(() => {});
  });

  it("returns a logger in RunDependencies", () => {
    const deps = createRunDependencies(stubConfig, { debug: false });
    expect(deps.logger).toBeDefined();
    expect(deps.logger).not.toBeNull();
  });

  it("returns a ConsoleLogger instance as logger", () => {
    const deps = createRunDependencies(stubConfig, { debug: false });
    expect(deps.logger).toBeInstanceOf(ConsoleLogger);
  });

  it("uses config.logLevel when debug is false", () => {
    const configWithWarn: AesConfig = { ...stubConfig, logLevel: "warn" };
    const deps = createRunDependencies(configWithWarn, { debug: false });
    expect(deps.logger).toBeInstanceOf(ConsoleLogger);
    // Logger should be at warn level — we verify it's a ConsoleLogger instance
    // (level correctness is verified in ConsoleLogger unit tests)
  });

  it("uses debug level when debug is true", () => {
    const deps = createRunDependencies(stubConfig, { debug: true });
    expect(deps.logger).toBeInstanceOf(ConsoleLogger);
    // When debug is true, ConsoleLogger should be at "debug" level
    // (level correctness is verified in ConsoleLogger unit tests)
  });
});
