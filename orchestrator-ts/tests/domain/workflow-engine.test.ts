import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IWorkflowEventBus, IWorkflowStateStore, WorkflowEvent } from "../../application/ports/workflow";
import type { ApprovalGate } from "../../domain/workflow/approval-gate";
import type { PhaseResult, PhaseRunner } from "../../domain/workflow/phase-runner";
import { WORKFLOW_PHASES } from "../../domain/workflow/types";
import type { WorkflowPhase, WorkflowState } from "../../domain/workflow/types";
import { WorkflowEngine } from "../../domain/workflow/workflow-engine";

// ---- Stub factories --------------------------------------------------------

function makeStateStore(): IWorkflowStateStore & { persisted: WorkflowState[] } {
  const persisted: WorkflowState[] = [];
  return {
    persisted,
    persist: mock(async (state: WorkflowState) => {
      persisted.push(state);
    }),
    restore: mock(async (_specName: string) => null),
    init: mock((specName: string): WorkflowState => ({
      specName,
      currentPhase: "SPEC_INIT",
      completedPhases: [],
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
  };
}

function makePhaseRunner(resultFn?: (phase: WorkflowPhase) => PhaseResult): {
  runner: PhaseRunner;
  executeCalls: WorkflowPhase[];
  onEnterCalls: WorkflowPhase[];
} {
  const executeCalls: WorkflowPhase[] = [];
  const onEnterCalls: WorkflowPhase[] = [];
  const runner: PhaseRunner = {
    execute: mock(async (phase: WorkflowPhase) => {
      executeCalls.push(phase);
      return resultFn ? resultFn(phase) : { ok: true as const, artifacts: [] };
    }),
    onEnter: mock(async (phase: WorkflowPhase) => {
      onEnterCalls.push(phase);
    }),
    onExit: mock(async (_phase: WorkflowPhase) => {}),
  } as unknown as PhaseRunner;
  return { runner, executeCalls, onEnterCalls };
}

function makeEventBus(): IWorkflowEventBus {
  return {
    emit: mock(() => {}),
    on: mock(() => {}),
    off: mock(() => {}),
  };
}

function makeSpyEventBus(): IWorkflowEventBus & { events: WorkflowEvent[] } {
  const events: WorkflowEvent[] = [];
  return {
    events,
    emit: mock((event: WorkflowEvent) => {
      events.push(event);
    }),
    on: mock(() => {}),
    off: mock(() => {}),
  };
}

function makeApprovalGate(): ApprovalGate {
  return {
    check: mock(async () => ({ approved: true as const })),
  } as unknown as ApprovalGate;
}

/** Approval gate where specified phases return pending; all others are approved. */
function makePendingGate(pendingPhase: string): ApprovalGate & { checkedPhases: string[] } {
  const checkedPhases: string[] = [];
  return {
    checkedPhases,
    check: mock(async (_specDir: string, phase: string) => {
      checkedPhases.push(phase);
      if (phase === pendingPhase) {
        return {
          approved: false as const,
          artifactPath: `spec-dir/${phase}.md`,
          instruction: `Approve ${phase} in spec.json`,
        };
      }
      return { approved: true as const };
    }),
  } as unknown as ApprovalGate & { checkedPhases: string[] };
}

/** Approval gate that tracks which phases were checked. */
function makeTrackingGate(): ApprovalGate & { checkedPhases: string[] } {
  const checkedPhases: string[] = [];
  return {
    checkedPhases,
    check: mock(async (_specDir: string, phase: string) => {
      checkedPhases.push(phase);
      return { approved: true as const };
    }),
  } as unknown as ApprovalGate & { checkedPhases: string[] };
}

function makeInitialState(specName = "test-spec"): WorkflowState {
  const now = new Date().toISOString();
  return {
    specName,
    currentPhase: "SPEC_INIT",
    completedPhases: [],
    status: "running",
    startedAt: now,
    updatedAt: now,
  };
}

// ---- Tests -----------------------------------------------------------------

describe("WorkflowEngine", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aes-engine-test-"));
    // Pre-create all required artifact files and a ready spec.json so the
    // default test suite can run all 7 phases without failing.
    await writeFile(join(tmpDir, "requirements.md"), "# Requirements");
    await writeFile(join(tmpDir, "design.md"), "# Design");
    await writeFile(join(tmpDir, "tasks.md"), "# Tasks");
    await writeFile(join(tmpDir, "spec.json"), JSON.stringify({ ready_for_implementation: true }));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function buildEngine(overrides: {
    stateStore?: IWorkflowStateStore;
    phaseRunner?: PhaseRunner;
    specDir?: string;
  } = {}) {
    const stateStore = overrides.stateStore ?? makeStateStore();
    const phaseRunner = overrides.phaseRunner ?? makePhaseRunner().runner;
    return new WorkflowEngine({
      stateStore,
      eventBus: makeEventBus(),
      phaseRunner,
      approvalGate: makeApprovalGate(),
      specDir: overrides.specDir ?? tmpDir,
      language: "en",
    });
  }

  // ---- getState() ----------------------------------------------------------

  describe("getState()", () => {
    it("returns the state passed to execute() while running", async () => {
      const engine = buildEngine();
      const initial = makeInitialState();
      const resultPromise = engine.execute(initial);
      expect(engine.getState().specName).toBe("test-spec");
      await resultPromise;
    });

    it("reflects completed status after execute() finishes", async () => {
      const engine = buildEngine();
      await engine.execute(makeInitialState());
      expect(engine.getState().status).toBe("completed");
      expect(engine.getState().completedPhases).toHaveLength(WORKFLOW_PHASES.length);
    });
  });

  // ---- Phase sequence -------------------------------------------------------

  describe("phase sequence", () => {
    it("executes all 7 phases in WORKFLOW_PHASES order", async () => {
      const { runner, executeCalls } = makePhaseRunner();
      const engine = buildEngine({ phaseRunner: runner });

      const result = await engine.execute(makeInitialState());

      expect(result.status).toBe("completed");
      expect(executeCalls).toEqual([...WORKFLOW_PHASES]);
    });

    it("skips phases already in completedPhases", async () => {
      const { runner, executeCalls } = makePhaseRunner();
      const engine = buildEngine({ phaseRunner: runner });

      const partialState: WorkflowState = {
        ...makeInitialState(),
        currentPhase: "REQUIREMENTS",
        completedPhases: ["SPEC_INIT"],
        updatedAt: new Date().toISOString(),
      };

      const result = await engine.execute(partialState);

      expect(result.status).toBe("completed");
      expect(executeCalls).not.toContain("SPEC_INIT");
      expect(executeCalls).toContain("REQUIREMENTS");
    });

    it("returns completed result with all completedPhases", async () => {
      const engine = buildEngine();
      const result = await engine.execute(makeInitialState());

      expect(result.status).toBe("completed");
      if (result.status === "completed") {
        expect([...result.completedPhases]).toEqual([...WORKFLOW_PHASES]);
      }
    });

    it("calls onEnter before execute for each phase", async () => {
      const { runner, executeCalls, onEnterCalls } = makePhaseRunner();
      const engine = buildEngine({ phaseRunner: runner });
      await engine.execute(makeInitialState());

      expect(onEnterCalls).toEqual(executeCalls);
    });
  });

  // ---- State persistence ----------------------------------------------------

  describe("state persistence", () => {
    it("persists state before invoking the phase runner for each phase", async () => {
      const stateStore = makeStateStore();
      const countAtExecute: number[] = [];

      const { runner } = makePhaseRunner((_phase) => {
        countAtExecute.push(stateStore.persisted.length);
        return { ok: true, artifacts: [] };
      });

      const engine = buildEngine({ stateStore, phaseRunner: runner });
      await engine.execute(makeInitialState());

      // Each phase should have had at least one persist call before it ran
      for (const count of countAtExecute) {
        expect(count).toBeGreaterThan(0);
      }
    });

    it("persists final completed state after all phases finish", async () => {
      const stateStore = makeStateStore();
      const engine = buildEngine({ stateStore });
      await engine.execute(makeInitialState());

      const last = stateStore.persisted.at(-1);
      expect(last?.status).toBe("completed");
      expect(last?.completedPhases).toHaveLength(WORKFLOW_PHASES.length);
    });

    it("persists failed state with failureDetail when a phase fails", async () => {
      const stateStore = makeStateStore();
      const { runner } = makePhaseRunner((phase) =>
        phase === "REQUIREMENTS"
          ? { ok: false, error: "SDD adapter error" }
          : { ok: true, artifacts: [] }
      );

      const engine = buildEngine({ stateStore, phaseRunner: runner });
      const result = await engine.execute(makeInitialState());

      expect(result.status).toBe("failed");
      const failedState = stateStore.persisted.find((s) => s.status === "failed");
      expect(failedState?.failureDetail?.phase).toBe("REQUIREMENTS");
      expect(failedState?.failureDetail?.error).toBe("SDD adapter error");
    });
  });

  // ---- Phase failure --------------------------------------------------------

  describe("phase failure", () => {
    it("returns failed result when a phase fails", async () => {
      const { runner } = makePhaseRunner((phase) =>
        phase === "DESIGN"
          ? { ok: false, error: "cc-sdd returned exit 1" }
          : { ok: true, artifacts: [] }
      );
      const engine = buildEngine({ phaseRunner: runner });

      const result = await engine.execute(makeInitialState());

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.phase).toBe("DESIGN");
        expect(result.error).toBe("cc-sdd returned exit 1");
      }
    });

    it("stops execution after a phase fails (does not run subsequent phases)", async () => {
      const { runner, executeCalls } = makePhaseRunner((phase) =>
        phase === "REQUIREMENTS"
          ? { ok: false, error: "error" }
          : { ok: true, artifacts: [] }
      );
      const engine = buildEngine({ phaseRunner: runner });

      await engine.execute(makeInitialState());

      expect(executeCalls).not.toContain("DESIGN");
      expect(executeCalls).not.toContain("VALIDATE_DESIGN");
    });

    it("reflects failed status in getState() after a phase fails", async () => {
      const { runner } = makePhaseRunner((phase) =>
        phase === "DESIGN" ? { ok: false, error: "boom" } : { ok: true, artifacts: [] }
      );
      const engine = buildEngine({ phaseRunner: runner });
      await engine.execute(makeInitialState());

      const state = engine.getState();
      expect(state.status).toBe("failed");
      expect(state.failureDetail?.phase).toBe("DESIGN");
    });
  });

  // ---- Artifact validation --------------------------------------------------

  describe("artifact validation", () => {
    it("fails at DESIGN when requirements.md is missing", async () => {
      // Fresh dir with no artifacts
      const emptyDir = await mkdtemp(join(tmpdir(), "aes-engine-empty-"));
      try {
        const { runner } = makePhaseRunner();
        const engine = new WorkflowEngine({
          stateStore: makeStateStore(),
          eventBus: makeEventBus(),
          phaseRunner: runner,
          approvalGate: makeApprovalGate(),
          specDir: emptyDir,
          language: "en",
        });

        // Start right before DESIGN
        const stateBeforeDesign: WorkflowState = {
          ...makeInitialState(),
          currentPhase: "DESIGN",
          completedPhases: ["SPEC_INIT", "REQUIREMENTS"],
          updatedAt: new Date().toISOString(),
        };

        const result = await engine.execute(stateBeforeDesign);

        expect(result.status).toBe("failed");
        if (result.status === "failed") {
          expect(result.phase).toBe("DESIGN");
          expect(result.error).toContain("requirements.md");
        }
      } finally {
        await rm(emptyDir, { recursive: true, force: true });
      }
    });

    it("succeeds at DESIGN when requirements.md exists", async () => {
      const specDir = await mkdtemp(join(tmpdir(), "aes-engine-art-"));
      try {
        await writeFile(join(specDir, "requirements.md"), "# Requirements");
        await writeFile(join(specDir, "design.md"), "# Design");
        await writeFile(join(specDir, "tasks.md"), "# Tasks");
        await writeFile(join(specDir, "spec.json"), JSON.stringify({ ready_for_implementation: true }));

        const { runner } = makePhaseRunner();
        const engine = new WorkflowEngine({
          stateStore: makeStateStore(),
          eventBus: makeEventBus(),
          phaseRunner: runner,
          approvalGate: makeApprovalGate(),
          specDir,
          language: "en",
        });

        const stateBeforeDesign: WorkflowState = {
          ...makeInitialState(),
          currentPhase: "DESIGN",
          completedPhases: ["SPEC_INIT", "REQUIREMENTS"],
          updatedAt: new Date().toISOString(),
        };

        const result = await engine.execute(stateBeforeDesign);
        expect(result.status).toBe("completed");
      } finally {
        await rm(specDir, { recursive: true, force: true });
      }
    });

    it("fails at IMPLEMENTATION when tasks.md is missing", async () => {
      const specDir = await mkdtemp(join(tmpdir(), "aes-engine-impl-"));
      try {
        await writeFile(join(specDir, "requirements.md"), "# Requirements");
        await writeFile(join(specDir, "design.md"), "# Design");
        // tasks.md intentionally missing

        const { runner } = makePhaseRunner();
        const engine = new WorkflowEngine({
          stateStore: makeStateStore(),
          eventBus: makeEventBus(),
          phaseRunner: runner,
          approvalGate: makeApprovalGate(),
          specDir,
          language: "en",
        });

        const stateBeforeImpl: WorkflowState = {
          ...makeInitialState(),
          currentPhase: "IMPLEMENTATION",
          completedPhases: ["SPEC_INIT", "REQUIREMENTS", "DESIGN", "VALIDATE_DESIGN", "TASK_GENERATION"],
          updatedAt: new Date().toISOString(),
        };

        const result = await engine.execute(stateBeforeImpl);

        expect(result.status).toBe("failed");
        if (result.status === "failed") {
          expect(result.phase).toBe("IMPLEMENTATION");
          expect(result.error).toContain("tasks.md");
        }
      } finally {
        await rm(specDir, { recursive: true, force: true });
      }
    });

    it("does not fail SPEC_INIT on missing artifacts (no requirements for first phase)", async () => {
      const emptyDir = await mkdtemp(join(tmpdir(), "aes-engine-spec-init-"));
      try {
        // Only SPEC_INIT: no artifacts required, so it runs to completion of that phase
        const { runner, executeCalls } = makePhaseRunner();
        const engine = new WorkflowEngine({
          stateStore: makeStateStore(),
          eventBus: makeEventBus(),
          phaseRunner: runner,
          approvalGate: makeApprovalGate(),
          specDir: emptyDir,
          language: "en",
        });

        // Run only SPEC_INIT by starting with all others already completed
        const stateAllButLast: WorkflowState = {
          ...makeInitialState(),
          currentPhase: "SPEC_INIT",
          completedPhases: [],
          updatedAt: new Date().toISOString(),
        };

        const result = await engine.execute(stateAllButLast);

        // SPEC_INIT has no artifact requirements; it should succeed
        expect(executeCalls[0]).toBe("SPEC_INIT");
        // The overall run may still fail on subsequent phases, but NOT on SPEC_INIT itself
        if (result.status === "failed") {
          expect((result as { phase: WorkflowPhase }).phase).not.toBe("SPEC_INIT");
        }
      } finally {
        await rm(emptyDir, { recursive: true, force: true });
      }
    });
  });

  // ---- Concurrent execution prevention ------------------------------------

  describe("concurrent execution prevention", () => {
    it("throws if execute() is called while already running", async () => {
      // Block at the first stateStore.persist() call so isRunning stays true
      let unblock!: () => void;
      const stateStore = makeStateStore();
      let firstCall = true;
      stateStore.persist = mock(async (state: WorkflowState) => {
        stateStore.persisted.push(state);
        if (firstCall) {
          firstCall = false;
          await new Promise<void>((resolve) => {
            unblock = resolve;
          });
        }
      });

      const engine = buildEngine({ stateStore });
      const firstRun = engine.execute(makeInitialState());

      // Yield so the first execute reaches the blocking persist
      await Promise.resolve();
      await Promise.resolve();

      // Second call while first is blocked — must throw
      await expect(engine.execute(makeInitialState())).rejects.toThrow();

      // Unblock and clean up
      unblock();
      await firstRun;
    });

    it("allows execute() again after a previous run completes", async () => {
      const engine = buildEngine();
      await engine.execute(makeInitialState());

      const secondResult = await engine.execute(makeInitialState());
      expect(secondResult.status).toBe("completed");
    });
  });

  // ---- Event emission (task 7.2) -------------------------------------------

  describe("event emission", () => {
    it("emits phase:start for every phase with an ISO 8601 timestamp", async () => {
      const eventBus = makeSpyEventBus();
      const engine = new WorkflowEngine({
        stateStore: makeStateStore(),
        eventBus,
        phaseRunner: makePhaseRunner().runner,
        approvalGate: makeApprovalGate(),
        specDir: tmpDir,
        language: "en",
      });

      await engine.execute(makeInitialState());

      const startEvents = eventBus.events.filter((e) => e.type === "phase:start");
      expect(startEvents).toHaveLength(WORKFLOW_PHASES.length);
      for (const e of startEvents) {
        if (e.type === "phase:start") {
          expect(WORKFLOW_PHASES).toContain(e.phase);
          expect(new Date(e.timestamp).toISOString()).toBe(e.timestamp);
        }
      }
    });

    it("emits phase:start events in WORKFLOW_PHASES order", async () => {
      const eventBus = makeSpyEventBus();
      const engine = new WorkflowEngine({
        stateStore: makeStateStore(),
        eventBus,
        phaseRunner: makePhaseRunner().runner,
        approvalGate: makeApprovalGate(),
        specDir: tmpDir,
        language: "en",
      });

      await engine.execute(makeInitialState());

      const phases = eventBus.events
        .filter((e) => e.type === "phase:start")
        .map((e) => (e as { type: "phase:start"; phase: WorkflowPhase }).phase);
      expect(phases).toEqual([...WORKFLOW_PHASES]);
    });

    it("emits phase:start before phase runner execute() is called", async () => {
      const eventBus = makeSpyEventBus();
      const executeOrder: string[] = [];

      const { runner } = makePhaseRunner((phase) => {
        executeOrder.push(`execute:${phase}`);
        return { ok: true, artifacts: [] };
      });

      // Override emit to record ordering
      const origEmit = eventBus.emit.bind(eventBus);
      (eventBus as { emit: (e: WorkflowEvent) => void }).emit = (event: WorkflowEvent) => {
        if (event.type === "phase:start") {
          executeOrder.push(`start:${event.phase}`);
        }
        origEmit(event);
      };

      const engine = new WorkflowEngine({
        stateStore: makeStateStore(),
        eventBus,
        phaseRunner: runner,
        approvalGate: makeApprovalGate(),
        specDir: tmpDir,
        language: "en",
      });

      await engine.execute(makeInitialState());

      // For each phase, start:<phase> must appear before execute:<phase>
      for (const phase of WORKFLOW_PHASES) {
        const startIdx = executeOrder.indexOf(`start:${phase}`);
        const execIdx = executeOrder.indexOf(`execute:${phase}`);
        expect(startIdx).toBeGreaterThanOrEqual(0);
        expect(execIdx).toBeGreaterThan(startIdx);
      }
    });

    it("emits phase:complete with durationMs >= 0 and artifacts from phase runner", async () => {
      const eventBus = makeSpyEventBus();
      const { runner } = makePhaseRunner((phase) => ({
        ok: true as const,
        artifacts: [`${phase.toLowerCase()}.md`],
      }));

      const engine = new WorkflowEngine({
        stateStore: makeStateStore(),
        eventBus,
        phaseRunner: runner,
        approvalGate: makeApprovalGate(),
        specDir: tmpDir,
        language: "en",
      });

      await engine.execute(makeInitialState());

      const completeEvents = eventBus.events.filter((e) => e.type === "phase:complete");
      expect(completeEvents).toHaveLength(WORKFLOW_PHASES.length);

      for (const e of completeEvents) {
        if (e.type === "phase:complete") {
          expect(e.durationMs).toBeGreaterThanOrEqual(0);
          expect(Array.isArray(e.artifacts)).toBe(true);
          expect(e.artifacts).toHaveLength(1);
        }
      }
    });

    it("emits phase:complete events in WORKFLOW_PHASES order", async () => {
      const eventBus = makeSpyEventBus();
      const engine = new WorkflowEngine({
        stateStore: makeStateStore(),
        eventBus,
        phaseRunner: makePhaseRunner().runner,
        approvalGate: makeApprovalGate(),
        specDir: tmpDir,
        language: "en",
      });

      await engine.execute(makeInitialState());

      const phases = eventBus.events
        .filter((e) => e.type === "phase:complete")
        .map((e) => (e as { type: "phase:complete"; phase: WorkflowPhase }).phase);
      expect(phases).toEqual([...WORKFLOW_PHASES]);
    });

    it("emits phase:error (not phase:complete) when phase runner returns failure", async () => {
      const eventBus = makeSpyEventBus();
      const { runner } = makePhaseRunner((phase) =>
        phase === "DESIGN"
          ? { ok: false, error: "adapter crashed" }
          : { ok: true, artifacts: [] }
      );

      const engine = new WorkflowEngine({
        stateStore: makeStateStore(),
        eventBus,
        phaseRunner: runner,
        approvalGate: makeApprovalGate(),
        specDir: tmpDir,
        language: "en",
      });

      await engine.execute(makeInitialState());

      const errorEvents = eventBus.events.filter((e) => e.type === "phase:error");
      expect(errorEvents).toHaveLength(1);
      const errEvt = errorEvents[0];
      if (errEvt?.type === "phase:error") {
        expect(errEvt.phase).toBe("DESIGN");
        expect(errEvt.error).toBe("adapter crashed");
        expect(typeof errEvt.operation).toBe("string");
        expect(errEvt.operation.length).toBeGreaterThan(0);
      }

      // No phase:complete should be emitted for the failed phase
      const completePhases = eventBus.events
        .filter((e) => e.type === "phase:complete")
        .map((e) => (e as { phase: WorkflowPhase }).phase);
      expect(completePhases).not.toContain("DESIGN");
    });

    it("emits workflow:failed when a phase fails", async () => {
      const eventBus = makeSpyEventBus();
      const { runner } = makePhaseRunner((phase) =>
        phase === "REQUIREMENTS"
          ? { ok: false, error: "SDD error" }
          : { ok: true, artifacts: [] }
      );

      const engine = new WorkflowEngine({
        stateStore: makeStateStore(),
        eventBus,
        phaseRunner: runner,
        approvalGate: makeApprovalGate(),
        specDir: tmpDir,
        language: "en",
      });

      await engine.execute(makeInitialState());

      const failedEvents = eventBus.events.filter((e) => e.type === "workflow:failed");
      expect(failedEvents).toHaveLength(1);
      const failEvt = failedEvents[0];
      if (failEvt?.type === "workflow:failed") {
        expect(failEvt.phase).toBe("REQUIREMENTS");
        expect(failEvt.error).toBe("SDD error");
      }
    });

    it("emits workflow:complete when all phases succeed", async () => {
      const eventBus = makeSpyEventBus();
      const engine = new WorkflowEngine({
        stateStore: makeStateStore(),
        eventBus,
        phaseRunner: makePhaseRunner().runner,
        approvalGate: makeApprovalGate(),
        specDir: tmpDir,
        language: "en",
      });

      await engine.execute(makeInitialState());

      const completeEvents = eventBus.events.filter((e) => e.type === "workflow:complete");
      expect(completeEvents).toHaveLength(1);
      const completeEvt = completeEvents[0];
      if (completeEvt?.type === "workflow:complete") {
        expect([...completeEvt.completedPhases]).toEqual([...WORKFLOW_PHASES]);
      }
    });

    it("does not emit workflow:complete when a phase fails", async () => {
      const eventBus = makeSpyEventBus();
      const { runner } = makePhaseRunner((phase) =>
        phase === "SPEC_INIT" ? { ok: false, error: "init failed" } : { ok: true, artifacts: [] }
      );

      const engine = new WorkflowEngine({
        stateStore: makeStateStore(),
        eventBus,
        phaseRunner: runner,
        approvalGate: makeApprovalGate(),
        specDir: tmpDir,
        language: "en",
      });

      await engine.execute(makeInitialState());

      expect(eventBus.events.filter((e) => e.type === "workflow:complete")).toHaveLength(0);
    });

    it("emits phase:error when artifact validation fails", async () => {
      const emptyDir = await mkdtemp(join(tmpdir(), "aes-engine-evt-art-"));
      try {
        const eventBus = makeSpyEventBus();
        const engine = new WorkflowEngine({
          stateStore: makeStateStore(),
          eventBus,
          phaseRunner: makePhaseRunner().runner,
          approvalGate: makeApprovalGate(),
          specDir: emptyDir,
          language: "en",
        });

        // Start before DESIGN — artifact validation will fail (no requirements.md)
        await engine.execute({
          ...makeInitialState(),
          currentPhase: "DESIGN",
          completedPhases: ["SPEC_INIT", "REQUIREMENTS"],
          updatedAt: new Date().toISOString(),
        });

        const errorEvents = eventBus.events.filter((e) => e.type === "phase:error");
        expect(errorEvents).toHaveLength(1);
        const errEvt = errorEvents[0];
        if (errEvt?.type === "phase:error") {
          expect(errEvt.phase).toBe("DESIGN");
          expect(errEvt.error).toContain("requirements.md");
        }
      } finally {
        await rm(emptyDir, { recursive: true, force: true });
      }
    });

    it("event sequence for a successful run: start → complete per phase, then workflow:complete", async () => {
      const eventBus = makeSpyEventBus();
      const engine = new WorkflowEngine({
        stateStore: makeStateStore(),
        eventBus,
        phaseRunner: makePhaseRunner().runner,
        approvalGate: makeApprovalGate(),
        specDir: tmpDir,
        language: "en",
      });

      await engine.execute(makeInitialState());

      const types = eventBus.events.map((e) => e.type);
      // Last event must be workflow:complete
      expect(types.at(-1)).toBe("workflow:complete");
      // For each phase: phase:start immediately before phase:complete
      for (const phase of WORKFLOW_PHASES) {
        const startIdx = eventBus.events.findIndex(
          (e) => e.type === "phase:start" && (e as { phase: WorkflowPhase }).phase === phase,
        );
        const completeIdx = eventBus.events.findIndex(
          (e) => e.type === "phase:complete" && (e as { phase: WorkflowPhase }).phase === phase,
        );
        expect(startIdx).toBeGreaterThanOrEqual(0);
        expect(completeIdx).toBeGreaterThan(startIdx);
      }
    });
  });

  // ---- Approval gates (task 7.3) -------------------------------------------

  describe("approval gates", () => {
    // ---- Gate is checked for the right phases --------------------------------

    it("checks approval gate after REQUIREMENTS (with phase type \"requirements\")", async () => {
      const gate = makeTrackingGate();
      const _engine = buildEngine({ phaseRunner: makePhaseRunner().runner });
      // Replace the engine with one using our tracking gate
      const tracked = new WorkflowEngine({
        stateStore: makeStateStore(),
        eventBus: makeEventBus(),
        phaseRunner: makePhaseRunner().runner,
        approvalGate: gate,
        specDir: tmpDir,
        language: "en",
      });

      await tracked.execute(makeInitialState());

      expect(gate.checkedPhases).toContain("requirements");
    });

    it("checks approval gate after VALIDATE_DESIGN (with phase type \"design\")", async () => {
      const gate = makeTrackingGate();
      const tracked = new WorkflowEngine({
        stateStore: makeStateStore(),
        eventBus: makeEventBus(),
        phaseRunner: makePhaseRunner().runner,
        approvalGate: gate,
        specDir: tmpDir,
        language: "en",
      });

      await tracked.execute(makeInitialState());

      expect(gate.checkedPhases).toContain("design");
    });

    it("checks approval gate after TASK_GENERATION (with phase type \"tasks\")", async () => {
      const gate = makeTrackingGate();
      const tracked = new WorkflowEngine({
        stateStore: makeStateStore(),
        eventBus: makeEventBus(),
        phaseRunner: makePhaseRunner().runner,
        approvalGate: gate,
        specDir: tmpDir,
        language: "en",
      });

      await tracked.execute(makeInitialState());

      expect(gate.checkedPhases).toContain("tasks");
    });

    it("does not check approval gate for non-gated phases (SPEC_INIT, DESIGN, IMPLEMENTATION, PULL_REQUEST)", async () => {
      const gate = makeTrackingGate();
      const tracked = new WorkflowEngine({
        stateStore: makeStateStore(),
        eventBus: makeEventBus(),
        phaseRunner: makePhaseRunner().runner,
        approvalGate: gate,
        specDir: tmpDir,
        language: "en",
      });

      await tracked.execute(makeInitialState());

      expect(gate.checkedPhases).not.toContain("spec_init");
      expect(gate.checkedPhases).not.toContain("design_validate");
      // Only 3 gate checks expected: requirements, design, tasks
      expect(gate.checkedPhases).toHaveLength(3);
    });

    // ---- Paused state when gate returns pending ------------------------------

    it("returns paused result when REQUIREMENTS gate is pending", async () => {
      const engine = new WorkflowEngine({
        stateStore: makeStateStore(),
        eventBus: makeEventBus(),
        phaseRunner: makePhaseRunner().runner,
        approvalGate: makePendingGate("requirements"),
        specDir: tmpDir,
        language: "en",
      });

      const result = await engine.execute(makeInitialState());

      expect(result.status).toBe("paused");
      if (result.status === "paused") {
        expect(result.phase).toBe("REQUIREMENTS");
        expect(result.reason).toBe("approval_required");
      }
    });

    it("persists paused_for_approval state with currentPhase set to gated phase", async () => {
      const stateStore = makeStateStore();
      const engine = new WorkflowEngine({
        stateStore,
        eventBus: makeEventBus(),
        phaseRunner: makePhaseRunner().runner,
        approvalGate: makePendingGate("requirements"),
        specDir: tmpDir,
        language: "en",
      });

      await engine.execute(makeInitialState());

      const pausedPersisted = stateStore.persisted.find((s) => s.status === "paused_for_approval");
      expect(pausedPersisted).toBeDefined();
      expect(pausedPersisted?.currentPhase).toBe("REQUIREMENTS");
      // REQUIREMENTS must NOT be in completedPhases when paused
      expect(pausedPersisted?.completedPhases).not.toContain("REQUIREMENTS");
    });

    it("emits approval:required event with artifactPath and instruction when paused", async () => {
      const eventBus = makeSpyEventBus();
      const engine = new WorkflowEngine({
        stateStore: makeStateStore(),
        eventBus,
        phaseRunner: makePhaseRunner().runner,
        approvalGate: makePendingGate("requirements"),
        specDir: tmpDir,
        language: "en",
      });

      await engine.execute(makeInitialState());

      const approvalEvents = eventBus.events.filter((e) => e.type === "approval:required");
      expect(approvalEvents).toHaveLength(1);
      const evt = approvalEvents[0];
      if (evt?.type === "approval:required") {
        expect(evt.phase).toBe("REQUIREMENTS");
        expect(typeof evt.artifactPath).toBe("string");
        expect(evt.artifactPath.length).toBeGreaterThan(0);
        expect(typeof evt.instruction).toBe("string");
        expect(evt.instruction.length).toBeGreaterThan(0);
      }
    });

    it("does not advance to DESIGN when REQUIREMENTS gate is pending", async () => {
      const { runner, executeCalls } = makePhaseRunner();
      const engine = new WorkflowEngine({
        stateStore: makeStateStore(),
        eventBus: makeEventBus(),
        phaseRunner: runner,
        approvalGate: makePendingGate("requirements"),
        specDir: tmpDir,
        language: "en",
      });

      await engine.execute(makeInitialState());

      expect(executeCalls).not.toContain("DESIGN");
    });

    // ---- Resume from paused state --------------------------------------------

    it("on resume with still-pending gate, returns paused again without re-executing", async () => {
      const { runner, executeCalls } = makePhaseRunner();
      const engine = new WorkflowEngine({
        stateStore: makeStateStore(),
        eventBus: makeEventBus(),
        phaseRunner: runner,
        approvalGate: makePendingGate("requirements"),
        specDir: tmpDir,
        language: "en",
      });

      // Simulate a paused state (REQUIREMENTS already ran but not approved)
      const pausedState: WorkflowState = {
        ...makeInitialState(),
        currentPhase: "REQUIREMENTS",
        completedPhases: ["SPEC_INIT"],
        status: "paused_for_approval",
        updatedAt: new Date().toISOString(),
      };

      const result = await engine.execute(pausedState);

      // Should return paused again
      expect(result.status).toBe("paused");
      // REQUIREMENTS must NOT have been re-executed
      expect(executeCalls).not.toContain("REQUIREMENTS");
    });

    it("on resume with now-approved gate, advances without re-executing paused phase", async () => {
      const { runner, executeCalls } = makePhaseRunner();
      const engine = new WorkflowEngine({
        stateStore: makeStateStore(),
        eventBus: makeEventBus(),
        phaseRunner: runner,
        approvalGate: makeApprovalGate(), // always approved
        specDir: tmpDir,
        language: "en",
      });

      // Simulate a paused state (REQUIREMENTS already ran and is now approved)
      const pausedState: WorkflowState = {
        ...makeInitialState(),
        currentPhase: "REQUIREMENTS",
        completedPhases: ["SPEC_INIT"],
        status: "paused_for_approval",
        updatedAt: new Date().toISOString(),
      };

      const result = await engine.execute(pausedState);

      // Should complete the full workflow
      expect(result.status).toBe("completed");
      // REQUIREMENTS must NOT have been re-executed
      expect(executeCalls).not.toContain("REQUIREMENTS");
      // But subsequent phases SHOULD have run
      expect(executeCalls).toContain("DESIGN");
      expect(executeCalls).toContain("PULL_REQUEST");
    });

    it("on resume, REQUIREMENTS is added to completedPhases when approved", async () => {
      const engine = new WorkflowEngine({
        stateStore: makeStateStore(),
        eventBus: makeEventBus(),
        phaseRunner: makePhaseRunner().runner,
        approvalGate: makeApprovalGate(),
        specDir: tmpDir,
        language: "en",
      });

      const pausedState: WorkflowState = {
        ...makeInitialState(),
        currentPhase: "REQUIREMENTS",
        completedPhases: ["SPEC_INIT"],
        status: "paused_for_approval",
        updatedAt: new Date().toISOString(),
      };

      await engine.execute(pausedState);

      const finalState = engine.getState();
      expect(finalState.completedPhases).toContain("REQUIREMENTS");
    });

    // ---- ready_for_implementation check before IMPLEMENTATION ---------------

    it("pauses before IMPLEMENTATION when ready_for_implementation is false in spec.json", async () => {
      const specDir = await mkdtemp(join(tmpdir(), "aes-engine-rfi-"));
      try {
        await writeFile(join(specDir, "requirements.md"), "# Req");
        await writeFile(join(specDir, "design.md"), "# Design");
        await writeFile(join(specDir, "tasks.md"), "# Tasks");
        // spec.json with ready_for_implementation: false
        await writeFile(join(specDir, "spec.json"), JSON.stringify({ ready_for_implementation: false }));

        const engine = new WorkflowEngine({
          stateStore: makeStateStore(),
          eventBus: makeEventBus(),
          phaseRunner: makePhaseRunner().runner,
          approvalGate: makeApprovalGate(),
          specDir,
          language: "en",
        });

        // Start right before IMPLEMENTATION (all prior phases complete)
        const stateBeforeImpl: WorkflowState = {
          ...makeInitialState(),
          currentPhase: "IMPLEMENTATION",
          completedPhases: ["SPEC_INIT", "REQUIREMENTS", "DESIGN", "VALIDATE_DESIGN", "TASK_GENERATION"],
          updatedAt: new Date().toISOString(),
        };

        const result = await engine.execute(stateBeforeImpl);

        expect(result.status).toBe("paused");
        if (result.status === "paused") {
          expect(result.reason).toBe("approval_required");
        }
      } finally {
        await rm(specDir, { recursive: true, force: true });
      }
    });

    it("pauses before IMPLEMENTATION when spec.json is missing", async () => {
      const specDir = await mkdtemp(join(tmpdir(), "aes-engine-rfi-missing-"));
      try {
        await writeFile(join(specDir, "requirements.md"), "# Req");
        await writeFile(join(specDir, "design.md"), "# Design");
        await writeFile(join(specDir, "tasks.md"), "# Tasks");
        // No spec.json

        const engine = new WorkflowEngine({
          stateStore: makeStateStore(),
          eventBus: makeEventBus(),
          phaseRunner: makePhaseRunner().runner,
          approvalGate: makeApprovalGate(),
          specDir,
          language: "en",
        });

        const stateBeforeImpl: WorkflowState = {
          ...makeInitialState(),
          currentPhase: "IMPLEMENTATION",
          completedPhases: ["SPEC_INIT", "REQUIREMENTS", "DESIGN", "VALIDATE_DESIGN", "TASK_GENERATION"],
          updatedAt: new Date().toISOString(),
        };

        const result = await engine.execute(stateBeforeImpl);

        expect(result.status).toBe("paused");
      } finally {
        await rm(specDir, { recursive: true, force: true });
      }
    });

    it("proceeds to IMPLEMENTATION when ready_for_implementation is true in spec.json", async () => {
      // tmpDir already has spec.json with ready_for_implementation: true
      const { runner, executeCalls } = makePhaseRunner();
      const engine = new WorkflowEngine({
        stateStore: makeStateStore(),
        eventBus: makeEventBus(),
        phaseRunner: runner,
        approvalGate: makeApprovalGate(),
        specDir: tmpDir,
        language: "en",
      });

      await engine.execute(makeInitialState());

      expect(executeCalls).toContain("IMPLEMENTATION");
    });

    it("emits approval:required event when ready_for_implementation is false", async () => {
      const specDir = await mkdtemp(join(tmpdir(), "aes-engine-rfi-evt-"));
      try {
        await writeFile(join(specDir, "requirements.md"), "# Req");
        await writeFile(join(specDir, "design.md"), "# Design");
        await writeFile(join(specDir, "tasks.md"), "# Tasks");
        await writeFile(join(specDir, "spec.json"), JSON.stringify({ ready_for_implementation: false }));

        const eventBus = makeSpyEventBus();
        const engine = new WorkflowEngine({
          stateStore: makeStateStore(),
          eventBus,
          phaseRunner: makePhaseRunner().runner,
          approvalGate: makeApprovalGate(),
          specDir,
          language: "en",
        });

        const stateBeforeImpl: WorkflowState = {
          ...makeInitialState(),
          currentPhase: "IMPLEMENTATION",
          completedPhases: ["SPEC_INIT", "REQUIREMENTS", "DESIGN", "VALIDATE_DESIGN", "TASK_GENERATION"],
          updatedAt: new Date().toISOString(),
        };

        await engine.execute(stateBeforeImpl);

        const approvalEvents = eventBus.events.filter((e) => e.type === "approval:required");
        expect(approvalEvents).toHaveLength(1);
        const evt = approvalEvents[0];
        if (evt?.type === "approval:required") {
          expect(evt.instruction).toContain("ready_for_implementation");
        }
      } finally {
        await rm(specDir, { recursive: true, force: true });
      }
    });
  });
});
