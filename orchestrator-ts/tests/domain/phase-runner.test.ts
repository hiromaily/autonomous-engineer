import type {
  IImplementationLoop,
  ImplementationLoopOutcome,
  ImplementationLoopResult,
} from "@/application/ports/implementation-loop";
import type { LlmProviderPort } from "@/application/ports/llm";
import type { SddFrameworkPort, SddOperationResult, SpecContext } from "@/application/ports/sdd";
import { PhaseRunner } from "@/application/services/workflow/phase-runner";
import type { FrameworkDefinition } from "@/domain/workflow/framework";
import type { WorkflowPhase } from "@/domain/workflow/types";
import { describe, expect, it, mock } from "bun:test";
import { makeFrameworkDef, makeLlmProvider } from "../helpers/workflow";

const ctx: SpecContext = {
  specName: "my-spec",
  specDir: ".kiro/specs/my-spec",
  language: "en",
};

function makeSddAdapter(result: SddOperationResult): SddFrameworkPort {
  return {
    executeCommand: mock(() => Promise.resolve(result)),
  };
}

describe("PhaseRunner", () => {
  describe("execute - SDD-backed phases", () => {
    it("dispatches SPEC_REQUIREMENTS to executeCommand('kiro:spec-requirements') and returns artifact path", async () => {
      const sdd = makeSddAdapter({ ok: true, artifactPath: ".kiro/specs/my-spec/requirements.md" });
      const runner = new PhaseRunner({ sdd, llm: makeLlmProvider(), frameworkDefinition: makeFrameworkDef() });
      const result = await runner.execute("SPEC_REQUIREMENTS", ctx);

      expect(sdd.executeCommand).toHaveBeenCalledWith("kiro:spec-requirements", ctx);
      expect(result).toEqual({ ok: true, artifacts: [".kiro/specs/my-spec/requirements.md"] });
    });

    it("dispatches SPEC_DESIGN to executeCommand('kiro:spec-design') and returns artifact path", async () => {
      const sdd = makeSddAdapter({ ok: true, artifactPath: ".kiro/specs/my-spec/design.md" });
      const runner = new PhaseRunner({ sdd, llm: makeLlmProvider(), frameworkDefinition: makeFrameworkDef() });
      const result = await runner.execute("SPEC_DESIGN", ctx);

      expect(sdd.executeCommand).toHaveBeenCalledWith("kiro:spec-design", ctx);
      expect(result).toEqual({ ok: true, artifacts: [".kiro/specs/my-spec/design.md"] });
    });

    it("dispatches VALIDATE_DESIGN to executeCommand('kiro:validate-design') and returns artifact path", async () => {
      const sdd = makeSddAdapter({ ok: true, artifactPath: ".kiro/specs/my-spec/design-review.md" });
      const runner = new PhaseRunner({ sdd, llm: makeLlmProvider(), frameworkDefinition: makeFrameworkDef() });
      const result = await runner.execute("VALIDATE_DESIGN", ctx);

      expect(sdd.executeCommand).toHaveBeenCalledWith("kiro:validate-design", ctx);
      expect(result).toEqual({ ok: true, artifacts: [".kiro/specs/my-spec/design-review.md"] });
    });

    it("dispatches SPEC_TASKS to executeCommand('kiro:spec-tasks') and returns artifact path", async () => {
      const sdd = makeSddAdapter({ ok: true, artifactPath: ".kiro/specs/my-spec/tasks.md" });
      const runner = new PhaseRunner({ sdd, llm: makeLlmProvider(), frameworkDefinition: makeFrameworkDef() });
      const result = await runner.execute("SPEC_TASKS", ctx);

      expect(sdd.executeCommand).toHaveBeenCalledWith("kiro:spec-tasks", ctx);
      expect(result).toEqual({ ok: true, artifacts: [".kiro/specs/my-spec/tasks.md"] });
    });

    it("dispatches VALIDATE_GAP to executeCommand('kiro:validate-gap')", async () => {
      const sdd = makeSddAdapter({ ok: true, artifactPath: ".kiro/specs/my-spec/requirements.md" });
      const runner = new PhaseRunner({ sdd, llm: makeLlmProvider(), frameworkDefinition: makeFrameworkDef() });
      const result = await runner.execute("VALIDATE_GAP", ctx);

      expect(sdd.executeCommand).toHaveBeenCalledWith("kiro:validate-gap", ctx);
      expect(result).toEqual({ ok: true, artifacts: [".kiro/specs/my-spec/requirements.md"] });
    });

    it("maps SDD failure to PhaseResult error", async () => {
      const sdd = makeSddAdapter({ ok: false, error: { exitCode: 1, stderr: "cc-sdd: spec not found" } });
      const runner = new PhaseRunner({ sdd, llm: makeLlmProvider(), frameworkDefinition: makeFrameworkDef() });
      const result = await runner.execute("SPEC_REQUIREMENTS", ctx);

      expect(result).toEqual({ ok: false, error: "cc-sdd: spec not found (exit 1)" });
    });

    it("maps SDD failure with empty stderr gracefully", async () => {
      const sdd = makeSddAdapter({ ok: false, error: { exitCode: 2, stderr: "" } });
      const runner = new PhaseRunner({ sdd, llm: makeLlmProvider(), frameworkDefinition: makeFrameworkDef() });
      const result = await runner.execute("SPEC_DESIGN", ctx);

      expect(result).toEqual({ ok: false, error: "SDD adapter failed (exit 2)" });
    });
  });

  describe("execute - SPEC_INIT phase", () => {
    it("dispatches SPEC_INIT to executeCommand('kiro:spec-init') and returns artifact path", async () => {
      const sdd = makeSddAdapter({ ok: true, artifactPath: ".kiro/specs/my-spec/spec.json" });
      const runner = new PhaseRunner({ sdd, llm: makeLlmProvider(), frameworkDefinition: makeFrameworkDef() });
      const result = await runner.execute("SPEC_INIT", ctx);

      expect(sdd.executeCommand).toHaveBeenCalledWith("kiro:spec-init", ctx);
      expect(result).toEqual({ ok: true, artifacts: [".kiro/specs/my-spec/spec.json"] });
    });

    it("propagates executeCommand failure as phase failure", async () => {
      const sdd = makeSddAdapter({ ok: false, error: { exitCode: 1, stderr: "init failed" } });
      const runner = new PhaseRunner({ sdd, llm: makeLlmProvider(), frameworkDefinition: makeFrameworkDef() });
      const result = await runner.execute("SPEC_INIT", ctx);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("init failed");
    });
  });

  describe("execute - llm_prompt phases (data-driven dispatch)", () => {
    it("calls llm.complete() with interpolated prompt for VALIDATE_PREREQUISITES", async () => {
      const llm = makeLlmProvider();
      const runner = new PhaseRunner({
        sdd: makeSddAdapter({ ok: true, artifactPath: "" }),
        llm,
        frameworkDefinition: makeFrameworkDef(),
      });

      await runner.execute("VALIDATE_PREREQUISITES", ctx);

      // ctx.specDir = ".kiro/specs/my-spec"
      expect(llm.complete).toHaveBeenCalledWith("Verify prerequisites for '.kiro/specs/my-spec'.");
    });

    it("returns { ok: true, artifacts: [] } when llm.complete() succeeds for a llm_prompt phase", async () => {
      const runner = new PhaseRunner({
        sdd: makeSddAdapter({ ok: true, artifactPath: "" }),
        llm: makeLlmProvider(),
        frameworkDefinition: makeFrameworkDef(),
      });
      const result = await runner.execute("VALIDATE_PREREQUISITES", ctx);
      expect(result).toEqual({ ok: true, artifacts: [] });
    });

    it("returns { ok: false, error } when llm.complete() fails for a llm_prompt phase", async () => {
      const llm: LlmProviderPort = {
        complete: mock(() =>
          Promise.resolve({
            ok: false as const,
            error: { category: "api_error" as const, message: "LLM unavailable", originalError: null },
          })
        ),
        clearContext: mock(() => {}),
      };
      const runner = new PhaseRunner({
        sdd: makeSddAdapter({ ok: true, artifactPath: "" }),
        llm,
        frameworkDefinition: makeFrameworkDef(),
      });
      const result = await runner.execute("VALIDATE_REQUIREMENTS", ctx);
      expect(result).toEqual({ ok: false, error: "LLM unavailable" });
    });

    it.each(
      [
        "VALIDATE_PREREQUISITES",
        "VALIDATE_REQUIREMENTS",
        "REFLECT_BEFORE_DESIGN",
        "REFLECT_BEFORE_TASKS",
        "VALIDATE_TASKS",
      ] as const,
    )("%s returns success with empty artifacts when llm succeeds", async (phase) => {
      const runner = new PhaseRunner({
        sdd: makeSddAdapter({ ok: true, artifactPath: "" }),
        llm: makeLlmProvider(),
        frameworkDefinition: makeFrameworkDef(),
      });
      const result = await runner.execute(phase, ctx);
      expect(result).toEqual({ ok: true, artifacts: [] });
    });

    it("does not call sdd.executeCommand for llm_prompt phases", async () => {
      const sdd = makeSddAdapter({ ok: true, artifactPath: "" });
      const runner = new PhaseRunner({ sdd, llm: makeLlmProvider(), frameworkDefinition: makeFrameworkDef() });

      for (
        const phase of [
          "VALIDATE_PREREQUISITES",
          "VALIDATE_REQUIREMENTS",
          "REFLECT_BEFORE_DESIGN",
          "REFLECT_BEFORE_TASKS",
          "VALIDATE_TASKS",
        ] as const
      ) {
        await runner.execute(phase, ctx);
      }

      expect(sdd.executeCommand).not.toHaveBeenCalled();
    });
  });

  describe("execute - human_interaction and git_command phases", () => {
    it("returns { ok: true, artifacts: [] } for HUMAN_INTERACTION without calling sdd or llm", async () => {
      const sdd = makeSddAdapter({ ok: true, artifactPath: "" });
      const llm = makeLlmProvider();
      const runner = new PhaseRunner({ sdd, llm, frameworkDefinition: makeFrameworkDef() });

      const result = await runner.execute("HUMAN_INTERACTION", ctx);

      expect(result).toEqual({ ok: true, artifacts: [] });
      expect(sdd.executeCommand).not.toHaveBeenCalled();
      expect(llm.complete).not.toHaveBeenCalled();
    });

    it("returns { ok: true, artifacts: [] } for PULL_REQUEST without calling sdd or llm", async () => {
      const sdd = makeSddAdapter({ ok: true, artifactPath: "" });
      const llm = makeLlmProvider();
      const runner = new PhaseRunner({ sdd, llm, frameworkDefinition: makeFrameworkDef() });

      const result = await runner.execute("PULL_REQUEST", ctx);

      expect(result).toEqual({ ok: true, artifacts: [] });
      expect(sdd.executeCommand).not.toHaveBeenCalled();
      expect(llm.complete).not.toHaveBeenCalled();
    });
  });

  describe("execute - unregistered phase", () => {
    it("throws an error when execute() is called with a phase not present in framework definition", async () => {
      const frameworkDef: FrameworkDefinition = {
        id: "minimal-fw",
        phases: [
          { phase: "SPEC_INIT", type: "llm_slash_command", content: "kiro:spec-init", requiredArtifacts: [] },
        ],
      };
      const runner = new PhaseRunner({
        sdd: makeSddAdapter({ ok: true, artifactPath: "" }),
        llm: makeLlmProvider(),
        frameworkDefinition: frameworkDef,
      });

      await expect(runner.execute("SPEC_REQUIREMENTS", ctx)).rejects.toThrow(
        "Unregistered workflow phase: SPEC_REQUIREMENTS in framework minimal-fw",
      );
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
        frameworkDefinition: makeFrameworkDef(),
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
        frameworkDefinition: makeFrameworkDef(),
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
        frameworkDefinition: makeFrameworkDef(),
        implementationLoop: makeImplementationLoop("completed"),
      });
      const result = await runner.execute("IMPLEMENTATION", ctx);
      expect(result).toEqual({ ok: true, artifacts: [] });
    });

    it("returns ok:false when implementationLoop.run returns section-failed", async () => {
      const runner = new PhaseRunner({
        sdd: makeSddAdapter({ ok: true, artifactPath: "" }),
        llm: makeLlmProvider(),
        frameworkDefinition: makeFrameworkDef(),
        implementationLoop: makeImplementationLoop("section-failed"),
      });
      const result = await runner.execute("IMPLEMENTATION", ctx);
      expect(result.ok).toBe(false);
    });

    it("returns ok:false when implementationLoop.run returns human-intervention-required", async () => {
      const runner = new PhaseRunner({
        sdd: makeSddAdapter({ ok: true, artifactPath: "" }),
        llm: makeLlmProvider(),
        frameworkDefinition: makeFrameworkDef(),
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
        frameworkDefinition: makeFrameworkDef(),
        implementationLoop: loop,
      });
      const result = await runner.execute("IMPLEMENTATION", ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("Max retries exceeded");
    });

    it("stubs to success when implementationLoop is not provided", async () => {
      const runner = new PhaseRunner({
        sdd: makeSddAdapter({ ok: true, artifactPath: "" }),
        llm: makeLlmProvider(),
        frameworkDefinition: makeFrameworkDef(),
      });
      const result = await runner.execute("IMPLEMENTATION", ctx);
      expect(result).toEqual({ ok: true, artifacts: [] });
    });
  });

  describe("onEnter / onExit lifecycle hooks", () => {
    it("onEnter resolves without error for any phase", async () => {
      const runner = new PhaseRunner({
        sdd: makeSddAdapter({ ok: true, artifactPath: "" }),
        llm: makeLlmProvider(),
        frameworkDefinition: makeFrameworkDef(),
      });
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
      const runner = new PhaseRunner({
        sdd: makeSddAdapter({ ok: true, artifactPath: "" }),
        llm: makeLlmProvider(),
        frameworkDefinition: makeFrameworkDef(),
      });
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
        const runner = new PhaseRunner({
          sdd: makeSddAdapter({ ok: true, artifactPath: "" }),
          llm,
          frameworkDefinition: makeFrameworkDef(),
        });
        await runner.onEnter(phase);
        expect(llm.clearContext).toHaveBeenCalledTimes(1);
      }
    });

    it("onExit does not call llm.clearContext()", async () => {
      for (const phase of allPhases) {
        const llm = makeLlmProvider();
        const runner = new PhaseRunner({
          sdd: makeSddAdapter({ ok: true, artifactPath: "" }),
          llm,
          frameworkDefinition: makeFrameworkDef(),
        });
        await runner.onExit(phase);
        expect(llm.clearContext).not.toHaveBeenCalled();
      }
    });

    it("execute() does not call llm.clearContext() directly (clearContext is the onEnter concern)", async () => {
      const llm = makeLlmProvider();
      const sdd = makeSddAdapter({ ok: true, artifactPath: "some/path.md" });
      const runner = new PhaseRunner({ sdd, llm, frameworkDefinition: makeFrameworkDef() });
      await runner.execute("SPEC_REQUIREMENTS", ctx);
      // clearContext is not called inside execute — it is the caller's (WorkflowEngine's) responsibility
      // to call onEnter before execute; verify that execute itself does not double-clear
      expect(llm.clearContext).not.toHaveBeenCalled();
    });

    it("calling onEnter twice resets context twice (each transition is independent)", async () => {
      const llm = makeLlmProvider();
      const runner = new PhaseRunner({
        sdd: makeSddAdapter({ ok: true, artifactPath: "" }),
        llm,
        frameworkDefinition: makeFrameworkDef(),
      });
      await runner.onEnter("SPEC_REQUIREMENTS");
      await runner.onEnter("SPEC_DESIGN");
      expect(llm.clearContext).toHaveBeenCalledTimes(2);
    });
  });
});
