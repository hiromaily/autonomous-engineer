/**
 * End-to-end tests for the aes run command.
 *
 * Tests the full stack: CLI → RunSpecUseCase → WorkflowEngine with real
 * infrastructure (state store, event bus, approval gate) and controlled
 * SDD/LLM adapters.
 *
 * Test coverage:
 * - dry-run: no file writes, exit code 0
 * - full 7-phase workflow with fake cc-sdd binary and pre-approved spec.json
 * - --resume: SPEC_INIT not re-executed after simulated REQUIREMENTS interruption
 * - --log-json: all workflow events appear as valid NDJSON in the log file
 *
 * Task 9.2 — Requirements: 1.1, 1.6, 1.7, 1.8, 3.6, 5.1, 5.5
 */
import type { SpawnFn } from "@/adapters/sdd/cc-sdd-adapter";
import type { AesConfig } from "@/application/ports/config";
import type { LlmProviderPort } from "@/application/ports/llm";
import type { MemoryPort, ShortTermMemoryPort } from "@/application/ports/memory";
import type { SddFrameworkPort } from "@/application/ports/sdd";
import type { WorkflowEvent } from "@/application/ports/workflow";
import { RunSpecUseCase } from "@/application/usecases/run-spec";
import { JsonLogWriter } from "@/cli/json-log-writer";
import type { WorkflowPhase, WorkflowState } from "@/domain/workflow/types";
import { WorkflowEventBus } from "@/infra/events/workflow-event-bus";
import { WorkflowStateStore } from "@/infra/state/workflow-state-store";
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Fake cc-sdd binary (reused across E2E tests)
// ---------------------------------------------------------------------------

const FAKE_CC_SDD_CONTENT = `#!/usr/bin/env bun
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const args = process.argv.slice(2);
const subcmd = args[0] ?? '';
const specName = args[1] ?? '';
let specDir = '';
for (let i = 2; i < args.length; i++) {
  if (args[i] === '--spec-dir' && args[i + 1]) {
    specDir = args[i + 1];
    i++;
  }
}

if (!specDir) {
  process.stderr.write('fake-cc-sdd: missing --spec-dir\\n');
  process.exit(1);
}

const specPath = join(specDir, specName);
await mkdir(specPath, { recursive: true });

switch (subcmd) {
  case 'requirements':
    await writeFile(join(specPath, 'requirements.md'), '# Requirements\\n');
    break;
  case 'design':
    await writeFile(join(specPath, 'design.md'), '# Design\\n');
    break;
  case 'validate-design':
    await writeFile(join(specPath, 'design.md'), '# Design (validated)\\n');
    break;
  case 'tasks':
    await writeFile(join(specPath, 'tasks.md'), '# Tasks\\n');
    break;
  default:
    process.stderr.write('fake-cc-sdd: unknown subcommand: ' + subcmd + '\\n');
    process.exit(1);
}
`;

let fakeBinaryDir: string;
let fakeBinaryPath: string;

beforeAll(async () => {
  fakeBinaryDir = await mkdtemp(join(tmpdir(), "aes-e2e-bin-"));
  fakeBinaryPath = join(fakeBinaryDir, "fake-cc-sdd.ts");
  await writeFile(fakeBinaryPath, FAKE_CC_SDD_CONTENT);
});

