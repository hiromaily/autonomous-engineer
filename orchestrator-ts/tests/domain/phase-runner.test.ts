import type {
  IImplementationLoop,
  ImplementationLoopOutcome,
  ImplementationLoopResult,
} from "@/application/ports/implementation-loop";
import type { LlmProviderPort } from "@/application/ports/llm";
import type { SddFrameworkPort, SddOperationResult, SpecContext } from "@/application/ports/sdd";
import { PhaseRunner } from "@/application/services/workflow/phase-runner";
import type { WorkflowPhase } from "@/domain/workflow/types";
import { describe, expect, it, mock } from "bun:test";

const ctx: SpecContext = {
  specName: "my-spec",
  specDir: ".kiro/specs",
  language: "en",
};

function makeSddAdapter(result: SddOperationResult): SddFrameworkPort {
  return {
    initSpec: mock(() => Promise.resolve(result)),
    generateRequirements: mock(() => Promise.resolve(result)),
    generateDesign: mock(() => Promise.resolve(result)),
    validateDesign: mock(() => Promise.resolve(result)),
    generateTasks: mock(() => Promise.resolve(result)),
    validatePrerequisites: mock(() => Promise.resolve(result)),
    validateRequirements: mock(() => Promise.resolve(result)),
    reflectBeforeDesign: mock(() => Promise.resolve(result)),
    reflectBeforeTasks: mock(() => Promise.resolve(result)),
    validateGap: mock(() => Promise.resolve(result)),
    validateTasks: mock(() => Promise.resolve(result)),
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
    it("dispatches SPEC_REQUIREMENTS to generateRequirements and returns artifact path", async () => {
      const sdd = makeSddAdapter({ ok: true, artifactPath: ".kiro/specs/my-spec/requirements.md" });
      const runner = new PhaseRunner({ sdd, llm: makeLlmProvider() });
      const result = await runner.execute("SPEC_REQUIREMENTS", ctx);

      expect(sdd.generateRequirements).toHaveBeenCalledWith(ctx);
      expect(result).toEqual({ ok: true, artifacts: [".kiro/specs/my-spec/requirements.md"] });
    });

    it("dispatches SPEC_DESIGN to generateDesign and returns artifact path", async () => {
      const sdd = makeSddAdapter({ ok: true, artifactPath: ".kiro/specs/my-spec/design.md" });
      const runner = new PhaseRunner({ sdd, llm: makeLlmProvider() });
      const result = await runner.execute("SPEC_DESIGN", ctx);

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

    it("dispatches SPEC_TASKS to generateTasks and returns artifact path", async () => {
      const sdd = makeSddAdapter({ ok: true, artifactPath: ".kiro/specs/my-spec/tasks.md" });
      const runner = new PhaseRunner({ sdd, llm: makeLlmProvider() });
      const result = await runner.execute("SPEC_TASKS", ctx);

      expect(sdd.generateTasks).toHaveBeenCalledWith(ctx);
      expect(result).toEqual({ ok: true, artifacts: [".kiro/specs/my-spec/tasks.md"] });
    });

    it("dispatches VALIDATE_PREREQUISITES to validatePrerequisites", async () => {
      const sdd = makeSddAdapter({ ok: true, artifactPath: ".kiro/specs/my-spec/requirements.md" });
      const runner = new PhaseRunner({ sdd, llm: makeLlmProvider() });
      const result = await runner.execute("VALIDATE_PREREQUISITES", ctx);

      expect(sdd.validatePrerequisites).toHaveBeenCalledWith(ctx);
      expect(result).toEqual({ ok: true, artifacts: [".kiro/specs/my-spec/requirements.md"] });
    });

    it("dispatches VALIDATE_REQUIREMENTS to validateRequirements", async () => {
      const sdd = makeSddAdapter({ ok: true, artifactPath: ".kiro/specs/my-spec/requirements.md" });
      const runner = new PhaseRunner({ sdd, llm: makeLlmProvider() });
      const result = await runner.execute("VALIDATE_REQUIREMENTS", ctx);

      expect(sdd.validateRequirements).toHaveBeenCalledWith(ctx);
      expect(result).toEqual({ ok: true, artifacts: [".kiro/specs/my-spec/requirements.md"] });
    });

    it("dispatches REFLECT_BEFORE_DESIGN to reflectBeforeDesign", async () => {
      const sdd = makeSddAdapter({ ok: true, artifactPath: ".kiro/specs/my-spec/requirements.md" });
      const runner = new PhaseRunner({ sdd, llm: makeLlmProvider() });
      const result = await runner.execute("REFLECT_BEFORE_DESIGN", ctx);

      expect(sdd.reflectBeforeDesign).toHaveBeenCalledWith(ctx);
      expect(result).toEqual({ ok: true, artifacts: [".kiro/specs/my-spec/requirements.md"] });
    });

    it("dispatches VALIDATE_GAP to validateGap", async () => {
      const sdd = makeSddAdapter({ ok: true, artifactPath: ".kiro/specs/my-spec/requirements.md" });
      const runner = new PhaseRunner({ sdd, llm: makeLlmProvider() });
      const result = await runner.execute("VALIDATE_GAP", ctx);

      expect(sdd.validateGap).toHaveBeenCalledWith(ctx);
      expect(result).toEqual({ ok: true, artifacts: [".kiro/specs/my-spec/requirements.md"] });
    });

    it("dispatches REFLECT_BEFORE_TASKS to reflectBeforeTasks", async () => {
      const sdd = makeSddAdapter({ ok: true, artifactPath: ".kiro/specs/my-spec/design.md" });
      const runner = new PhaseRunner({ sdd, llm: makeLlmProvider() });
      const result = await runner.execute("REFLECT_BEFORE_TASKS", ctx);

      expect(sdd.reflectBeforeTasks).toHaveBeenCalledWith(ctx);
      expect(result).toEqual({ ok: true, artifacts: [".kiro/specs/my-spec/design.md"] });
    });

    it("dispatches VALIDATE_TASKS to validateTasks", async () => {
      const sdd = makeSddAdapter({ ok: true, artifactPath: ".kiro/specs/my-spec/tasks.md" });
      const runner = new PhaseRunner({ sdd, llm: makeLlmProvider() });
      const result = await runner.execute("VALIDATE_TASKS", ctx);

      expect(sdd.validateTasks).toHaveBeenCalledWith(ctx);
      expect(result).toEqual({ ok: true, artifacts: [".kiro/specs/my-spec/tasks.md"] });
    });

    it("maps SDD failure to PhaseResult error", async () => {
      const sdd = makeSddAdapter({ ok: false, error: { exitCode: 1, stderr: "cc-sdd: spec not found" } });
      const runner = new PhaseRunner({ sdd, llm: makeLlmProvider() });
      const result = await runner.execute("SPEC_REQUIREMENTS", ctx);

      expect(result).toEqual({ ok: false, error: "cc-sdd: spec not found (exit 1)" });
    });

    it("maps SDD failure with empty stderr gracefully", async () => {
      const sdd = makeSddAdapter({ ok: false, error: { exitCode: 2, stderr: "" } });
      const runner = new PhaseRunner({ sdd, llm: makeLlmProvider() });
      const result = await runner.execute("SPEC_DESIGN", ctx);

      expect(result).toEqual({ ok: false, error: "SDD adapter failed (exit 2)" });
    });
  });

  describe("execute - SPEC_INIT phase", () => {
    it("dispatches SPEC_INIT to sdd.initSpec and returns artifact path", async () => {
      const sdd = makeSddAdapter({ ok: true, artifactPath: ".kiro/specs/my-spec/spec.json" });
      const runner = new PhaseRunner({ sdd, llm: makeLlmProvider() });
      const result = await runner.execute("SPEC_INIT", ctx);

      expect(sdd.initSpec).toHaveBeenCalledWith(ctx);
      expect(result).toEqual({ ok: true, artifacts: [".kiro/specs/my-spec/spec.json"] });
    });

    it("propagates sdd.initSpec failure as phase failure", async () => {
      const sdd = makeSddAdapter({ ok: false, error: { exitCode: 1, stderr: "init failed" } });
      const runner = new PhaseRunner({ sdd, llm: makeLlmProvider() });
      const result = await runner.execute("SPEC_INIT", ctx);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("init failed");
    });
  });

  describe("execute - stub phases", () => {
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

    it("returns success with empty artifacts for HUMAN_INTERACTION", async () => {
      const runner = new PhaseRunner({ sdd: makeSddAdapter({ ok: true, artifactPath: "" }), llm: makeLlmProvider() });
      const result = await runner.execute("HUMAN_INTERACTION", ctx);
      expect(result).toEqual({ ok: true, artifacts: [] });
    });

    it("does not call any SDD adapter method for HUMAN_INTERACTION, IMPLEMENTATION, PULL_REQUEST", async () => {
      const sdd = makeSddAdapter({ ok: true, artifactPath: "" });
      const runner = new PhaseRunner({ sdd, llm: makeLlmProvider() });

      await runner.execute("HUMAN_INTERACTION", ctx);
      await runner.execute("IMPLEMENTATION", ctx);
      await runner.execute("PULL_REQUEST", ctx);

      expect(sdd.initSpec).not.toHaveBeenCalled();
      expect(sdd.generateRequirements).not.toHaveBeenCalled();
      expect(sdd.generateDesign).not.toHaveBeenCalled();
      expect(sdd.validateDesign).not.toHaveBeenCalled();
      expect(sdd.generateTasks).not.toHaveBeenCalled();
      expect(sdd.validatePrerequisites).not.toHaveBeenCalled();
      expect(sdd.validateRequirements).not.toHaveBeenCalled();
      expect(sdd.reflectBeforeDesign).not.toHaveBeenCalled();
      expect(sdd.reflectBeforeTasks).not.toHaveBeenCalled();
      expect(sdd.validateGap).not.toHaveBeenCalled();
      expect(sdd.validateTasks).not.toHaveBeenCalled();
    });
  });

  describe("execute - IMPLEMENTATION phase with IImplementationLoop (task 5.2)", () => {
    function makeImplementationLoop(outcome: ImplementationLoopOutcome): IImplementationLoop {
      const result: ImplementationLoopResult = { outcome, planId: "my-spec", sections: [], durationMs: 0 };
      return {
        run: mock(() => Promise.resolve(result)),
        resume: mock(() => Promise.resolve(result)),
        stop: mock(() => {}),
      };
    }

    it("delegates to implementationLoop.run(specName) for IMPLEMENTATION phase", async () => {
      const loop = makeImplementationLoop("completed");
      const runner = new PhaseRunner({
        sdd: makeSddAdapter({ ok: true, artifactPath: "" }),
        llm: makeLlmProvider(),
        implementationLoop: loop,
      });
      await runner.execute("IMPLEMENTATION", ctx);
      expect(loop.run).toHaveBeenCalledTimes(1);
    });

    it("passes specName as planId to implementationLoop.run", async () => {
      const loop = makeImplementationLoop("completed");
      const runner = new PhaseRunner({
        sdd: makeSddAdapter({ ok: true, artifactPath: "" }),
        llm: makeLlmProvider(),
        implementationLoop: loop,
      });
      await runner.execute("IMPLEMENTATION", ctx);
      const [planIdArg] = (loop.run as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] ?? [];
      expect(planIdArg).toBe("my-spec");
    });

    it("returns ok:true when implementationLoop.run returns completed", async () => {
      const runner = new PhaseRunner({
        sdd: makeSddAdapter({ ok: true, artifactPath: "" }),
        llm: makeLlmProvider(),
        implementationLoop: makeImplementationLoop("completed"),
      });
      const result = await runner.execute("IMPLEMENTATION", ctx);
      expect(result).toEqual({ ok: true, artifacts: [] });
    });

    it("returns ok:false when implementationLoop.run returns section-failed", async () => {
      const runner = new PhaseRunner({
        sdd: makeSddAdapter({ ok: true, artifactPath: "" }),
        llm: makeLlmProvider(),
        implementationLoop: makeImplementationLoop("section-failed"),
      });
      const result = await runner.execute("IMPLEMENTATION", ctx);
      expect(result.ok).toBe(false);
    });

    it("returns ok:false when implementationLoop.run returns human-intervention-required", async () => {
      const runner = new PhaseRunner({
        sdd: makeSddAdapter({ ok: true, artifactPath: "" }),
        llm: makeLlmProvider(),
        implementationLoop: makeImplementationLoop("human-intervention-required"),
      });
      const result = await runner.execute("IMPLEMENTATION", ctx);
      expect(result.ok).toBe(false);
    });

    it("includes haltReason in error when present in loop result", async () => {
      const loop = makeImplementationLoop("section-failed");
      // Override run to return a result with haltReason
      (loop.run as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve({
          outcome: "section-failed" as const,
          planId: "my-spec",
          sections: [],
          durationMs: 0,
          haltReason: "Max retries exceeded",
        })
      );
      const runner = new PhaseRunner({
        sdd: makeSddAdapter({ ok: true, artifactPath: "" }),
        llm: makeLlmProvider(),
        implementationLoop: loop,
      });
      const result = await runner.execute("IMPLEMENTATION", ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("Max retries exceeded");
    });

    it("stubs to success when implementationLoop is not provided", async () => {
      const runner = new PhaseRunner({ sdd: makeSddAdapter({ ok: true, artifactPath: "" }), llm: makeLlmProvider() });
      const result = await runner.execute("IMPLEMENTATION", ctx);
      expect(result).toEqual({ ok: true, artifacts: [] });
    });
  });

  describe("onEnter / onExit lifecycle hooks", () => {
    it("onEnter resolves without error for any phase", async () => {
      const runner = new PhaseRunner({ sdd: makeSddAdapter({ ok: true, artifactPath: "" }), llm: makeLlmProvider() });
      const phases: WorkflowPhase[] = [
        "SPEC_INIT",
        "HUMAN_INTERACTION",
        "VALIDATE_PREREQUISITES",
        "SPEC_REQUIREMENTS",
        "VALIDATE_REQUIREMENTS",
        "REFLECT_BEFORE_DESIGN",
        "VALIDATE_GAP",
        "SPEC_DESIGN",
        "VALIDATE_DESIGN",
        "REFLECT_BEFORE_TASKS",
        "SPEC_TASKS",
        "VALIDATE_TASKS",
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
        "HUMAN_INTERACTION",
        "VALIDATE_PREREQUISITES",
        "SPEC_REQUIREMENTS",
        "VALIDATE_REQUIREMENTS",
        "REFLECT_BEFORE_DESIGN",
        "VALIDATE_GAP",
        "SPEC_DESIGN",
        "VALIDATE_DESIGN",
        "REFLECT_BEFORE_TASKS",
        "SPEC_TASKS",
        "VALIDATE_TASKS",
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
      "HUMAN_INTERACTION",
      "VALIDATE_PREREQUISITES",
      "SPEC_REQUIREMENTS",
      "VALIDATE_REQUIREMENTS",
      "REFLECT_BEFORE_DESIGN",
      "VALIDATE_GAP",
      "SPEC_DESIGN",
      "VALIDATE_DESIGN",
      "REFLECT_BEFORE_TASKS",
      "SPEC_TASKS",
      "VALIDATE_TASKS",
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
      await runner.execute("SPEC_REQUIREMENTS", ctx);
      // clearContext is not called inside execute — it is the caller's (WorkflowEngine's) responsibility
      // to call onEnter before execute; verify that execute itself does not double-clear
      expect(llm.clearContext).not.toHaveBeenCalled();
    });

    it("calling onEnter twice resets context twice (each transition is independent)", async () => {
      const llm = makeLlmProvider();
      const runner = new PhaseRunner({ sdd: makeSddAdapter({ ok: true, artifactPath: "" }), llm });
      await runner.onEnter("SPEC_REQUIREMENTS");
      await runner.onEnter("SPEC_DESIGN");
      expect(llm.clearContext).toHaveBeenCalledTimes(2);
    });
  });
});
