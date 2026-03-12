import { describe, expect, it, mock } from "bun:test";
import type { LlmProviderPort } from "../../application/ports/llm";
import type { SddFrameworkPort, SddOperationResult, SpecContext } from "../../application/ports/sdd";
import { PhaseRunner } from "../../domain/workflow/phase-runner";
import type { WorkflowPhase } from "../../domain/workflow/types";

const ctx: SpecContext = {
  specName: "my-spec",
  specDir: ".kiro/specs",
  language: "en",
};

function makeSddAdapter(result: SddOperationResult): SddFrameworkPort {
  return {
    generateRequirements: mock(() => Promise.resolve(result)),
    generateDesign: mock(() => Promise.resolve(result)),
    validateDesign: mock(() => Promise.resolve(result)),
    generateTasks: mock(() => Promise.resolve(result)),
  };
}

function makeLlmProvider(): LlmProviderPort {
  return {
    complete: mock(() =>
      Promise.resolve({ ok: true as const, value: { content: "", usage: { inputTokens: 0, outputTokens: 0 } } })
    ),
    clearContext: mock(() => {}),
  };
}

describe("PhaseRunner", () => {
  describe("execute - SDD-backed phases", () => {
    it("dispatches REQUIREMENTS to generateRequirements and returns artifact path", async () => {
      const sdd = makeSddAdapter({ ok: true, artifactPath: ".kiro/specs/my-spec/requirements.md" });
      const runner = new PhaseRunner({ sdd, llm: makeLlmProvider() });
      const result = await runner.execute("REQUIREMENTS", ctx);

      expect(sdd.generateRequirements).toHaveBeenCalledWith(ctx);
      expect(result).toEqual({ ok: true, artifacts: [".kiro/specs/my-spec/requirements.md"] });
    });

    it("dispatches DESIGN to generateDesign and returns artifact path", async () => {
      const sdd = makeSddAdapter({ ok: true, artifactPath: ".kiro/specs/my-spec/design.md" });
      const runner = new PhaseRunner({ sdd, llm: makeLlmProvider() });
      const result = await runner.execute("DESIGN", ctx);

      expect(sdd.generateDesign).toHaveBeenCalledWith(ctx);
      expect(result).toEqual({ ok: true, artifacts: [".kiro/specs/my-spec/design.md"] });
    });

    it("dispatches VALIDATE_DESIGN to validateDesign and returns artifact path", async () => {
      const sdd = makeSddAdapter({ ok: true, artifactPath: ".kiro/specs/my-spec/design-review.md" });
      const runner = new PhaseRunner({ sdd, llm: makeLlmProvider() });
      const result = await runner.execute("VALIDATE_DESIGN", ctx);

      expect(sdd.validateDesign).toHaveBeenCalledWith(ctx);
      expect(result).toEqual({ ok: true, artifacts: [".kiro/specs/my-spec/design-review.md"] });
    });

    it("dispatches TASK_GENERATION to generateTasks and returns artifact path", async () => {
      const sdd = makeSddAdapter({ ok: true, artifactPath: ".kiro/specs/my-spec/tasks.md" });
      const runner = new PhaseRunner({ sdd, llm: makeLlmProvider() });
      const result = await runner.execute("TASK_GENERATION", ctx);

      expect(sdd.generateTasks).toHaveBeenCalledWith(ctx);
      expect(result).toEqual({ ok: true, artifacts: [".kiro/specs/my-spec/tasks.md"] });
    });

    it("maps SDD failure to PhaseResult error", async () => {
      const sdd = makeSddAdapter({ ok: false, error: { exitCode: 1, stderr: "cc-sdd: spec not found" } });
      const runner = new PhaseRunner({ sdd, llm: makeLlmProvider() });
      const result = await runner.execute("REQUIREMENTS", ctx);

      expect(result).toEqual({ ok: false, error: "cc-sdd: spec not found (exit 1)" });
    });

    it("maps SDD failure with empty stderr gracefully", async () => {
      const sdd = makeSddAdapter({ ok: false, error: { exitCode: 2, stderr: "" } });
      const runner = new PhaseRunner({ sdd, llm: makeLlmProvider() });
      const result = await runner.execute("DESIGN", ctx);

      expect(result).toEqual({ ok: false, error: "SDD adapter failed (exit 2)" });
    });
  });

  describe("execute - stub phases", () => {
    it("returns success with empty artifacts for SPEC_INIT", async () => {
      const runner = new PhaseRunner({ sdd: makeSddAdapter({ ok: true, artifactPath: "" }), llm: makeLlmProvider() });
      const result = await runner.execute("SPEC_INIT", ctx);
      expect(result).toEqual({ ok: true, artifacts: [] });
    });

    it("returns success with empty artifacts for IMPLEMENTATION", async () => {
      const runner = new PhaseRunner({ sdd: makeSddAdapter({ ok: true, artifactPath: "" }), llm: makeLlmProvider() });
      const result = await runner.execute("IMPLEMENTATION", ctx);
      expect(result).toEqual({ ok: true, artifacts: [] });
    });

    it("returns success with empty artifacts for PULL_REQUEST", async () => {
      const runner = new PhaseRunner({ sdd: makeSddAdapter({ ok: true, artifactPath: "" }), llm: makeLlmProvider() });
      const result = await runner.execute("PULL_REQUEST", ctx);
      expect(result).toEqual({ ok: true, artifacts: [] });
    });

    it("does not call any SDD adapter method for stub phases", async () => {
      const sdd = makeSddAdapter({ ok: true, artifactPath: "" });
      const runner = new PhaseRunner({ sdd, llm: makeLlmProvider() });

      await runner.execute("SPEC_INIT", ctx);
      await runner.execute("IMPLEMENTATION", ctx);
      await runner.execute("PULL_REQUEST", ctx);

      expect(sdd.generateRequirements).not.toHaveBeenCalled();
      expect(sdd.generateDesign).not.toHaveBeenCalled();
      expect(sdd.validateDesign).not.toHaveBeenCalled();
      expect(sdd.generateTasks).not.toHaveBeenCalled();
    });
  });

  describe("onEnter / onExit lifecycle hooks", () => {
    it("onEnter resolves without error for any phase", async () => {
      const runner = new PhaseRunner({ sdd: makeSddAdapter({ ok: true, artifactPath: "" }), llm: makeLlmProvider() });
      const phases: WorkflowPhase[] = [
        "SPEC_INIT",
        "REQUIREMENTS",
        "DESIGN",
        "VALIDATE_DESIGN",
        "TASK_GENERATION",
        "IMPLEMENTATION",
        "PULL_REQUEST",
      ];
      for (const phase of phases) {
        await expect(runner.onEnter(phase)).resolves.toBeUndefined();
      }
    });

    it("onExit resolves without error for any phase", async () => {
      const runner = new PhaseRunner({ sdd: makeSddAdapter({ ok: true, artifactPath: "" }), llm: makeLlmProvider() });
      const phases: WorkflowPhase[] = [
        "SPEC_INIT",
        "REQUIREMENTS",
        "DESIGN",
        "VALIDATE_DESIGN",
        "TASK_GENERATION",
        "IMPLEMENTATION",
        "PULL_REQUEST",
      ];
      for (const phase of phases) {
        await expect(runner.onExit(phase)).resolves.toBeUndefined();
      }
    });
  });

  describe("LLM context isolation (task 6.2)", () => {
    const allPhases: WorkflowPhase[] = [
      "SPEC_INIT",
      "REQUIREMENTS",
      "DESIGN",
      "VALIDATE_DESIGN",
      "TASK_GENERATION",
      "IMPLEMENTATION",
      "PULL_REQUEST",
    ];

    it("onEnter calls llm.clearContext() for every phase", async () => {
      for (const phase of allPhases) {
        const llm = makeLlmProvider();
        const runner = new PhaseRunner({ sdd: makeSddAdapter({ ok: true, artifactPath: "" }), llm });
        await runner.onEnter(phase);
        expect(llm.clearContext).toHaveBeenCalledTimes(1);
      }
    });

    it("onExit does not call llm.clearContext()", async () => {
      for (const phase of allPhases) {
        const llm = makeLlmProvider();
        const runner = new PhaseRunner({ sdd: makeSddAdapter({ ok: true, artifactPath: "" }), llm });
        await runner.onExit(phase);
        expect(llm.clearContext).not.toHaveBeenCalled();
      }
    });

    it("execute() does not call llm.clearContext() directly (clearContext is the onEnter concern)", async () => {
      const llm = makeLlmProvider();
      const sdd = makeSddAdapter({ ok: true, artifactPath: "some/path.md" });
      const runner = new PhaseRunner({ sdd, llm });
      await runner.execute("REQUIREMENTS", ctx);
      // clearContext is not called inside execute — it is the caller's (WorkflowEngine's) responsibility
      // to call onEnter before execute; verify that execute itself does not double-clear
      expect(llm.clearContext).not.toHaveBeenCalled();
    });

    it("calling onEnter twice resets context twice (each transition is independent)", async () => {
      const llm = makeLlmProvider();
      const runner = new PhaseRunner({ sdd: makeSddAdapter({ ok: true, artifactPath: "" }), llm });
      await runner.onEnter("REQUIREMENTS");
      await runner.onEnter("DESIGN");
      expect(llm.clearContext).toHaveBeenCalledTimes(2);
    });
  });
});
