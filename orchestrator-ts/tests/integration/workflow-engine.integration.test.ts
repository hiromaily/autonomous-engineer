/**
 * Integration tests for WorkflowEngine with real infrastructure.
 *
 * Uses real WorkflowStateStore (file I/O), real WorkflowEventBus (EventEmitter),
 * and real ApprovalGate (reads spec.json from disk), with stub PhaseRunner.
 *
 * Verifies:
 * - 3-phase sub-sequence: SPEC_INIT → REQUIREMENTS → paused_for_approval
 * - State file contents after each phase
 * - Events emitted in the correct order
 * - Resume behavior: SPEC_INIT is NOT re-executed after pausing at REQUIREMENTS
 *
 * Task 9.1 — Requirements: 3.1, 3.2, 3.3, 3.6, 6.1, 6.4
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowEvent } from "../../application/ports/workflow";
import { ApprovalGate } from "../../domain/workflow/approval-gate";
import type { PhaseResult, PhaseRunner } from "../../domain/workflow/phase-runner";
import type { WorkflowPhase, WorkflowState } from "../../domain/workflow/types";
import { WorkflowEngine } from "../../domain/workflow/workflow-engine";
import { WorkflowEventBus } from "../../infra/events/workflow-event-bus";
import { WorkflowStateStore } from "../../infra/state/workflow-state-store";

// ---------------------------------------------------------------------------
// Stub PhaseRunner factory — records which phases were executed
// ---------------------------------------------------------------------------

function makeStubPhaseRunner(opts?: {
  failPhase?: WorkflowPhase;
  artifactsByPhase?: Partial<Record<WorkflowPhase, string[]>>;
}): PhaseRunner & { executedPhases: WorkflowPhase[]; enteredPhases: WorkflowPhase[] } {
  const executedPhases: WorkflowPhase[] = [];
  const enteredPhases: WorkflowPhase[] = [];

  const runner: PhaseRunner = {
    execute: mock(async (phase: WorkflowPhase): Promise<PhaseResult> => {
      executedPhases.push(phase);
      if (opts?.failPhase === phase) {
        return { ok: false, error: `Simulated failure at ${phase}` };
      }
      const artifacts = opts?.artifactsByPhase?.[phase] ?? [];
      return { ok: true, artifacts };
    }),
    onEnter: mock(async (phase: WorkflowPhase) => {
      enteredPhases.push(phase);
    }),
    onExit: mock(async (_phase: WorkflowPhase) => {}),
  } as unknown as PhaseRunner;

  return Object.assign(runner, { executedPhases, enteredPhases });
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let specDir: string;
let stateStore: WorkflowStateStore;
let eventBus: WorkflowEventBus;
let capturedEvents: WorkflowEvent[];

const SPEC_NAME = "integration-test-spec";

function captureEvents(bus: WorkflowEventBus): WorkflowEvent[] {
  const events: WorkflowEvent[] = [];
  bus.on((e) => events.push(e));
  return events;
}

async function writeSpecJson(data: Record<string, unknown>): Promise<void> {
  await writeFile(join(specDir, "spec.json"), JSON.stringify(data, null, 2));
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "aes-engine-integration-"));
  specDir = join(tmpDir, ".kiro", "specs", SPEC_NAME);
  await mkdir(specDir, { recursive: true });

  stateStore = new WorkflowStateStore(tmpDir);
  eventBus = new WorkflowEventBus();
  capturedEvents = captureEvents(eventBus);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 3-phase sub-sequence: SPEC_INIT → REQUIREMENTS → paused_for_approval
// ---------------------------------------------------------------------------

describe("WorkflowEngine integration — SPEC_INIT → REQUIREMENTS → paused_for_approval", () => {
  it("pauses at REQUIREMENTS when spec.json has requirements.approved=false", async () => {
    // Spec directory has no spec.json → ApprovalGate fails closed → will pause after REQUIREMENTS
    const phaseRunner = makeStubPhaseRunner();
    const engine = new WorkflowEngine({
      stateStore,
      eventBus,
      phaseRunner,
      approvalGate: new ApprovalGate(),
      specDir,
      language: "en",
    });
    const initialState = stateStore.init(SPEC_NAME);

    const result = await engine.execute(initialState);

    expect(result.status).toBe("paused");
    if (result.status === "paused") {
      expect(result.phase).toBe("REQUIREMENTS");
      expect(result.reason).toBe("approval_required");
    }
  });

  it("persists paused_for_approval state to disk", async () => {
    const phaseRunner = makeStubPhaseRunner();
    const engine = new WorkflowEngine({
      stateStore,
      eventBus,
      phaseRunner,
      approvalGate: new ApprovalGate(),
      specDir,
      language: "en",
    });

    await engine.execute(stateStore.init(SPEC_NAME));

    const persistedState = await stateStore.restore(SPEC_NAME);
    expect(persistedState).not.toBeNull();
    expect(persistedState?.status).toBe("paused_for_approval");
    expect(persistedState?.currentPhase).toBe("REQUIREMENTS");
  });

  it("state file reflects paused_for_approval at REQUIREMENTS", async () => {
    const phaseRunner = makeStubPhaseRunner();
    const engine = new WorkflowEngine({
      stateStore,
      eventBus,
      phaseRunner,
      approvalGate: new ApprovalGate(),
      specDir,
      language: "en",
    });

    await engine.execute(stateStore.init(SPEC_NAME));

    const stateFilePath = join(tmpDir, ".aes", "state", `${SPEC_NAME}.json`);
    const raw = await readFile(stateFilePath, "utf-8");
    const parsed = JSON.parse(raw) as WorkflowState;

    expect(parsed.status).toBe("paused_for_approval");
    expect(parsed.currentPhase).toBe("REQUIREMENTS");
    expect(parsed.completedPhases).toContain("SPEC_INIT");
    expect(parsed.completedPhases).not.toContain("REQUIREMENTS");
  });

  it("emits phase:start and phase:complete for SPEC_INIT, then phase:start and phase:complete for REQUIREMENTS, then approval:required", async () => {
    const phaseRunner = makeStubPhaseRunner();
    const engine = new WorkflowEngine({
      stateStore,
      eventBus,
      phaseRunner,
      approvalGate: new ApprovalGate(),
      specDir,
      language: "en",
    });

    await engine.execute(stateStore.init(SPEC_NAME));

    const types = capturedEvents.map((e) => e.type);
    expect(types).toContain("phase:start");
    expect(types).toContain("phase:complete");
    expect(types).toContain("approval:required");

    // SPEC_INIT events come before REQUIREMENTS events
    const specInitStartIdx = capturedEvents.findIndex((e) =>
      e.type === "phase:start" && "phase" in e && e.phase === "SPEC_INIT"
    );
    const reqStartIdx = capturedEvents.findIndex((e) =>
      e.type === "phase:start" && "phase" in e && e.phase === "REQUIREMENTS"
    );
    const approvalIdx = capturedEvents.findIndex((e) => e.type === "approval:required");

    expect(specInitStartIdx).toBeGreaterThanOrEqual(0);
    expect(reqStartIdx).toBeGreaterThan(specInitStartIdx);
    expect(approvalIdx).toBeGreaterThan(reqStartIdx);
  });

  it("executes SPEC_INIT and REQUIREMENTS phases", async () => {
    const phaseRunner = makeStubPhaseRunner();
    const engine = new WorkflowEngine({
      stateStore,
      eventBus,
      phaseRunner,
      approvalGate: new ApprovalGate(),
      specDir,
      language: "en",
    });

    await engine.execute(stateStore.init(SPEC_NAME));

    expect(phaseRunner.executedPhases).toContain("SPEC_INIT");
    expect(phaseRunner.executedPhases).toContain("REQUIREMENTS");
    // Should not have advanced past REQUIREMENTS without approval
    expect(phaseRunner.executedPhases).not.toContain("DESIGN");
  });
});

// ---------------------------------------------------------------------------
// Resume: re-check approval gate, advance without re-executing REQUIREMENTS
// ---------------------------------------------------------------------------

describe("WorkflowEngine integration — resume after REQUIREMENTS approval", () => {
  async function runInitialAndPause(): Promise<{ executedPhases: WorkflowPhase[] }> {
    const phaseRunner = makeStubPhaseRunner();
    const engine = new WorkflowEngine({
      stateStore,
      eventBus,
      phaseRunner,
      approvalGate: new ApprovalGate(),
      specDir,
      language: "en",
    });
    await engine.execute(stateStore.init(SPEC_NAME));
    return { executedPhases: [...phaseRunner.executedPhases] };
  }

  it("SPEC_INIT is NOT re-executed on resume after REQUIREMENTS approval", async () => {
    // First run: pauses at REQUIREMENTS
    await runInitialAndPause();

    // Update spec.json: grant requirements approval
    await writeSpecJson({
      approvals: { requirements: { approved: true }, design: { approved: true }, tasks: { approved: true } },
      ready_for_implementation: true,
    });

    // Pre-create required artifacts (stub runner doesn't write files; engine validates them)
    await writeFile(join(specDir, "requirements.md"), "# Requirements\n");
    await writeFile(join(specDir, "design.md"), "# Design\n");
    await writeFile(join(specDir, "tasks.md"), "# Tasks\n");

    // Resume run: create fresh engine with restored state
    const restoredState = await stateStore.restore(SPEC_NAME);
    expect(restoredState).not.toBeNull();

    const resumeRunner = makeStubPhaseRunner();
    const resumeEngine = new WorkflowEngine({
      stateStore,
      eventBus: new WorkflowEventBus(),
      phaseRunner: resumeRunner,
      approvalGate: new ApprovalGate(),
      specDir,
      language: "en",
    });

    await resumeEngine.execute(restoredState!);

    // SPEC_INIT must NOT be re-executed
    expect(resumeRunner.executedPhases).not.toContain("SPEC_INIT");
    // REQUIREMENTS must NOT be re-executed (was already completed)
    expect(resumeRunner.executedPhases).not.toContain("REQUIREMENTS");
    // DESIGN should be executed next
    expect(resumeRunner.executedPhases).toContain("DESIGN");
  });

  it("approval:required event is re-emitted when spec.json still has not approved on resume", async () => {
    // First run: pauses at REQUIREMENTS (no spec.json)
    await runInitialAndPause();

    // Resume without updating spec.json
    const restoredState = await stateStore.restore(SPEC_NAME);
    const resumeEvents: WorkflowEvent[] = [];
    const resumeBus = new WorkflowEventBus();
    resumeBus.on((e) => resumeEvents.push(e));

    const resumeRunner = makeStubPhaseRunner();
    const resumeEngine = new WorkflowEngine({
      stateStore,
      eventBus: resumeBus,
      phaseRunner: resumeRunner,
      approvalGate: new ApprovalGate(),
      specDir,
      language: "en",
    });

    const result = await resumeEngine.execute(restoredState!);

    expect(result.status).toBe("paused");
    expect(resumeEvents.some((e) => e.type === "approval:required")).toBe(true);
    // Still should not execute SPEC_INIT on resume
    expect(resumeRunner.executedPhases).not.toContain("SPEC_INIT");
  });

  it("workflow completes when all gates are approved and DESIGN/VALIDATE_DESIGN/TASK_GENERATION succeed", async () => {
    // Set up spec.json with all approvals and required artifacts on disk
    await writeSpecJson({
      approvals: {
        requirements: { approved: true },
        design: { approved: true },
        tasks: { approved: true },
      },
      ready_for_implementation: true,
    });

    // Pre-create required artifacts so artifact validation passes
    await writeFile(join(specDir, "requirements.md"), "# Requirements\n");
    await writeFile(join(specDir, "design.md"), "# Design\n");
    await writeFile(join(specDir, "tasks.md"), "# Tasks\n");

    const phaseRunner = makeStubPhaseRunner();
    const engine = new WorkflowEngine({
      stateStore,
      eventBus,
      phaseRunner,
      approvalGate: new ApprovalGate(),
      specDir,
      language: "en",
    });

    const result = await engine.execute(stateStore.init(SPEC_NAME));

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.completedPhases).toContain("SPEC_INIT");
      expect(result.completedPhases).toContain("REQUIREMENTS");
      expect(result.completedPhases).toContain("DESIGN");
      expect(result.completedPhases).toContain("TASK_GENERATION");
      expect(result.completedPhases).toContain("IMPLEMENTATION");
      expect(result.completedPhases).toContain("PULL_REQUEST");
    }
  });
});

// ---------------------------------------------------------------------------
// WorkflowStateStore integration: persist and restore cycle
// ---------------------------------------------------------------------------

describe("WorkflowStateStore integration — persist and restore cycle", () => {
  it("restores each status variant correctly", async () => {
    const variants: WorkflowState[] = [
      {
        specName: SPEC_NAME,
        currentPhase: "REQUIREMENTS",
        completedPhases: ["SPEC_INIT"],
        status: "running",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        specName: SPEC_NAME,
        currentPhase: "REQUIREMENTS",
        completedPhases: ["SPEC_INIT"],
        status: "paused_for_approval",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        specName: SPEC_NAME,
        currentPhase: "DESIGN",
        completedPhases: ["SPEC_INIT", "REQUIREMENTS"],
        status: "completed",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        specName: SPEC_NAME,
        currentPhase: "DESIGN",
        completedPhases: ["SPEC_INIT", "REQUIREMENTS"],
        status: "failed",
        failureDetail: { phase: "DESIGN", error: "SDD error" },
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    for (const variant of variants) {
      await stateStore.persist(variant);
      const restored = await stateStore.restore(SPEC_NAME);

      expect(restored?.status).toBe(variant.status);
      expect(restored?.currentPhase).toBe(variant.currentPhase);
      expect(restored?.completedPhases).toEqual(variant.completedPhases);

      if (variant.failureDetail) {
        expect(restored?.failureDetail?.phase).toBe(variant.failureDetail.phase);
        expect(restored?.failureDetail?.error).toBe(variant.failureDetail.error);
      }
    }
  });

  it("atomic write: state file is valid JSON after persist", async () => {
    const state = stateStore.init(SPEC_NAME);
    await stateStore.persist(state);

    const stateFilePath = join(tmpDir, ".aes", "state", `${SPEC_NAME}.json`);
    const raw = await readFile(stateFilePath, "utf-8");

    expect(() => JSON.parse(raw)).not.toThrow();
    const parsed = JSON.parse(raw) as WorkflowState;
    expect(parsed.specName).toBe(SPEC_NAME);
  });

  it("no .tmp file remains after successful persist", async () => {
    const state = stateStore.init(SPEC_NAME);
    await stateStore.persist(state);

    const stateDir = join(tmpDir, ".aes", "state");
    const files = await import("node:fs/promises").then((m) => m.readdir(stateDir));
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });
});
