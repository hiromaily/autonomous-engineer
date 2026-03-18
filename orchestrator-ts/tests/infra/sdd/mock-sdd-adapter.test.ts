import type { LlmProviderPort } from "@/application/ports/llm";
import type { SpecContext } from "@/application/ports/sdd";
import { PhaseRunner } from "@/application/services/workflow/phase-runner";
import { CC_SDD_FRAMEWORK_DEFINITION } from "@/infra/sdd/cc-sdd-framework-definition";
import { MockSddAdapter } from "@/infra/sdd/mock-sdd-adapter";
import { describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ctx: SpecContext = { specName: "test-spec", specDir: ".kiro/specs/test-spec", language: "en" };

function makeLlmProvider(): LlmProviderPort {
  return {
    complete: mock(() =>
      Promise.resolve({ ok: true as const, value: { content: "", usage: { inputTokens: 0, outputTokens: 0 } } })
    ),
    clearContext: mock(() => {}),
  };
}

// ---------------------------------------------------------------------------
// MockSddAdapter — invocation recording
// ---------------------------------------------------------------------------

describe("MockSddAdapter — invocation recording", () => {
  it("records each executeCommand call in the invocations array", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "mock-sdd-inv-"));
    try {
      const ctxWithDir: SpecContext = { ...ctx, specDir: tmpDir };
      const adapter = new MockSddAdapter();

      await adapter.executeCommand("kiro:spec-init", ctxWithDir);
      await adapter.executeCommand("kiro:spec-requirements", ctxWithDir);

      expect(adapter.invocations).toEqual(["kiro:spec-init", "kiro:spec-requirements"]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("records unknown command names in invocations", async () => {
    const adapter = new MockSddAdapter();
    await adapter.executeCommand("unknown-command", ctx);
    expect(adapter.invocations).toContain("unknown-command");
  });

  it.each(
    [
      "kiro:spec-init",
      "kiro:spec-requirements",
      "kiro:validate-gap",
      "kiro:spec-design",
      "kiro:validate-design",
      "kiro:spec-tasks",
    ] as const,
  )("records '%s' in invocations when called", async (commandName) => {
    const tmpDir = await mkdtemp(join(tmpdir(), "mock-sdd-cmd-"));
    try {
      const ctxWithDir: SpecContext = { ...ctx, specDir: tmpDir };
      const adapter = new MockSddAdapter();

      await adapter.executeCommand(commandName, ctxWithDir);

      expect(adapter.invocations).toContain(commandName);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// PhaseRunner + CC_SDD_FRAMEWORK_DEFINITION — exact LLM prompt dispatch
// ---------------------------------------------------------------------------

describe("PhaseRunner with CC_SDD_FRAMEWORK_DEFINITION — exact prompt dispatch", () => {
  it("calls llm.complete() with the exact interpolated prompt from CC_SDD_FRAMEWORK_DEFINITION for VALIDATE_PREREQUISITES", async () => {
    const llm = makeLlmProvider();
    const runner = new PhaseRunner({
      sdd: new MockSddAdapter(),
      llm,
      frameworkDefinition: CC_SDD_FRAMEWORK_DEFINITION,
    });

    await runner.execute("VALIDATE_PREREQUISITES", ctx);

    const phaseDef = CC_SDD_FRAMEWORK_DEFINITION.phases.find((p) => p.phase === "VALIDATE_PREREQUISITES");
    expect(phaseDef).toBeDefined();
    const expectedPrompt = phaseDef!.content
      .replaceAll("{specDir}", ctx.specDir)
      .replaceAll("{specName}", ctx.specName)
      .replaceAll("{language}", ctx.language);

    expect(llm.complete).toHaveBeenCalledWith(expectedPrompt);
  });

  it("calls sdd.executeCommand() with the correct kiro: command for SPEC_REQUIREMENTS llm_slash_command phase", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "mock-sdd-phase-"));
    try {
      const ctxWithDir: SpecContext = { ...ctx, specDir: tmpDir };
      const sdd = new MockSddAdapter();
      const runner = new PhaseRunner({
        sdd,
        llm: makeLlmProvider(),
        frameworkDefinition: CC_SDD_FRAMEWORK_DEFINITION,
      });

      await runner.execute("SPEC_REQUIREMENTS", ctxWithDir);

      expect(sdd.invocations).toContain("kiro:spec-requirements");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