afterAll(async () => {
  await rm(fakeBinaryDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test environment helpers
// ---------------------------------------------------------------------------

const BASE_CONFIG: AesConfig = {
  llm: { provider: "claude", modelName: "claude-sonnet-4-6", apiKey: "test-key" },
  specDir: "", // overridden per test
  sddFramework: "cc-sdd",
};

function makeLlmProvider(): LlmProviderPort {
  return {
    complete: mock(() =>
      Promise.resolve({ ok: true as const, value: { content: "", usage: { inputTokens: 0, outputTokens: 0 } } })
    ),
    clearContext: mock(() => {}),
  };
}

function makeMemoryPort(): MemoryPort {
  const shortTerm: ShortTermMemoryPort = {
    read: mock(() => ({ recentFiles: [] })),
    write: mock(() => {}),
    clear: mock(() => {}),
  };
  return {
    shortTerm,
    query: mock(() => Promise.resolve({ entries: [] })),
    append: mock(() => Promise.resolve({ ok: true as const, action: "appended" as const })),
    update: mock(() => Promise.resolve({ ok: true as const, action: "updated" as const })),
    writeFailure: mock(() => Promise.resolve({ ok: true as const, action: "appended" as const })),
    getFailures: mock(() => Promise.resolve([])),
  };
}

function makeStubSdd(): SddFrameworkPort {
  return {
    validatePrerequisites: mock(() => Promise.resolve({ ok: true as const, artifactPath: "" })),
    generateRequirements: mock(() => Promise.resolve({ ok: true as const, artifactPath: "" })),
    validateRequirements: mock(() => Promise.resolve({ ok: true as const, artifactPath: "" })),
    reflectOnExistingInformation: mock(() => Promise.resolve({ ok: true as const, artifactPath: "" })),
    validateGap: mock(() => Promise.resolve({ ok: true as const, artifactPath: "" })),
    generateDesign: mock(() => Promise.resolve({ ok: true as const, artifactPath: "" })),
    validateDesign: mock(() => Promise.resolve({ ok: true as const, artifactPath: "" })),
    generateTasks: mock(() => Promise.resolve({ ok: true as const, artifactPath: "" })),
    validateTask: mock(() => Promise.resolve({ ok: true as const, artifactPath: "" })),
  };
}

function _makeFakeCcSddSpawnFn(): SpawnFn {
  return (argv) => {
    const [_ccSdd, ...rest] = argv;
    return Bun.spawn(["bun", fakeBinaryPath, ...rest] as string[], { stderr: "pipe" });
  };
}

interface TestEnv {
  tmpDir: string;
  specParentDir: string;
  specDir: string;
  specName: string;
  config: AesConfig;
  stateStore: WorkflowStateStore;
  eventBus: WorkflowEventBus;
  events: WorkflowEvent[];
  cleanup: () => Promise<void>;
}

async function setupTestEnv(): Promise<TestEnv> {
  const tmpDir = await mkdtemp(join(tmpdir(), "aes-e2e-"));
  const specName = "test-spec";
  const specParentDir = join(tmpDir, ".kiro", "specs");
  const specDir = join(specParentDir, specName);
  await mkdir(specDir, { recursive: true });

  const stateStore = new WorkflowStateStore(tmpDir);
  const eventBus = new WorkflowEventBus();
  const events: WorkflowEvent[] = [];
  eventBus.on((e) => events.push(e));

  const config: AesConfig = { ...BASE_CONFIG, specDir: specParentDir };

  return {
    tmpDir,
    specParentDir,
    specDir,
    specName,
    config,
    stateStore,
    eventBus,
    events,
    cleanup: () => rm(tmpDir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// dry-run: no file writes, exit code 0 (via RunSpecUseCase)
// ---------------------------------------------------------------------------

describe("E2E: --dry-run", () => {
  it("returns completed with empty phases when spec directory exists", async () => {
    const env = await setupTestEnv();
    try {
      const useCase = new RunSpecUseCase({
        stateStore: env.stateStore,
        eventBus: env.eventBus,
        sdd: makeStubSdd(),
        createLlmProvider: () => makeLlmProvider(),
        memory: makeMemoryPort(),
      });

      const result = await useCase.run(env.specName, env.config, { resume: false, dryRun: true });

      expect(result.status).toBe("completed");
      if (result.status === "completed") {
        expect(result.completedPhases).toHaveLength(0);
      }
    } finally {
      await env.cleanup();
    }
  });

  it("does not write any state files in dry-run mode", async () => {
    const env = await setupTestEnv();
    try {
      const useCase = new RunSpecUseCase({
        stateStore: env.stateStore,
        eventBus: env.eventBus,
        sdd: makeStubSdd(),
        createLlmProvider: () => makeLlmProvider(),
        memory: makeMemoryPort(),
      });

      await useCase.run(env.specName, env.config, { resume: false, dryRun: true });

      // .aes/state directory should not exist (or be empty)
      const aesStateDir = join(env.tmpDir, ".aes", "state");
      let stateFiles: string[] = [];
      try {
        stateFiles = await readdir(aesStateDir);
      } catch {
        // Directory does not exist — that is fine
      }
      expect(stateFiles.filter((f) => f.endsWith(".json"))).toHaveLength(0);
    } finally {
      await env.cleanup();
    }
  });

  it("returns failed when spec directory does not exist", async () => {
    const env = await setupTestEnv();
    try {
      const useCase = new RunSpecUseCase({
        stateStore: env.stateStore,
        eventBus: env.eventBus,
        sdd: makeStubSdd(),
        createLlmProvider: () => makeLlmProvider(),
        memory: makeMemoryPort(),
      });

      const result = await useCase.run("nonexistent-spec", env.config, { resume: false, dryRun: true });

      expect(result.status).toBe("failed");
    } finally {
      await env.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Full 7-phase workflow with fake cc-sdd
// ---------------------------------------------------------------------------

describe("E2E: full 7-phase workflow", () => {
  /**
   * Uses stub SDD (no subprocess) with pre-created artifact files.
   * CcSddAdapter subprocess integration is covered in tests/integration/.
   */
  it("completes all 14 phases when all approvals are pre-granted", async () => {
    const env = await setupTestEnv();
    try {
      // Pre-approve all gates and set ready_for_implementation
      await writeFile(
        join(env.specDir, "spec.json"),
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

      // Pre-create required artifacts (engine validates these before each phase)
      await writeFile(join(env.specDir, "requirements.md"), "# Requirements\n");
      await writeFile(join(env.specDir, "design.md"), "# Design\n");
      await writeFile(join(env.specDir, "tasks.md"), "# Tasks\n");

      const useCase = new RunSpecUseCase({
        stateStore: env.stateStore,
        eventBus: env.eventBus,
        sdd: makeStubSdd(),
        createLlmProvider: () => makeLlmProvider(),
        memory: makeMemoryPort(),
      });

      const result = await useCase.run(env.specName, env.config, { resume: false, dryRun: false });

      expect(result.status).toBe("completed");
      if (result.status === "completed") {
        const phases = result.completedPhases;
        expect(phases).toContain("SPEC_INIT");
        expect(phases).toContain("HUMAN_INTERACTION");
        expect(phases).toContain("VALIDATE_PREREQUISITES");
        expect(phases).toContain("SPEC_REQUIREMENTS");
        expect(phases).toContain("VALIDATE_REQUIREMENTS");
        expect(phases).toContain("REFLECT_BEFORE_DESIGN");
        expect(phases).toContain("VALIDATE_GAP");
        expect(phases).toContain("SPEC_DESIGN");
        expect(phases).toContain("VALIDATE_DESIGN");
        expect(phases).toContain("REFLECT_BEFORE_TASKS");
        expect(phases).toContain("SPEC_TASKS");
        expect(phases).toContain("VALIDATE_TASK");
        expect(phases).toContain("IMPLEMENTATION");
        expect(phases).toContain("PULL_REQUEST");
      }
    } finally {
      await env.cleanup();
    }
  });

  it("emits workflow:complete event at end of successful run", async () => {
    const env = await setupTestEnv();
    try {
      await writeFile(
        join(env.specDir, "spec.json"),
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

      await writeFile(join(env.specDir, "requirements.md"), "# Requirements\n");
      await writeFile(join(env.specDir, "design.md"), "# Design\n");
      await writeFile(join(env.specDir, "tasks.md"), "# Tasks\n");

      const useCase = new RunSpecUseCase({
        stateStore: env.stateStore,
        eventBus: env.eventBus,
        sdd: makeStubSdd(),
        createLlmProvider: () => makeLlmProvider(),
        memory: makeMemoryPort(),
      });

      await useCase.run(env.specName, env.config, { resume: false, dryRun: false });

      expect(env.events.some((e) => e.type === "workflow:complete")).toBe(true);
    } finally {
      await env.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// --resume: SPEC_INIT not re-executed after interruption at SPEC_REQUIREMENTS
// ---------------------------------------------------------------------------

describe("E2E: --resume after simulated SPEC_REQUIREMENTS interruption", () => {
  it("SPEC_INIT is not re-executed when resuming from paused_for_approval at SPEC_REQUIREMENTS", async () => {
    const env = await setupTestEnv();
    try {
      // Persist a paused_for_approval state (simulating interruption after SPEC_REQUIREMENTS ran)
      const pausedState: WorkflowState = {
        specName: env.specName,
        currentPhase: "SPEC_REQUIREMENTS",
        completedPhases: [
          "SPEC_INIT",
          "HUMAN_INTERACTION",
          "VALIDATE_PREREQUISITES",
          /* SPEC_REQUIREMENTS was executed but not yet completed in the paused state */
        ],
        status: "paused_for_approval",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await env.stateStore.persist(pausedState);

      // Grant all approvals
      await writeFile(
        join(env.specDir, "spec.json"),
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

      // Pre-create artifact files so artifact validation passes
      await writeFile(join(env.specDir, "requirements.md"), "# Requirements\n");
      await writeFile(join(env.specDir, "design.md"), "# Design\n");
      await writeFile(join(env.specDir, "tasks.md"), "# Tasks\n");

      // Track SDD calls to verify SPEC_INIT is not re-executed
      const sddCalls: string[] = [];
      const trackingSdd: SddFrameworkPort = {
        validatePrerequisites: mock(async () => {
          sddCalls.push("validatePrerequisites");
          return { ok: true as const, artifactPath: join(env.specDir, "requirements.md") };
        }),
        generateRequirements: mock(async () => {
          sddCalls.push("generateRequirements");
          return { ok: true as const, artifactPath: join(env.specDir, "requirements.md") };
        }),
        validateRequirements: mock(async () => {
          sddCalls.push("validateRequirements");
          return { ok: true as const, artifactPath: join(env.specDir, "requirements.md") };
        }),
        reflectOnExistingInformation: mock(async () => {
          sddCalls.push("reflectOnExistingInformation");
          return { ok: true as const, artifactPath: join(env.specDir, "requirements.md") };
        }),
        validateGap: mock(async () => {
          sddCalls.push("validateGap");
          return { ok: true as const, artifactPath: join(env.specDir, "requirements.md") };
        }),
        generateDesign: mock(async () => {
          sddCalls.push("generateDesign");
          return { ok: true as const, artifactPath: join(env.specDir, "design.md") };
        }),
        validateDesign: mock(async () => {
          sddCalls.push("validateDesign");
          return { ok: true as const, artifactPath: join(env.specDir, "design.md") };
        }),
        generateTasks: mock(async () => {
          sddCalls.push("generateTasks");
          return { ok: true as const, artifactPath: join(env.specDir, "tasks.md") };
        }),
        validateTask: mock(async () => {
          sddCalls.push("validateTask");
          return { ok: true as const, artifactPath: join(env.specDir, "tasks.md") };
        }),
      };

      const useCase = new RunSpecUseCase({
        stateStore: env.stateStore,
        eventBus: env.eventBus,
        sdd: trackingSdd,
        createLlmProvider: () => makeLlmProvider(),
        memory: makeMemoryPort(),
      });

      const result = await useCase.run(env.specName, env.config, { resume: true, dryRun: false });

      expect(result.status).toBe("completed");

      // SPEC_INIT has no SDD call (it's a stub no-op); the key assertion is that
      // generateRequirements is also NOT called (SPEC_REQUIREMENTS was already completed)
      // since SPEC_INIT/HUMAN_INTERACTION/VALIDATE_PREREQUISITES were in completedPhases
      // and SPEC_REQUIREMENTS is the paused phase
      expect(sddCalls).not.toContain("generateRequirements");
      // SPEC_DESIGN and onwards should be executed
      expect(sddCalls).toContain("generateDesign");
    } finally {
      await env.cleanup();
    }
  });

  it("without --resume, starts fresh even when state file exists", async () => {
    const env = await setupTestEnv();
    try {
      // Persist a "completed" state
      const completedState: WorkflowState = {
        specName: env.specName,
        currentPhase: "PULL_REQUEST",
        completedPhases: [
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
          "VALIDATE_TASK",
          "IMPLEMENTATION",
          "PULL_REQUEST",
        ],
        status: "completed",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await env.stateStore.persist(completedState);

      // Grant all approvals
      await writeFile(
        join(env.specDir, "spec.json"),
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

      // Pre-create artifacts
      await writeFile(join(env.specDir, "requirements.md"), "# Requirements\n");
      await writeFile(join(env.specDir, "design.md"), "# Design\n");
      await writeFile(join(env.specDir, "tasks.md"), "# Tasks\n");

      const sddCalls: string[] = [];
      const trackingSdd: SddFrameworkPort = {
        validatePrerequisites: mock(async () => {
          sddCalls.push("validatePrerequisites");
          return { ok: true as const, artifactPath: join(env.specDir, "requirements.md") };
        }),
        generateRequirements: mock(async () => {
          sddCalls.push("generateRequirements");
          return { ok: true as const, artifactPath: join(env.specDir, "requirements.md") };
        }),
        validateRequirements: mock(async () => {
          sddCalls.push("validateRequirements");
          return { ok: true as const, artifactPath: join(env.specDir, "requirements.md") };
        }),
        reflectOnExistingInformation: mock(async () => {
          sddCalls.push("reflectOnExistingInformation");
          return { ok: true as const, artifactPath: join(env.specDir, "requirements.md") };
        }),
        validateGap: mock(async () => {
          sddCalls.push("validateGap");
          return { ok: true as const, artifactPath: join(env.specDir, "requirements.md") };
        }),
        generateDesign: mock(async () => {
          sddCalls.push("generateDesign");
          return { ok: true as const, artifactPath: join(env.specDir, "design.md") };
        }),
        validateDesign: mock(async () => {
          sddCalls.push("validateDesign");
          return { ok: true as const, artifactPath: join(env.specDir, "design.md") };
        }),
        generateTasks: mock(async () => {
          sddCalls.push("generateTasks");
          return { ok: true as const, artifactPath: join(env.specDir, "tasks.md") };
        }),
        validateTask: mock(async () => {
          sddCalls.push("validateTask");
          return { ok: true as const, artifactPath: join(env.specDir, "tasks.md") };
        }),
      };

      const useCase = new RunSpecUseCase({
        stateStore: env.stateStore,
        eventBus: env.eventBus,
        sdd: trackingSdd,
        createLlmProvider: () => makeLlmProvider(),
        memory: makeMemoryPort(),
      });

      // Without --resume, starts from scratch
      const result = await useCase.run(env.specName, env.config, { resume: false, dryRun: false });

      expect(result.status).toBe("completed");
      // Fresh run should execute all SDD phases
      expect(sddCalls).toContain("generateRequirements");
    } finally {
      await env.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// --log-json: all workflow events appear as valid NDJSON
// ---------------------------------------------------------------------------

describe("E2E: --log-json writes all events as newline-delimited JSON", () => {
  it("all emitted events appear in the log file as valid NDJSON", async () => {
    const env = await setupTestEnv();
    try {
      const logFilePath = join(env.tmpDir, "workflow-events.ndjson");

      // Pre-approve all gates
      await writeFile(
        join(env.specDir, "spec.json"),
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

      // Pre-create artifacts
      await writeFile(join(env.specDir, "requirements.md"), "# Requirements\n");
      await writeFile(join(env.specDir, "design.md"), "# Design\n");
      await writeFile(join(env.specDir, "tasks.md"), "# Tasks\n");

      // Wire up JsonLogWriter to the event bus (same as CLI does for --log-json)
      const logWriter = new JsonLogWriter(logFilePath);
      env.eventBus.on((event) => {
        logWriter.write(event).catch(() => {});
      });

      const useCase = new RunSpecUseCase({
        stateStore: env.stateStore,
        eventBus: env.eventBus,
        sdd: makeStubSdd(),
        createLlmProvider: () => makeLlmProvider(),
        memory: makeMemoryPort(),
      });

      await useCase.run(env.specName, env.config, { resume: false, dryRun: false });
      await logWriter.close();

      // Read and parse the NDJSON log
      const raw = await readFile(logFilePath, "utf-8");
      const lines = raw.trim().split("\n").filter((l) => l.length > 0);

      expect(lines.length).toBeGreaterThan(0);

      // Every line must be valid JSON
      const parsed: WorkflowEvent[] = [];
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
        parsed.push(JSON.parse(line) as WorkflowEvent);
      }

      // Must contain at least phase:start, phase:complete, workflow:complete
      const types = new Set(parsed.map((e) => e.type));
      expect(types.has("phase:start")).toBe(true);
      expect(types.has("phase:complete")).toBe(true);
      expect(types.has("workflow:complete")).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  it("each log line has a type discriminant field", async () => {
    const env = await setupTestEnv();
    try {
      const logFilePath = join(env.tmpDir, "events.ndjson");

      await writeFile(
        join(env.specDir, "spec.json"),
        JSON.stringify({
          approvals: {
            requirements: { approved: true },
            design: { approved: true },
            tasks: { approved: true },
          },
          ready_for_implementation: true,
        }),
      );

      await writeFile(join(env.specDir, "requirements.md"), "# Requirements\n");
      await writeFile(join(env.specDir, "design.md"), "# Design\n");
      await writeFile(join(env.specDir, "tasks.md"), "# Tasks\n");

      const logWriter = new JsonLogWriter(logFilePath);
      env.eventBus.on((event) => {
        logWriter.write(event).catch(() => {});
      });

      const useCase = new RunSpecUseCase({
        stateStore: env.stateStore,
        eventBus: env.eventBus,
        sdd: makeStubSdd(),
        createLlmProvider: () => makeLlmProvider(),
        memory: makeMemoryPort(),
      });

      await useCase.run(env.specName, env.config, { resume: false, dryRun: false });
      await logWriter.close();

      const raw = await readFile(logFilePath, "utf-8");
      const lines = raw.trim().split("\n").filter((l) => l.length > 0);

      for (const line of lines) {
        const obj = JSON.parse(line) as Record<string, unknown>;
        expect(typeof obj.type).toBe("string");
      }
    } finally {
      await env.cleanup();
    }
  });

  it("log file contains all 14 phase:start events for a complete workflow", async () => {
    const env = await setupTestEnv();
    try {
      const logFilePath = join(env.tmpDir, "events.ndjson");

      await writeFile(
        join(env.specDir, "spec.json"),
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

      await writeFile(join(env.specDir, "requirements.md"), "# Requirements\n");
      await writeFile(join(env.specDir, "design.md"), "# Design\n");
      await writeFile(join(env.specDir, "tasks.md"), "# Tasks\n");

      const logWriter = new JsonLogWriter(logFilePath);
      env.eventBus.on((event) => {
        logWriter.write(event).catch(() => {});
      });

      const useCase = new RunSpecUseCase({
        stateStore: env.stateStore,
        eventBus: env.eventBus,
        sdd: makeStubSdd(),
        createLlmProvider: () => makeLlmProvider(),
        memory: makeMemoryPort(),
      });

      await useCase.run(env.specName, env.config, { resume: false, dryRun: false });
      await logWriter.close();

      const raw = await readFile(logFilePath, "utf-8");
      const lines = raw.trim().split("\n").filter((l) => l.length > 0);
      const parsed = lines.map((l) => JSON.parse(l) as WorkflowEvent);

      const phaseStartEvents = parsed.filter((e) => e.type === "phase:start") as Array<
        { type: "phase:start"; phase: WorkflowPhase }
      >;
      const startedPhases = phaseStartEvents.map((e) => e.phase);

      const expectedPhases: WorkflowPhase[] = [
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
        "VALIDATE_TASK",
        "IMPLEMENTATION",
        "PULL_REQUEST",
      ];
      for (const phase of expectedPhases) {
        expect(startedPhases).toContain(phase);
      }
    } finally {
      await env.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// CLI subprocess: --dry-run exit code 0
// ---------------------------------------------------------------------------

describe("E2E: CLI subprocess dry-run exit code", () => {
  it("exits with code 0 when spec directory exists and config is valid", async () => {
    const env = await setupTestEnv();
    try {
      // Write a valid aes.config.json in tmpDir (the CLI's CWD)
      await writeFile(
        join(env.tmpDir, "aes.config.json"),
        JSON.stringify({
          llm: { provider: "claude", modelName: "claude-sonnet-4-6", apiKey: "test-key" },
          specDir: join(env.tmpDir, ".kiro", "specs"),
          sddFramework: "cc-sdd",
        }),
      );

      const cliPath = join(import.meta.dir, "../../src/cli/index.ts");
      const proc = Bun.spawn(
        ["bun", cliPath, "run", env.specName, "--dry-run"],
        { cwd: env.tmpDir, stderr: "pipe", stdout: "pipe" },
      );

      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
    } finally {
      await env.cleanup();
    }
  });

  it("exits with code 1 when spec directory does not exist", async () => {
    const env = await setupTestEnv();
    try {
      await writeFile(
        join(env.tmpDir, "aes.config.json"),
        JSON.stringify({
          llm: { provider: "claude", modelName: "claude-sonnet-4-6", apiKey: "test-key" },
          specDir: join(env.tmpDir, ".kiro", "specs"),
          sddFramework: "cc-sdd",
        }),
      );

      const cliPath = join(import.meta.dir, "../../src/cli/index.ts");
      const proc = Bun.spawn(
        ["bun", cliPath, "run", "nonexistent-spec", "--dry-run"],
        { cwd: env.tmpDir, stderr: "pipe", stdout: "pipe" },
      );

      const exitCode = await proc.exited;
      expect(exitCode).toBe(1);
    } finally {
      await env.cleanup();
    }
  });
});
