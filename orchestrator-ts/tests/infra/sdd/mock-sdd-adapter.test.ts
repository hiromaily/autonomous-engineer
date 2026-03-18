import type { SpecContext } from "@/application/ports/sdd";
import { PhaseRunner } from "@/application/services/workflow/phase-runner";
import type { FrameworkDefinition } from "@/domain/workflow/framework";
import { YamlWorkflowDefinitionLoader } from "@/infra/sdd/yaml-workflow-definition-loader";
import { MockSddAdapter } from "@/infra/sdd/mock-sdd-adapter";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLlmProvider } from "../../helpers/workflow";

// ---- Framework definition (loaded once via YamlWorkflowDefinitionLoader) ---

let CC_SDD_FRAMEWORK_DEFINITION: FrameworkDefinition;

beforeAll(async () => {
  const loader = new YamlWorkflowDefinitionLoader(join(process.cwd(), ".aes", "workflow"));
  CC_SDD_FRAMEWORK_DEFINITION = await loader.load("cc-sdd");
});

const ctx: SpecContext = { specName: "test-spec", specDir: ".kiro/specs/test-spec", language: "en" };

// ---------------------------------------------------------------------------
// MockSddAdapter — invocation recording
// ---------------------------------------------------------------------------

describe("MockSddAdapter — invocation recording", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "mock-sdd-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("records each executeCommand call in the invocations array", async () => {
    const ctxWithDir: SpecContext = { ...ctx, specDir: tmpDir };
    const adapter = new MockSddAdapter();

    await adapter.executeCommand("kiro:spec-init", ctxWithDir);
    await adapter.executeCommand("kiro:spec-requirements", ctxWithDir);

    expect(adapter.invocations).toEqual(["kiro:spec-init", "kiro:spec-requirements"]);
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
    const ctxWithDir: SpecContext = { ...ctx, specDir: tmpDir };
    const adapter = new MockSddAdapter();

    await adapter.executeCommand(commandName, ctxWithDir);

    expect(adapter.invocations).toContain(commandName);
  });
});

// ---------------------------------------------------------------------------
// PhaseRunner + CC_SDD_FRAMEWORK_DEFINITION — exact LLM prompt dispatch
// ---------------------------------------------------------------------------

describe("PhaseRunner with CC_SDD_FRAMEWORK_DEFINITION — exact prompt dispatch", () => {
  it("calls llm.complete() with the exact interpolated prompt from CC_SDD_FRAMEWORK_DEFINITION for VALIDATE_PREREQUISITES", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "mock-sdd-prompt-"));
    try {
      const ctxWithDir: SpecContext = { ...ctx, specDir: tmpDir };
      const llm = makeLlmProvider();
      const runner = new PhaseRunner({
        sdd: new MockSddAdapter(),
        llm,
        frameworkDefinition: CC_SDD_FRAMEWORK_DEFINITION,
      });

      await runner.execute("VALIDATE_PREREQUISITES", ctxWithDir);

      const phaseDef = CC_SDD_FRAMEWORK_DEFINITION.phases.find((p) => p.phase === "VALIDATE_PREREQUISITES");
      expect(phaseDef).toBeDefined();
      const expectedPrompt = phaseDef!.content
        .replaceAll("{specDir}", ctxWithDir.specDir)
        .replaceAll("{specName}", ctxWithDir.specName)
        .replaceAll("{language}", ctxWithDir.language);

      expect(llm.complete).toHaveBeenCalledWith(expectedPrompt);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
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
