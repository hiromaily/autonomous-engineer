import type { AesConfig } from "@/application/ports/config";
import { createRunDependencies } from "@/infra/bootstrap/create-run-dependencies";
import { describe, expect, it } from "bun:test";

const stubConfig: AesConfig = {
  llm: { provider: "claude", modelName: "__test__", apiKey: "__test__" },
  specDir: ".kiro/specs",
  sddFramework: "cc-sdd",
};

describe("createRunDependencies", () => {
  it("returns a useCase and eventBus", () => {
    const deps = createRunDependencies(stubConfig, { debugFlow: false });
    expect(deps.useCase).toBeDefined();
    expect(deps.eventBus).toBeDefined();
  });

  it("returns null logWriter when no logJsonPath provided", () => {
    const deps = createRunDependencies(stubConfig, { debugFlow: false });
    expect(deps.logWriter).toBeNull();
  });

  it("returns a logWriter when logJsonPath is provided", () => {
    const deps = createRunDependencies(stubConfig, {
      debugFlow: false,
      logJsonPath: "/tmp/test-log.ndjson",
    });
    expect(deps.logWriter).not.toBeNull();
    // Clean up the opened file handle
    deps.logWriter?.close().catch(() => {});
  });

  it("returns null debugWriter when debugFlow is false", () => {
    const deps = createRunDependencies(stubConfig, { debugFlow: false });
    expect(deps.debugWriter).toBeNull();
  });

  it("returns a non-null debugWriter when debugFlow is true", () => {
    const deps = createRunDependencies(stubConfig, { debugFlow: true });
    expect(deps.debugWriter).not.toBeNull();
    deps.debugWriter?.close().catch(() => {});
  });
});
