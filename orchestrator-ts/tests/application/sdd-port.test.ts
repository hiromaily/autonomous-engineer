import type { SddFrameworkPort, SddOperationResult, SpecContext } from "@/application/ports/sdd";
import { describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// SddOperationResult discriminated union
// ---------------------------------------------------------------------------

describe("SddOperationResult discriminated union", () => {
  it("narrows to artifactPath on ok: true", () => {
    const result: SddOperationResult = {
      ok: true,
      artifactPath: ".kiro/specs/my-feature/requirements.md",
    };

    if (result.ok) {
      expect(result.artifactPath).toBe(".kiro/specs/my-feature/requirements.md");
    } else {
      throw new Error("Expected ok: true");
    }
  });

  it("narrows to error with exitCode and stderr on ok: false", () => {
    const result: SddOperationResult = {
      ok: false,
      error: { exitCode: 1, stderr: "command not found: cc-sdd" },
    };

    if (!result.ok) {
      expect(result.error.exitCode).toBe(1);
      expect(result.error.stderr).toBe("command not found: cc-sdd");
    } else {
      throw new Error("Expected ok: false");
    }
  });

  it("exitCode 0 is a valid non-ok result (e.g. validation failure distinguished from crash)", () => {
    const result: SddOperationResult = {
      ok: false,
      error: { exitCode: 0, stderr: "" },
    };
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SpecContext shape
// ---------------------------------------------------------------------------

describe("SpecContext", () => {
  it("accepts specName, specDir, and language", () => {
    const ctx: SpecContext = {
      specName: "orchestrator-core",
      specDir: ".kiro/specs",
      language: "en",
    };

    expect(ctx.specName).toBe("orchestrator-core");
    expect(ctx.specDir).toBe(".kiro/specs");
    expect(ctx.language).toBe("en");
  });
});

// ---------------------------------------------------------------------------
// SddFrameworkPort contract via mock
// ---------------------------------------------------------------------------

describe("SddFrameworkPort contract (mock implementation)", () => {
  function makeAdapter(result: SddOperationResult): SddFrameworkPort {
    return {
      validatePrerequisites: async (_ctx: SpecContext) => result,
      generateRequirements: async (_ctx: SpecContext) => result,
      validateRequirements: async (_ctx: SpecContext) => result,
      reflectBeforeDesign: async (_ctx: SpecContext) => result,
      reflectBeforeTasks: async (_ctx: SpecContext) => result,
      validateGap: async (_ctx: SpecContext) => result,
      generateDesign: async (_ctx: SpecContext) => result,
      validateDesign: async (_ctx: SpecContext) => result,
      generateTasks: async (_ctx: SpecContext) => result,
      validateTasks: async (_ctx: SpecContext) => result,
    };
  }

  const ctx: SpecContext = { specName: "test", specDir: ".kiro/specs", language: "en" };

  it("validatePrerequisites returns SddOperationResult", async () => {
    const adapter = makeAdapter({ ok: true, artifactPath: "requirements.md" });
    const result = await adapter.validatePrerequisites(ctx);
    expect(result.ok).toBe(true);
  });

  it("generateRequirements returns SddOperationResult", async () => {
    const adapter = makeAdapter({ ok: true, artifactPath: "requirements.md" });
    const result = await adapter.generateRequirements(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.artifactPath).toBe("requirements.md");
  });

  it("validateRequirements returns SddOperationResult", async () => {
    const adapter = makeAdapter({ ok: true, artifactPath: "requirements.md" });
    const result = await adapter.validateRequirements(ctx);
    expect(result.ok).toBe(true);
  });

  it("reflectBeforeDesign returns SddOperationResult", async () => {
    const adapter = makeAdapter({ ok: true, artifactPath: "requirements.md" });
    const result = await adapter.reflectBeforeDesign(ctx);
    expect(result.ok).toBe(true);
  });

  it("reflectBeforeTasks returns SddOperationResult", async () => {
    const adapter = makeAdapter({ ok: true, artifactPath: "design.md" });
    const result = await adapter.reflectBeforeTasks(ctx);
    expect(result.ok).toBe(true);
  });

  it("validateGap returns SddOperationResult", async () => {
    const adapter = makeAdapter({ ok: true, artifactPath: "requirements.md" });
    const result = await adapter.validateGap(ctx);
    expect(result.ok).toBe(true);
  });

  it("generateDesign returns SddOperationResult", async () => {
    const adapter = makeAdapter({ ok: true, artifactPath: "design.md" });
    const result = await adapter.generateDesign(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.artifactPath).toBe("design.md");
  });

  it("validateDesign returns SddOperationResult", async () => {
    const adapter = makeAdapter({ ok: true, artifactPath: "design.md" });
    const result = await adapter.validateDesign(ctx);
    expect(result.ok).toBe(true);
  });

  it("generateTasks returns SddOperationResult", async () => {
    const adapter = makeAdapter({ ok: true, artifactPath: "tasks.md" });
    const result = await adapter.generateTasks(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.artifactPath).toBe("tasks.md");
  });

  it("validateTasks returns SddOperationResult", async () => {
    const adapter = makeAdapter({ ok: true, artifactPath: "tasks.md" });
    const result = await adapter.validateTasks(ctx);
    expect(result.ok).toBe(true);
  });

  it("all operations can return failure result", async () => {
    const failure: SddOperationResult = { ok: false, error: { exitCode: 127, stderr: "not found" } };
    const adapter = makeAdapter(failure);

    for (
      const op of [
        adapter.validatePrerequisites(ctx),
        adapter.generateRequirements(ctx),
        adapter.validateRequirements(ctx),
        adapter.reflectBeforeDesign(ctx),
        adapter.reflectBeforeTasks(ctx),
        adapter.validateGap(ctx),
        adapter.generateDesign(ctx),
        adapter.validateDesign(ctx),
        adapter.generateTasks(ctx),
        adapter.validateTasks(ctx),
      ]
    ) {
      const result = await op;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.exitCode).toBe(127);
        expect(result.error.stderr).toBe("not found");
      }
    }
  });
});
