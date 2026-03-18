import type { AesConfig } from "@/application/ports/config";
import { RunContainer } from "@/main/di/run-container";
import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";

const stubConfig: AesConfig = {
  llm: { provider: "claude", modelName: "__test__", apiKey: "__test__" },
  specDir: ".kiro/specs",
  sddFramework: "cc-sdd",
  logLevel: "info",
};

// ---------------------------------------------------------------------------
// Task 7 — Framework selection via TypeScriptFrameworkDefinitionLoader
// ---------------------------------------------------------------------------

describe("RunContainer — framework definition loading (Task 7)", () => {
  it("build() returns a Promise (is async)", () => {
    const result = new RunContainer(stubConfig, { debug: false }).build();
    expect(result).toBeInstanceOf(Promise);
    result.then((deps) => deps.logWriter?.close()).catch(() => {});
  });

  it("build() resolves successfully when sddFramework is 'cc-sdd'", async () => {
    const deps = await new RunContainer(stubConfig, { debug: false }).build();
    expect(deps.useCase).toBeDefined();
  });

  it("build() rejects with unknown-framework error when sddFramework is not registered", async () => {
    const config: AesConfig = { ...stubConfig, sddFramework: "openspec" };
    await expect(new RunContainer(config, { debug: false }).build()).rejects.toThrow("openspec");
  });

  it("debug mode also loads framework via config.sddFramework", async () => {
    const deps = await new RunContainer(stubConfig, { debug: true }).build();
    expect(deps.useCase).toBeDefined();
    deps.debugWriter?.close().catch(() => {});
  });
});

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

// ---------------------------------------------------------------------------
// Task 8 — Emit DI resolution log entries from RunContainer.build()
// ---------------------------------------------------------------------------

describe("RunContainer.build() — DI resolution logging", () => {
  it("emits debug-level DI resolved entries when debug mode is on", async () => {
    await new RunContainer(stubConfig, { debug: true }).build();
    const debugDiLines = stderrOutput.filter(
      (l) => l.includes("[DEBUG]") && l.includes("DI resolved"),
    );
    expect(debugDiLines.length).toBeGreaterThan(0);
  });

  it("emits a debug entry naming eventBus and its concrete impl", async () => {
    await new RunContainer(stubConfig, { debug: true }).build();
    const line = stderrOutput.find(
      (l) => l.includes("DI resolved") && l.includes("eventBus"),
    );
    expect(line).toBeDefined();
    expect(line).toContain("WorkflowEventBus");
  });

  it("emits a debug entry naming logger and its concrete impl", async () => {
    await new RunContainer(stubConfig, { debug: true }).build();
    const line = stderrOutput.find(
      (l) => l.includes("DI resolved") && l.includes("logger"),
    );
    expect(line).toBeDefined();
    expect(line).toContain("ConsoleLogger");
  });

  it("emits a debug entry naming useCase and its concrete impl", async () => {
    await new RunContainer(stubConfig, { debug: true }).build();
    const line = stderrOutput.find(
      (l) => l.includes("DI resolved") && l.includes("useCase"),
    );
    expect(line).toBeDefined();
    expect(line).toContain("RunSpecUseCase");
  });

  it("emits a debug entry naming memory and its concrete impl", async () => {
    await new RunContainer(stubConfig, { debug: true }).build();
    const line = stderrOutput.find(
      (l) => l.includes("DI resolved") && l.includes("memory"),
    );
    expect(line).toBeDefined();
    expect(line).toContain("FileMemoryStore");
  });

  it("emits info-level mock substitution entry for LLM provider when debug is true", async () => {
    await new RunContainer(stubConfig, { debug: true }).build();
    const line = stderrOutput.find(
      (l) =>
        l.includes("[INFO]")
        && l.includes("Mock substitution active")
        && l.includes("MockLlmProvider"),
    );
    expect(line).toBeDefined();
  });

  it("emits info-level mock substitution entry for SDD adapter when debug is true", async () => {
    await new RunContainer(stubConfig, { debug: true }).build();
    const line = stderrOutput.find(
      (l) =>
        l.includes("[INFO]")
        && l.includes("Mock substitution active")
        && l.includes("MockSddAdapter"),
    );
    expect(line).toBeDefined();
  });

  it("does not emit mock substitution entries when debug is false", async () => {
    await new RunContainer(stubConfig, { debug: false }).build();
    const mockLine = stderrOutput.find((l) => l.includes("Mock substitution active"));
    expect(mockLine).toBeUndefined();
  });

  it("DI resolution entries are emitted during build() before use case is invoked", async () => {
    // build() resolves with all DI entries emitted as a side effect before returning.
    // We verify by collecting all output produced during build().
    await new RunContainer(stubConfig, { debug: true }).build();
    const diLines = stderrOutput.filter((l) => l.includes("DI resolved"));
    expect(diLines.length).toBeGreaterThan(0);
    // useCase entry should be present, showing final dep resolved before return
    const useCaseLine = diLines.find((l) => l.includes("useCase"));
    expect(useCaseLine).toBeDefined();
  });
});
