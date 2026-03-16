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
import type { WorkflowEvent } from "@/application/ports/workflow";
import { ApprovalGate } from "@/domain/workflow/approval-gate";
import type { PhaseResult, PhaseRunner } from "@/domain/workflow/phase-runner";
import type { WorkflowPhase, WorkflowState } from "@/domain/workflow/types";
import { WorkflowEngine } from "@/domain/workflow/workflow-engine";
import { WorkflowEventBus } from "@/infra/events/workflow-event-bus";
import { WorkflowStateStore } from "@/infra/state/workflow-state-store";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
// 3-phase sub-sequence: SPEC_INIT → HUMAN_INTERACTION → paused_for_approval
// ---------------------------------------------------------------------------

describe("WorkflowEngine integration — SPEC_INIT → HUMAN_INTERACTION → paused_for_approval", () => {
  it("pauses at HUMAN_INTERACTION when spec.json has human_interaction.approved=false", async () => {
    // Spec directory has no spec.json → ApprovalGate fails closed → will pause after HUMAN_INTERACTION
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
      expect(result.phase).toBe("HUMAN_INTERACTION");
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
    expect(persistedState?.currentPhase).toBe("HUMAN_INTERACTION");
  });

  it("state file reflects paused_for_approval at HUMAN_INTERACTION", async () => {
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
    expect(parsed.currentPhase).toBe("HUMAN_INTERACTION");
    expect(parsed.completedPhases).toContain("SPEC_INIT");
    expect(parsed.completedPhases).not.toContain("HUMAN_INTERACTION");
  });

  it("emits phase:start and phase:complete for SPEC_INIT, then phase:start and phase:complete for HUMAN_INTERACTION, then approval:required", async () => {
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

    // SPEC_INIT events come before HUMAN_INTERACTION events
    const specInitStartIdx = capturedEvents.findIndex((e) =>
      e.type === "phase:start" && "phase" in e && e.phase === "SPEC_INIT"
    );
    const humanStartIdx = capturedEvents.findIndex((e) =>
      e.type === "phase:start" && "phase" in e && e.phase === "HUMAN_INTERACTION"
    );
    const approvalIdx = capturedEvents.findIndex((e) => e.type === "approval:required");

    expect(specInitStartIdx).toBeGreaterThanOrEqual(0);
    expect(humanStartIdx).toBeGreaterThan(specInitStartIdx);
    expect(approvalIdx).toBeGreaterThan(humanStartIdx);
  });

  it("executes SPEC_INIT and HUMAN_INTERACTION phases", async () => {
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
    expect(phaseRunner.executedPhases).toContain("HUMAN_INTERACTION");
    // Should not have advanced past HUMAN_INTERACTION without approval
    expect(phaseRunner.executedPhases).not.toContain("VALIDATE_PREREQUISITES");
  });
});

// ---------------------------------------------------------------------------
// Resume: re-check approval gate, advance without re-executing REQUIREMENTS
// ---------------------------------------------------------------------------

describe("WorkflowEngine integration — resume after HUMAN_INTERACTION approval", () => {
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

  it("SPEC_INIT is NOT re-executed on resume after HUMAN_INTERACTION approval", async () => {
    // First run: pauses at HUMAN_INTERACTION
    await runInitialAndPause();

    // Update spec.json: grant all approvals
    await writeSpecJson({
      approvals: {
        human_interaction: { approved: true },
        requirements: { approved: true },
        design: { approved: true },
        tasks: { approved: true },
      },
      ready_for_implementation: true,
    });

    // Pre-create required artifacts (stub runner doesn't write files; engine validates them)
    await writeFile(join(specDir, "requirements.md"), "# Requirements\n");
    await writeFile(join(specDir, "design.md"), "# Design\n");
    await writeFile(join(specDir, "tasks.md"), "# Tasks\n");

    // Resume run: create fresh engine with restored state
    const restoredState = await stateStore.restore(SPEC_NAME);
    expect(restoredState).not.toBeNull();
    if (!restoredState) return;

    const resumeRunner = makeStubPhaseRunner();
    const resumeEngine = new WorkflowEngine({
      stateStore,
      eventBus: new WorkflowEventBus(),
      phaseRunner: resumeRunner,
      approvalGate: new ApprovalGate(),
      specDir,
      language: "en",
    });

    await resumeEngine.execute(restoredState);

    // SPEC_INIT must NOT be re-executed
    expect(resumeRunner.executedPhases).not.toContain("SPEC_INIT");
    // HUMAN_INTERACTION must NOT be re-executed (was already completed)
    expect(resumeRunner.executedPhases).not.toContain("HUMAN_INTERACTION");
    // VALIDATE_PREREQUISITES should be executed next
    expect(resumeRunner.executedPhases).toContain("VALIDATE_PREREQUISITES");
  });

  it("approval:required event is re-emitted when spec.json still has not approved on resume", async () => {
    // First run: pauses at HUMAN_INTERACTION (no spec.json)
    await runInitialAndPause();

    // Resume without updating spec.json
    const restoredState = await stateStore.restore(SPEC_NAME);
    if (!restoredState) return;
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

    const result = await resumeEngine.execute(restoredState);

    expect(result.status).toBe("paused");
    expect(resumeEvents.some((e) => e.type === "approval:required")).toBe(true);
    // Still should not execute SPEC_INIT on resume
    expect(resumeRunner.executedPhases).not.toContain("SPEC_INIT");
  });

  it("workflow completes when all gates are approved and all phases succeed", async () => {
    // Set up spec.json with all approvals and required artifacts on disk
    await writeSpecJson({
      approvals: {
        human_interaction: { approved: true },
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
      expect(result.completedPhases).toContain("HUMAN_INTERACTION");
      expect(result.completedPhases).toContain("VALIDATE_PREREQUISITES");
      expect(result.completedPhases).toContain("SPEC_REQUIREMENTS");
      expect(result.completedPhases).toContain("VALIDATE_REQUIREMENTS");
      expect(result.completedPhases).toContain("REFLECT_BEFORE_DESIGN");
      expect(result.completedPhases).toContain("VALIDATE_GAP");
      expect(result.completedPhases).toContain("SPEC_DESIGN");
      expect(result.completedPhases).toContain("VALIDATE_DESIGN");
      expect(result.completedPhases).toContain("REFLECT_BEFORE_TASKS");
      expect(result.completedPhases).toContain("SPEC_TASKS");
      expect(result.completedPhases).toContain("VALIDATE_TASK");
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
        currentPhase: "HUMAN_INTERACTION",
        completedPhases: ["SPEC_INIT"],
        status: "running",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        specName: SPEC_NAME,
        currentPhase: "HUMAN_INTERACTION",
        completedPhases: ["SPEC_INIT"],
        status: "paused_for_approval",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        specName: SPEC_NAME,
        currentPhase: "SPEC_DESIGN",
        completedPhases: ["SPEC_INIT", "HUMAN_INTERACTION", "VALIDATE_PREREQUISITES", "SPEC_REQUIREMENTS"],
        status: "completed",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        specName: SPEC_NAME,
        currentPhase: "SPEC_DESIGN",
        completedPhases: ["SPEC_INIT", "HUMAN_INTERACTION", "VALIDATE_PREREQUISITES", "SPEC_REQUIREMENTS"],
        status: "failed",
        failureDetail: { phase: "SPEC_DESIGN", error: "SDD error" },
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
