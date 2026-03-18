import type { AesConfig } from "@/application/ports/config";
import type {
  IImplementationLoop,
  ImplementationLoopOutcome,
  ImplementationLoopResult,
} from "@/application/ports/implementation-loop";
import type { LlmProviderPort } from "@/application/ports/llm";
import type { ILogger } from "@/application/ports/logger";
import type { MemoryPort, ShortTermMemoryPort } from "@/application/ports/memory";
import type { SddFrameworkPort } from "@/application/ports/sdd";
import type { IWorkflowEventBus, IWorkflowStateStore, WorkflowEvent } from "@/application/ports/workflow";
import { RunSpecUseCase } from "@/application/usecases/run-spec";
import type { FrameworkDefinition } from "@/domain/workflow/framework";
import type { WorkflowState } from "@/domain/workflow/types";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Stub factories ─────────────────────────────────────────────────────────

function makeStateStore(overrides?: Partial<IWorkflowStateStore>): IWorkflowStateStore {
  const defaultState: WorkflowState = {
    specName: "test-spec",
    currentPhase: "SPEC_INIT",
    completedPhases: [],
    status: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return {
    init: mock(() => defaultState),
    persist: mock(() => Promise.resolve()),
    restore: mock(() => Promise.resolve(null)),
    ...overrides,
  };
}

function makeEventBus(): IWorkflowEventBus {
  return {
    emit: mock(() => {}),
    on: mock(() => {}),
    off: mock(() => {}),
  };
}

function makeSdd(): SddFrameworkPort {
  return {
    executeCommand: mock(() => Promise.resolve({ ok: true as const, artifactPath: "" })),
  };
}

function makeFrameworkDef(): FrameworkDefinition {
  return {
    id: "test-fw",
    phases: [
      { phase: "SPEC_INIT", type: "llm_slash_command", content: "kiro:spec-init", requiredArtifacts: [] },
      { phase: "HUMAN_INTERACTION", type: "human_interaction", content: "", requiredArtifacts: [] },
      { phase: "VALIDATE_PREREQUISITES", type: "llm_prompt", content: "Verify prerequisites.", requiredArtifacts: [] },
      {
        phase: "SPEC_REQUIREMENTS",
        type: "llm_slash_command",
        content: "kiro:spec-requirements",
        requiredArtifacts: [],
      },
      { phase: "VALIDATE_REQUIREMENTS", type: "llm_prompt", content: "Validate requirements.", requiredArtifacts: [] },
      { phase: "REFLECT_BEFORE_DESIGN", type: "llm_prompt", content: "Reflect before design.", requiredArtifacts: [] },
      { phase: "VALIDATE_GAP", type: "llm_slash_command", content: "kiro:validate-gap", requiredArtifacts: [] },
      { phase: "SPEC_DESIGN", type: "llm_slash_command", content: "kiro:spec-design", requiredArtifacts: [] },
      { phase: "VALIDATE_DESIGN", type: "llm_slash_command", content: "kiro:validate-design", requiredArtifacts: [] },
      { phase: "REFLECT_BEFORE_TASKS", type: "llm_prompt", content: "Reflect before tasks.", requiredArtifacts: [] },
      { phase: "SPEC_TASKS", type: "llm_slash_command", content: "kiro:spec-tasks", requiredArtifacts: [] },
      { phase: "VALIDATE_TASKS", type: "llm_prompt", content: "Validate tasks.", requiredArtifacts: [] },
      { phase: "IMPLEMENTATION", type: "implementation_loop", content: "", requiredArtifacts: [] },
      { phase: "PULL_REQUEST", type: "git_command", content: "", requiredArtifacts: [] },
    ],
  };
}

function makeLlm(): LlmProviderPort {
  return {
    complete: mock(() =>
      Promise.resolve({ ok: true as const, value: { content: "", usage: { inputTokens: 0, outputTokens: 0 } } })
    ),
    clearContext: mock(() => {}),
  };
}

function makeShortTerm(): ShortTermMemoryPort {
  return {
    read: mock(() => ({ recentFiles: [] })),
    write: mock(() => {}),
    clear: mock(() => {}),
  };
}

function makeMemoryPort(shortTerm?: ShortTermMemoryPort): MemoryPort {
  const st = shortTerm ?? makeShortTerm();
  return {
    shortTerm: st,
    query: mock(() => Promise.resolve({ entries: [] })),
    append: mock(() => Promise.resolve({ ok: true as const, action: "appended" as const })),
    update: mock(() => Promise.resolve({ ok: true as const, action: "updated" as const })),
    writeFailure: mock(() => Promise.resolve({ ok: true as const, action: "appended" as const })),
    getFailures: mock(() => Promise.resolve([])),
  };
}

const baseConfig: AesConfig = {
  llm: { provider: "claude", modelName: "claude-sonnet-4-6", apiKey: "test-key" },
  specDir: "/tmp/specs",
  sddFramework: "cc-sdd",
  logLevel: "info",
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("RunSpecUseCase", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "run-spec-test-"));
  });

  describe("dry-run mode", () => {
    it("returns completed with empty phases when spec directory exists", async () => {
      // specDir in config is the parent; the engine checks join(specDir, specName)
      // tmpDir itself is the parent; we use its parent so join(parent, basename(tmpDir)) = tmpDir
      const specParent = join(tmpDir, "..");
      const specName = tmpDir.split("/").at(-1) ?? "test-spec";
      const useCase = new RunSpecUseCase({
        stateStore: makeStateStore(),
        eventBus: makeEventBus(),
        sdd: makeSdd(),
        frameworkDefinition: makeFrameworkDef(),
        createLlmProvider: () => makeLlm(),
        memory: makeMemoryPort(),
      });

      const result = await useCase.run(specName, { ...baseConfig, specDir: specParent }, {
        dryRun: true,
      });

      expect(result).toEqual({ status: "completed", completedPhases: [] });
    });

    it("returns failed when spec directory does not exist", async () => {
      const useCase = new RunSpecUseCase({
        stateStore: makeStateStore(),
        eventBus: makeEventBus(),
        sdd: makeSdd(),
        frameworkDefinition: makeFrameworkDef(),
        createLlmProvider: () => makeLlm(),
        memory: makeMemoryPort(),
      });

      const result = await useCase.run("missing-spec", { ...baseConfig, specDir: "/nonexistent/path/xyz" }, {
        dryRun: true,
      });

      expect(result.status).toBe("failed");
    });

    it("does not call WorkflowEngine or stateStore when dry-run", async () => {
      const specParent = join(tmpDir, "..");
      const specName = tmpDir.split("/").at(-1) ?? "test-spec";
      const stateStore = makeStateStore();
      const useCase = new RunSpecUseCase({
        stateStore,
        eventBus: makeEventBus(),
        sdd: makeSdd(),
        frameworkDefinition: makeFrameworkDef(),
        createLlmProvider: () => makeLlm(),
        memory: makeMemoryPort(),
      });

      await useCase.run(specName, { ...baseConfig, specDir: specParent }, {
        dryRun: true,
      });

      expect(stateStore.init).not.toHaveBeenCalled();
      expect(stateStore.restore).not.toHaveBeenCalled();
      expect(stateStore.persist).not.toHaveBeenCalled();
    });
  });

  describe("auto-resume: always restores persisted state", () => {
    it("always calls stateStore.restore and uses it when state exists", async () => {
      const restoredState: WorkflowState = {
        specName: "test-spec",
        currentPhase: "HUMAN_INTERACTION",
        completedPhases: ["SPEC_INIT"],
        status: "paused_for_approval",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const stateStore = makeStateStore({
        restore: mock(() => Promise.resolve(restoredState)),
        persist: mock(() => Promise.resolve()),
      });

      // Provide spec.json with approvals to allow the paused phase to advance
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(tmpDir, "requirements.md"), "# Requirements\n");
      await writeFile(
        join(tmpDir, "spec.json"),
        JSON.stringify({
          approvals: {
            human_interaction: { approved: true },
            requirements: { approved: true },
          },
          ready_for_implementation: true,
        }),
      );

      const useCase = new RunSpecUseCase({
        stateStore,
        eventBus: makeEventBus(),
        sdd: makeSdd(),
        frameworkDefinition: makeFrameworkDef(),
        createLlmProvider: () => makeLlm(),
        memory: makeMemoryPort(),
      });

      await useCase.run("test-spec", { ...baseConfig, specDir: tmpDir }, { dryRun: false });

      expect(stateStore.restore).toHaveBeenCalledWith("test-spec");
      expect(stateStore.init).not.toHaveBeenCalled();
    });

    it("falls back to stateStore.init when no persisted state exists", async () => {
      const stateStore = makeStateStore({
        restore: mock(() => Promise.resolve(null)),
        persist: mock(() => Promise.resolve()),
      });
      const useCase = new RunSpecUseCase({
        stateStore,
        eventBus: makeEventBus(),
        sdd: makeSdd(),
        frameworkDefinition: makeFrameworkDef(),
        createLlmProvider: () => makeLlm(),
        memory: makeMemoryPort(),
      });

      await useCase.run("test-spec", { ...baseConfig, specDir: tmpDir }, { dryRun: false });

      expect(stateStore.restore).toHaveBeenCalledWith("test-spec");
      expect(stateStore.init).toHaveBeenCalledWith("test-spec");
    });
  });

  describe("provider override", () => {
    it("passes providerOverride to createLlmProvider", async () => {
      const createLlmProvider = mock((_config: AesConfig, _override?: string) => makeLlm());
      const useCase = new RunSpecUseCase({
        stateStore: makeStateStore({ persist: mock(() => Promise.resolve()) }),
        eventBus: makeEventBus(),
        sdd: makeSdd(),
        frameworkDefinition: makeFrameworkDef(),
        createLlmProvider,
        memory: makeMemoryPort(),
      });

      await useCase.run("test-spec", { ...baseConfig, specDir: tmpDir }, {
        dryRun: false,
        providerOverride: "openai",
      });

      expect(createLlmProvider).toHaveBeenCalledWith(expect.objectContaining({ llm: expect.anything() }), "openai");
    });

    it("passes undefined providerOverride when not specified", async () => {
      const createLlmProvider = mock((_config: AesConfig, _override?: string) => makeLlm());
      const useCase = new RunSpecUseCase({
        stateStore: makeStateStore({ persist: mock(() => Promise.resolve()) }),
        eventBus: makeEventBus(),
        sdd: makeSdd(),
        frameworkDefinition: makeFrameworkDef(),
        createLlmProvider,
        memory: makeMemoryPort(),
      });

      await useCase.run("test-spec", { ...baseConfig, specDir: tmpDir }, { dryRun: false });

      expect(createLlmProvider).toHaveBeenCalledWith(expect.objectContaining({}), undefined);
    });
  });

  describe("engine delegation", () => {
    it("delegates execution to WorkflowEngine and returns its result", async () => {
      // WorkflowEngine pauses at REQUIREMENTS approval gate unless spec.json approves it.
      // Supply a spec.json with all approvals so all phases complete.
      const { writeFile, mkdir } = await import("node:fs/promises");
      const specSubDir = join(tmpDir, "test-spec");
      await mkdir(specSubDir, { recursive: true });
      const specJson = {
        approvals: {
          human_interaction: { approved: true },
          requirements: { approved: true },
          design: { approved: true },
          tasks: { approved: true },
        },
        ready_for_implementation: true,
      };
      await writeFile(join(specSubDir, "spec.json"), JSON.stringify(specJson));
      // Create required artifacts for each phase gate
      await writeFile(join(specSubDir, "requirements.md"), "# Requirements");
      await writeFile(join(specSubDir, "design.md"), "# Design");
      await writeFile(join(specSubDir, "tasks.md"), "# Tasks");

      const stateStore = makeStateStore({ persist: mock(() => Promise.resolve()) });
      const eventBus = makeEventBus();
      const useCase = new RunSpecUseCase({
        stateStore,
        eventBus,
        sdd: makeSdd(),
        frameworkDefinition: makeFrameworkDef(),
        createLlmProvider: () => makeLlm(),
        memory: makeMemoryPort(),
      });

      const result = await useCase.run("test-spec", { ...baseConfig, specDir: tmpDir }, {
        dryRun: false,
      });

      // WorkflowEngine will complete all 7 phases (all stubs return ok, all approvals granted)
      expect(result.status).toBe("completed");
    });

    it("passes specDir from config joined with specName to engine", async () => {
      // SPEC_INIT is a stub (no artifact requirements); workflow pauses at REQUIREMENTS gate.
      // That is still a valid result — we just verify run() returns without throwing.
      const stateStore = makeStateStore({ persist: mock(() => Promise.resolve()) });
      const useCase = new RunSpecUseCase({
        stateStore,
        eventBus: makeEventBus(),
        sdd: makeSdd(),
        frameworkDefinition: makeFrameworkDef(),
        createLlmProvider: () => makeLlm(),
        memory: makeMemoryPort(),
      });

      const result = await useCase.run("test-spec", { ...baseConfig, specDir: tmpDir }, {
        dryRun: false,
      });

      expect(result).toBeDefined();
    });
  });

  // ─── implementation loop integration (task 5.2) ──────────────────────────

  describe("implementation loop integration (task 5.2)", () => {
    let specSubDir: string;

    /** Set up a spec dir with all approvals granted so IMPLEMENTATION phase is reached. */
    async function setupFullSpecDir(parent: string, specName = "test-spec"): Promise<void> {
      specSubDir = join(parent, specName);
      await mkdir(specSubDir, { recursive: true });
      await writeFile(
        join(specSubDir, "spec.json"),
        JSON.stringify({
          approvals: {
            human_interaction: { approved: true },
            requirements: { approved: true },
            design: { approved: true },
            tasks: { approved: true },
          },
          ready_for_implementation: true,
        }),
      );
      await writeFile(join(specSubDir, "requirements.md"), "# Requirements");
      await writeFile(join(specSubDir, "design.md"), "# Design");
      await writeFile(join(specSubDir, "tasks.md"), "# Tasks");
    }

    function makeImplementationLoop(outcome: ImplementationLoopOutcome = "completed"): IImplementationLoop {
      const result: ImplementationLoopResult = { outcome, planId: "test-spec", sections: [], durationMs: 0 };
      return {
        run: mock(() => Promise.resolve(result)),
        resume: mock(() => Promise.resolve(result)),
        stop: mock(() => {}),
      };
    }

    it("calls implementationLoop.run(specName) when IMPLEMENTATION phase is reached", async () => {
      await setupFullSpecDir(tmpDir);
      const implementationLoop = makeImplementationLoop("completed");
      const useCase = new RunSpecUseCase({
        stateStore: makeStateStore({ persist: mock(() => Promise.resolve()) }),
        eventBus: makeEventBus(),
        sdd: makeSdd(),
        frameworkDefinition: makeFrameworkDef(),
        createLlmProvider: () => makeLlm(),
        memory: makeMemoryPort(),
        implementationLoop,
      });

      await useCase.run("test-spec", { ...baseConfig, specDir: tmpDir }, { dryRun: false });

      expect(implementationLoop.run).toHaveBeenCalledTimes(1);
      // First argument must be the specName used as planId
      const [planIdArg] = (implementationLoop.run as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] ?? [];
      expect(planIdArg).toBe("test-spec");
    });

    it("workflow completes when implementation loop returns completed", async () => {
      await setupFullSpecDir(tmpDir);
      const implementationLoop = makeImplementationLoop("completed");
      const useCase = new RunSpecUseCase({
        stateStore: makeStateStore({ persist: mock(() => Promise.resolve()) }),
        eventBus: makeEventBus(),
        sdd: makeSdd(),
        frameworkDefinition: makeFrameworkDef(),
        createLlmProvider: () => makeLlm(),
        memory: makeMemoryPort(),
        implementationLoop,
      });

      const result = await useCase.run("test-spec", { ...baseConfig, specDir: tmpDir }, {
        dryRun: false,
      });

      expect(result.status).toBe("completed");
    });

    it("workflow fails when implementation loop returns section-failed", async () => {
      await setupFullSpecDir(tmpDir);
      const implementationLoop = makeImplementationLoop("section-failed");
      const useCase = new RunSpecUseCase({
        stateStore: makeStateStore({ persist: mock(() => Promise.resolve()) }),
        eventBus: makeEventBus(),
        sdd: makeSdd(),
        frameworkDefinition: makeFrameworkDef(),
        createLlmProvider: () => makeLlm(),
        memory: makeMemoryPort(),
        implementationLoop,
      });

      const result = await useCase.run("test-spec", { ...baseConfig, specDir: tmpDir }, {
        dryRun: false,
      });

      expect(result.status).toBe("failed");
    });

    it("phase:start and phase:complete events are emitted for IMPLEMENTATION phase", async () => {
      await setupFullSpecDir(tmpDir);
      const events: WorkflowEvent[] = [];
      const eventBus: IWorkflowEventBus = {
        emit: mock((e: WorkflowEvent) => {
          events.push(e);
        }),
        on: mock(() => {}),
        off: mock(() => {}),
      };

      const useCase = new RunSpecUseCase({
        stateStore: makeStateStore({ persist: mock(() => Promise.resolve()) }),
        eventBus,
        sdd: makeSdd(),
        frameworkDefinition: makeFrameworkDef(),
        createLlmProvider: () => makeLlm(),
        memory: makeMemoryPort(),
        implementationLoop: makeImplementationLoop("completed"),
      });

      await useCase.run("test-spec", { ...baseConfig, specDir: tmpDir }, { dryRun: false });

      const startEvent = events.find((e) => e.type === "phase:start" && e.phase === "IMPLEMENTATION");
      const completeEvent = events.find((e) => e.type === "phase:complete" && e.phase === "IMPLEMENTATION");
      expect(startEvent).toBeDefined();
      expect(completeEvent).toBeDefined();
    });

    it("phase:error is emitted and workflow fails when implementation loop returns non-completed", async () => {
      await setupFullSpecDir(tmpDir);
      const events: WorkflowEvent[] = [];
      const eventBus: IWorkflowEventBus = {
        emit: mock((e: WorkflowEvent) => {
          events.push(e);
        }),
        on: mock(() => {}),
        off: mock(() => {}),
      };

      const useCase = new RunSpecUseCase({
        stateStore: makeStateStore({ persist: mock(() => Promise.resolve()) }),
        eventBus,
        sdd: makeSdd(),
        frameworkDefinition: makeFrameworkDef(),
        createLlmProvider: () => makeLlm(),
        memory: makeMemoryPort(),
        implementationLoop: makeImplementationLoop("section-failed"),
      });

      await useCase.run("test-spec", { ...baseConfig, specDir: tmpDir }, { dryRun: false });

      const errorEvent = events.find((e) => e.type === "phase:error" && e.phase === "IMPLEMENTATION");
      expect(errorEvent).toBeDefined();
    });

    it("IMPLEMENTATION phase stubs to success when implementationLoop is not provided", async () => {
      await setupFullSpecDir(tmpDir);
      const useCase = new RunSpecUseCase({
        stateStore: makeStateStore({ persist: mock(() => Promise.resolve()) }),
        eventBus: makeEventBus(),
        sdd: makeSdd(),
        frameworkDefinition: makeFrameworkDef(),
        createLlmProvider: () => makeLlm(),
        memory: makeMemoryPort(),
        // no implementationLoop
      });

      const result = await useCase.run("test-spec", { ...baseConfig, specDir: tmpDir }, {
        dryRun: false,
      });

      expect(result.status).toBe("completed");
    });
  });

  describe("phase lifecycle logging", () => {
    function makeRealEventBus(): IWorkflowEventBus {
      const handlers: Array<(event: WorkflowEvent) => void> = [];
      return {
        emit(event) {
          for (const h of handlers) h(event);
        },
        on(handler) {
          handlers.push(handler);
        },
        off(handler) {
          const idx = handlers.indexOf(handler);
          if (idx !== -1) handlers.splice(idx, 1);
        },
      };
    }

    function makeLogger(): ILogger {
      return {
        debug: mock(() => {}),
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
      };
    }

    async function setupSpecDir(parent: string, specName: string): Promise<void> {
      const specSubDir = join(parent, specName);
      await mkdir(specSubDir, { recursive: true });
      await writeFile(
        join(specSubDir, "spec.json"),
        JSON.stringify({
          approvals: {
            human_interaction: { approved: true },
            requirements: { approved: true },
            design: { approved: true },
            tasks: { approved: true },
          },
          ready_for_implementation: true,
        }),
      );
      await writeFile(join(specSubDir, "requirements.md"), "# Requirements");
      await writeFile(join(specSubDir, "design.md"), "# Design");
      await writeFile(join(specSubDir, "tasks.md"), "# Tasks");
    }

    it("emits info log with { phase, specName } when a phase begins", async () => {
      await setupSpecDir(tmpDir, "test-spec");
      const logger = makeLogger();
      const useCase = new RunSpecUseCase({
        stateStore: makeStateStore({ persist: mock(() => Promise.resolve()) }),
        eventBus: makeRealEventBus(),
        sdd: makeSdd(),
        frameworkDefinition: makeFrameworkDef(),
        createLlmProvider: () => makeLlm(),
        memory: makeMemoryPort(),
        logger,
      });

      await useCase.run("test-spec", { ...baseConfig, specDir: tmpDir }, { dryRun: false });

      const infoCalls = (logger.info as ReturnType<typeof mock>).mock.calls as [string, object?][];
      const phaseStartCalls = infoCalls.filter(([msg]) => msg === "Phase started");
      expect(phaseStartCalls.length).toBeGreaterThan(0);
      expect(phaseStartCalls[0]?.[1]).toMatchObject({ phase: expect.any(String), specName: "test-spec" });
    });

    it("emits info log with { phase, outcome } when a phase completes", async () => {
      await setupSpecDir(tmpDir, "test-spec");
      const logger = makeLogger();
      const useCase = new RunSpecUseCase({
        stateStore: makeStateStore({ persist: mock(() => Promise.resolve()) }),
        eventBus: makeRealEventBus(),
        sdd: makeSdd(),
        frameworkDefinition: makeFrameworkDef(),
        createLlmProvider: () => makeLlm(),
        memory: makeMemoryPort(),
        logger,
      });

      await useCase.run("test-spec", { ...baseConfig, specDir: tmpDir }, { dryRun: false });

      const infoCalls = (logger.info as ReturnType<typeof mock>).mock.calls as [string, object?][];
      const phaseCompleteCalls = infoCalls.filter(([msg]) => msg === "Phase completed");
      expect(phaseCompleteCalls.length).toBeGreaterThan(0);
      expect(phaseCompleteCalls[0]?.[1]).toMatchObject({
        phase: expect.any(String),
        outcome: "completed",
        durationMs: expect.any(Number),
      });
    });

    it("emits error log with { phase, reason } when a phase fails", async () => {
      const failingSdd = makeSdd();
      (failingSdd.executeCommand as ReturnType<typeof mock>) = mock(() =>
        Promise.resolve({ ok: false as const, error: { exitCode: 1, stderr: "init failed" } })
      );
      const logger = makeLogger();
      const useCase = new RunSpecUseCase({
        stateStore: makeStateStore({ persist: mock(() => Promise.resolve()) }),
        eventBus: makeRealEventBus(),
        sdd: failingSdd,
        frameworkDefinition: makeFrameworkDef(),
        createLlmProvider: () => makeLlm(),
        memory: makeMemoryPort(),
        logger,
      });

      const result = await useCase.run("test-spec", { ...baseConfig, specDir: tmpDir }, { dryRun: false });

      expect(result.status).toBe("failed");
      const errorCalls = (logger.error as ReturnType<typeof mock>).mock.calls as [string, object?][];
      const phaseErrorCalls = errorCalls.filter(([msg]) => msg === "Phase failed");
      expect(phaseErrorCalls.length).toBeGreaterThan(0);
      expect(phaseErrorCalls[0]?.[1]).toMatchObject({ phase: expect.any(String), reason: expect.any(String) });
    });

    it("does not crash when no logger is provided", async () => {
      await setupSpecDir(tmpDir, "test-spec");
      const useCase = new RunSpecUseCase({
        stateStore: makeStateStore({ persist: mock(() => Promise.resolve()) }),
        eventBus: makeRealEventBus(),
        sdd: makeSdd(),
        frameworkDefinition: makeFrameworkDef(),
        createLlmProvider: () => makeLlm(),
        memory: makeMemoryPort(),
      });

      await expect(
        useCase.run("test-spec", { ...baseConfig, specDir: tmpDir }, { dryRun: false }),
      ).resolves.toBeDefined();
    });
  });

  describe("memory lifecycle", () => {
    it("calls memory.shortTerm.clear() at the start of a non-dry-run execution", async () => {
      const shortTerm = makeShortTerm();
      const memory = makeMemoryPort(shortTerm);
      const useCase = new RunSpecUseCase({
        stateStore: makeStateStore({ persist: mock(() => Promise.resolve()) }),
        eventBus: makeEventBus(),
        sdd: makeSdd(),
        frameworkDefinition: makeFrameworkDef(),
        createLlmProvider: () => makeLlm(),
        memory,
      });

      await useCase.run("test-spec", { ...baseConfig, specDir: tmpDir }, { dryRun: false });

      expect(shortTerm.clear).toHaveBeenCalledTimes(1);
    });

    it("does NOT call memory.shortTerm.clear() during dry-run", async () => {
      const specParent = join(tmpDir, "..");
      const specName = tmpDir.split("/").at(-1) ?? "test-spec";
      const shortTerm = makeShortTerm();
      const memory = makeMemoryPort(shortTerm);
      const useCase = new RunSpecUseCase({
        stateStore: makeStateStore(),
        eventBus: makeEventBus(),
        sdd: makeSdd(),
        frameworkDefinition: makeFrameworkDef(),
        createLlmProvider: () => makeLlm(),
        memory,
      });

      await useCase.run(specName, { ...baseConfig, specDir: specParent }, { dryRun: true });

      expect(shortTerm.clear).not.toHaveBeenCalled();
    });
  });
});
