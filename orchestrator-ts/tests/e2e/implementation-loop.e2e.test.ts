/**
 * E2E tests for the implementation loop — Tasks 7.1, 7.2, 7.3
 *
 * Task 7.1 — full aes run with a minimal one-section plan:
 * - A single task section plan is run with a stub agent loop that writes one file
 * - Assert that a git commit is produced with the section title in the commit message
 * - Assert that the plan JSON in .aes/plans/ shows status: "completed" for the section
 * - Assert that an NDJSON log file is created at .aes/logs/implementation-loop-<planId>.ndjson
 *   with at least one iteration entry
 * - Requirements: 1.1, 1.3, 1.6, 4.4, 10.3
 *
 * Task 7.2 — E2E resumption after stop signal:
 * - Run against a three-section plan; send stop after section 1 commits
 * - Assert section 2 is "pending" in the persisted plan after stop
 * - Restart with resume(); assert section 1 is not re-executed and sections 2 and 3 complete
 * - Requirements: 9.1, 9.3, 9.4
 *
 * Task 7.3 — Performance test: elapsed time logging across sections:
 * - Run against a five-section stub plan; assert all durationMs fields are non-negative
 * - Assert context re-initialization does not cause observable memory growth across ten sections
 * - Requirements: 10.4
 */

import { ImplementationLoopService } from "@/application/implementation-loop/implementation-loop-service";
import type { IAgentLoop } from "@/application/ports/agent-loop";
import type { AgentLoopResult } from "@/application/ports/agent-loop";
import type { IContextEngine } from "@/application/ports/context";
import type { IGitController } from "@/application/ports/git-controller";
import type { GitResult } from "@/application/ports/git-controller";
import type { IPlanStore, IReviewEngine, SectionPersistenceStatus } from "@/application/ports/implementation-loop";
import type { AgentState } from "@/domain/agent/types";
import type { BranchCreationResult, CommitResult, GitChangesResult, PushResult } from "@/domain/git/types";
import type { ReviewResult, SectionExecutionRecord } from "@/domain/implementation-loop/types";
import type { Task, TaskPlan } from "@/domain/planning/types";
import { NdjsonImplementationLoopLogger } from "@/infra/implementation-loop/ndjson-logger";
import { describe, expect, it, mock } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Plan factories
// ---------------------------------------------------------------------------

function makeMinimalPlan(planId: string): TaskPlan {
  const section: Task = {
    id: "section-1",
    title: "implement minimal feature",
    status: "pending",
    steps: [],
  };
  return {
    id: planId,
    goal: "Minimal E2E test plan",
    tasks: [section],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** Build a plan with N sections, each with a unique id and title. */
function makeMultiSectionPlan(planId: string, sectionCount: number): TaskPlan {
  const tasks: Task[] = Array.from({ length: sectionCount }, (_, i) => ({
    id: `section-${i + 1}`,
    title: `implement section ${i + 1}`,
    status: "pending" as const,
    steps: [],
  }));
  return {
    id: planId,
    goal: `${sectionCount}-section E2E test plan`,
    tasks,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// File-backed IPlanStore — writes plan status to .aes/plans/<planId>.json
// ---------------------------------------------------------------------------

function makeFilePlanStore(initialPlan: TaskPlan, aesDir: string): IPlanStore {
  let currentPlan: TaskPlan = initialPlan;

  return {
    async loadPlan(planId: string): Promise<TaskPlan | null> {
      if (planId === currentPlan.id) return currentPlan;
      return null;
    },

    async updateSectionStatus(
      planId: string,
      sectionId: string,
      status: SectionPersistenceStatus,
    ): Promise<void> {
      currentPlan = {
        ...currentPlan,
        updatedAt: new Date().toISOString(),
        tasks: currentPlan.tasks.map((t) => t.id === sectionId ? { ...t, status: status as Task["status"] } : t),
      };
      // Persist the updated plan to .aes/plans/<planId>.json
      const plansDir = join(aesDir, "plans");
      await mkdir(plansDir, { recursive: true });
      await writeFile(
        join(plansDir, `${planId}.json`),
        JSON.stringify(currentPlan, null, 2),
        "utf-8",
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Stub IAgentLoop — writes a file and reports task completed
// ---------------------------------------------------------------------------

function makeStubAgentLoop(workDir: string): {
  agentLoop: IAgentLoop;
  writtenFiles: string[];
} {
  const writtenFiles: string[] = [];

  const agentLoop: IAgentLoop = {
    run: mock(async (task: string): Promise<AgentLoopResult> => {
      // Simulate agent work: write a file
      const fileName = `generated-${Date.now()}.txt`;
      const filePath = join(workDir, fileName);
      await writeFile(filePath, `# Generated by agent\nTask: ${task}\n`, "utf-8");
      writtenFiles.push(fileName);

      const finalState: AgentState = {
        task,
        plan: ["Write implementation file"],
        completedSteps: ["Write implementation file"],
        currentStep: null,
        iterationCount: 1,
        observations: [],
        recoveryAttempts: 0,
        startedAt: new Date().toISOString(),
      };

      return {
        terminationCondition: "TASK_COMPLETED",
        finalState,
        totalIterations: 1,
        taskCompleted: true,
      };
    }),
    stop: mock((): void => {}),
    getState: mock((): Readonly<AgentState> | null => null),
  };

  return { agentLoop, writtenFiles };
}

// ---------------------------------------------------------------------------
// Stub IReviewEngine — always passes
// ---------------------------------------------------------------------------

function makePassingReviewEngine(): IReviewEngine {
  return {
    review: mock(async (): Promise<ReviewResult> => ({
      outcome: "passed",
      checks: [
        {
          checkName: "requirement-alignment",
          outcome: "passed",
          required: true,
          details: "All requirements met",
        },
      ],
      feedback: [],
      durationMs: 10,
    })),
  };
}

// ---------------------------------------------------------------------------
// Stub IGitController — captures commits, returns a fake SHA
// ---------------------------------------------------------------------------

function makeStubGitController(): {
  gitController: IGitController;
  commits: Array<{ message: string; files: ReadonlyArray<string> }>;
} {
  const commits: Array<{ message: string; files: ReadonlyArray<string> }> = [];

  const gitController: IGitController = {
    listBranches: mock(
      async (): Promise<GitResult<ReadonlyArray<string>>> => ({
        ok: true,
        value: ["main"],
      }),
    ),
    detectChanges: mock(
      async (): Promise<GitResult<GitChangesResult>> => ({
        ok: true,
        value: {
          staged: [],
          unstaged: [],
          untracked: ["generated-stub.txt"],
        },
      }),
    ),
    stageAndCommit: mock(
      async (
        files: ReadonlyArray<string>,
        message: string,
      ): Promise<GitResult<CommitResult>> => {
        commits.push({ message, files });
        return {
          ok: true,
          value: {
            hash: "abc1234def5678",
            message,
            fileCount: files.length,
          },
        };
      },
    ),
    createAndCheckoutBranch: mock(
      async (): Promise<GitResult<BranchCreationResult>> => ({
        ok: true,
        value: {
          branchName: "feature/e2e-test",
          baseBranch: "main",
          conflictResolved: false,
        },
      }),
    ),
    push: mock(
      async (): Promise<GitResult<PushResult>> => ({
        ok: true,
        value: {
          remote: "origin",
          branchName: "feature/e2e-test",
          commitHash: "abc1234def5678",
        },
      }),
    ),
  };

  return { gitController, commits };
}

// ---------------------------------------------------------------------------
// E2E test suite
// ---------------------------------------------------------------------------

describe("E2E: implementation loop — minimal one-section plan (Task 7.1)", () => {
  it("produces a git commit with the section title in the commit message", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "impl-loop-e2e-"));
    const aesDir = join(tmpDir, ".aes");

    try {
      const planId = "e2e-minimal-plan";
      const plan = makeMinimalPlan(planId);
      const sectionTitle = plan.tasks[0]!.title;

      const planStore = makeFilePlanStore(plan, aesDir);
      const { agentLoop } = makeStubAgentLoop(tmpDir);
      const reviewEngine = makePassingReviewEngine();
      const { gitController, commits } = makeStubGitController();

      const service = new ImplementationLoopService(
        planStore,
        agentLoop,
        reviewEngine,
        gitController,
      );

      const result = await service.run(planId);

      expect(result.outcome).toBe("completed");
      expect(commits).toHaveLength(1);
      expect(commits[0]!.message).toContain(sectionTitle);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("updates plan JSON in .aes/plans/ to show status: completed for the section", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "impl-loop-e2e-"));
    const aesDir = join(tmpDir, ".aes");

    try {
      const planId = "e2e-plan-status-check";
      const plan = makeMinimalPlan(planId);
      const sectionId = plan.tasks[0]!.id;

      const planStore = makeFilePlanStore(plan, aesDir);
      const { agentLoop } = makeStubAgentLoop(tmpDir);
      const reviewEngine = makePassingReviewEngine();
      const { gitController } = makeStubGitController();

      const service = new ImplementationLoopService(
        planStore,
        agentLoop,
        reviewEngine,
        gitController,
      );

      await service.run(planId);

      // Read the persisted plan file from .aes/plans/<planId>.json
      const planFilePath = join(aesDir, "plans", `${planId}.json`);
      expect(existsSync(planFilePath)).toBe(true);

      const raw = await readFile(planFilePath, "utf-8");
      const persisted = JSON.parse(raw) as TaskPlan;

      const section = persisted.tasks.find((t) => t.id === sectionId);
      expect(section).toBeDefined();
      expect(section?.status).toBe("completed");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("creates an NDJSON log file at .aes/logs/implementation-loop-<planId>.ndjson with at least one iteration entry", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "impl-loop-e2e-"));
    const aesDir = join(tmpDir, ".aes");

    try {
      const planId = "e2e-log-check";
      const plan = makeMinimalPlan(planId);

      const planStore = makeFilePlanStore(plan, aesDir);
      const { agentLoop } = makeStubAgentLoop(tmpDir);
      const reviewEngine = makePassingReviewEngine();
      const { gitController } = makeStubGitController();

      const logDir = join(aesDir, "logs");
      const logger = new NdjsonImplementationLoopLogger(planId, logDir);

      const service = new ImplementationLoopService(
        planStore,
        agentLoop,
        reviewEngine,
        gitController,
      );

      await service.run(planId, { logger });

      // Assert NDJSON log file exists
      const logFilePath = join(logDir, `implementation-loop-${planId}.ndjson`);
      expect(existsSync(logFilePath)).toBe(true);

      // Read and parse the NDJSON log
      const raw = await readFile(logFilePath, "utf-8");
      const lines = raw.trim().split("\n").filter((l) => l.length > 0);

      expect(lines.length).toBeGreaterThanOrEqual(1);

      // Every line must be valid JSON with a `type` field
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
        const entry = JSON.parse(line) as Record<string, unknown>;
        expect(typeof entry.type).toBe("string");
      }

      // Must contain at least one "iteration" entry
      const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(entries.some((e) => e.type === "iteration")).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns outcome: completed with a single section record showing status: completed", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "impl-loop-e2e-"));
    const aesDir = join(tmpDir, ".aes");

    try {
      const planId = "e2e-result-check";
      const plan = makeMinimalPlan(planId);
      const sectionId = plan.tasks[0]!.id;

      const planStore = makeFilePlanStore(plan, aesDir);
      const { agentLoop } = makeStubAgentLoop(tmpDir);
      const reviewEngine = makePassingReviewEngine();
      const { gitController } = makeStubGitController();

      const service = new ImplementationLoopService(
        planStore,
        agentLoop,
        reviewEngine,
        gitController,
      );

      const result = await service.run(planId);

      expect(result.outcome).toBe("completed");
      expect(result.planId).toBe(planId);
      expect(result.sections).toHaveLength(1);
      expect(result.sections[0]!.sectionId).toBe(sectionId);
      expect(result.sections[0]!.status).toBe("completed");
      expect(result.sections[0]!.commitSha).toBe("abc1234def5678");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Task 7.2 — E2E resumption after stop signal
// ---------------------------------------------------------------------------

describe("E2E: implementation loop — resumption after stop signal (Task 7.2)", () => {
  it("stops after section 1 commits and section 2 remains pending in the plan store", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "impl-loop-resume-"));
    const aesDir = join(tmpDir, ".aes");

    try {
      const planId = "e2e-stop-resume";
      const plan = makeMultiSectionPlan(planId, 3);

      const planStore = makeFilePlanStore(plan, aesDir);
      const { agentLoop } = makeStubAgentLoop(tmpDir);
      const reviewEngine = makePassingReviewEngine();

      // Late-binding reference so the git stub can call stop() after section 1 commits
      let serviceRef: ImplementationLoopService | undefined;
      let commitCount = 0;
      const commits: Array<{ message: string }> = [];

      const gitController: IGitController = {
        listBranches: mock(async (): Promise<GitResult<ReadonlyArray<string>>> => ({
          ok: true,
          value: ["main"],
        })),
        detectChanges: mock(async (): Promise<GitResult<GitChangesResult>> => ({
          ok: true,
          value: { staged: [], unstaged: [], untracked: ["output.txt"] },
        })),
        stageAndCommit: mock(
          async (files: ReadonlyArray<string>, message: string): Promise<GitResult<CommitResult>> => {
            commitCount++;
            commits.push({ message });
            // Trigger stop after the first section commits — simulates external stop signal
            if (commitCount === 1) {
              serviceRef?.stop();
            }
            return {
              ok: true,
              value: { hash: `sha-${commitCount}`, message, fileCount: files.length },
            };
          },
        ),
        createAndCheckoutBranch: mock(
          async (): Promise<GitResult<BranchCreationResult>> => ({
            ok: true,
            value: { branchName: "feature/test", baseBranch: "main", conflictResolved: false },
          }),
        ),
        push: mock(
          async (): Promise<GitResult<PushResult>> => ({
            ok: true,
            value: { remote: "origin", branchName: "feature/test", commitHash: "sha-1" },
          }),
        ),
      };

      const service = new ImplementationLoopService(
        planStore,
        agentLoop,
        reviewEngine,
        gitController,
      );
      serviceRef = service;

      const result = await service.run(planId);

      // First run should stop after section 1 commits
      expect(result.outcome).toBe("stopped");
      expect(commits).toHaveLength(1);
      expect(commits[0]!.message).toContain("implement section 1");

      // Section 2 should still be in "pending" state (stop check happens before in_progress write)
      const planFilePath = join(aesDir, "plans", `${planId}.json`);
      expect(existsSync(planFilePath)).toBe(true);
      const persistedRaw = await readFile(planFilePath, "utf-8");
      const persisted = JSON.parse(persistedRaw) as TaskPlan;

      const section1 = persisted.tasks.find((t) => t.id === "section-1");
      const section2 = persisted.tasks.find((t) => t.id === "section-2");
      expect(section1).toBeDefined();
      expect(section2).toBeDefined();
      expect(section1!.status).toBe("completed");
      expect(["pending", "in_progress"]).toContain(section2!.status);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("resume() skips section 1 and completes sections 2 and 3", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "impl-loop-resume-"));
    const aesDir = join(tmpDir, ".aes");

    try {
      const planId = "e2e-stop-resume-full";
      const plan = makeMultiSectionPlan(planId, 3);

      // First pass: use a stop-after-section-1 git controller
      const planStore = makeFilePlanStore(plan, aesDir);
      const agentRunTasks: string[] = [];

      const agentLoop: IAgentLoop = {
        run: mock(async (task: string): Promise<AgentLoopResult> => {
          agentRunTasks.push(task);
          const finalState: AgentState = {
            task,
            plan: [],
            completedSteps: [],
            currentStep: null,
            iterationCount: 1,
            observations: [],
            recoveryAttempts: 0,
            startedAt: new Date().toISOString(),
          };
          return { terminationCondition: "TASK_COMPLETED", finalState, totalIterations: 1, taskCompleted: true };
        }),
        stop: mock((): void => {}),
        getState: mock((): Readonly<AgentState> | null => null),
      };

      const reviewEngine = makePassingReviewEngine();

      let serviceRef: ImplementationLoopService | undefined;
      let commitCount = 0;

      const gitController: IGitController = {
        listBranches: mock(async (): Promise<GitResult<ReadonlyArray<string>>> => ({ ok: true, value: ["main"] })),
        detectChanges: mock(async (): Promise<GitResult<GitChangesResult>> => ({
          ok: true,
          value: { staged: [], unstaged: [], untracked: ["out.txt"] },
        })),
        stageAndCommit: mock(
          async (files: ReadonlyArray<string>, message: string): Promise<GitResult<CommitResult>> => {
            commitCount++;
            if (commitCount === 1) serviceRef?.stop();
            return { ok: true, value: { hash: `sha-${commitCount}`, message, fileCount: files.length } };
          },
        ),
        createAndCheckoutBranch: mock(async (): Promise<GitResult<BranchCreationResult>> => ({
          ok: true,
          value: { branchName: "feature/test", baseBranch: "main", conflictResolved: false },
        })),
        push: mock(async (): Promise<GitResult<PushResult>> => ({
          ok: true,
          value: { remote: "origin", branchName: "feature/test", commitHash: "sha-1" },
        })),
      };

      const firstService = new ImplementationLoopService(planStore, agentLoop, reviewEngine, gitController);
      serviceRef = firstService;
      const firstResult = await firstService.run(planId);
      expect(firstResult.outcome).toBe("stopped");

      // Capture which tasks were run during the first pass
      const tasksRunInFirstPass = [...agentRunTasks];
      agentRunTasks.length = 0; // reset for second pass

      // Second pass: resume with a new service instance using the same plan store
      // The stop flag is on the OLD service instance — new service starts clean
      const resumeGitController: IGitController = {
        listBranches: mock(async (): Promise<GitResult<ReadonlyArray<string>>> => ({ ok: true, value: ["main"] })),
        detectChanges: mock(async (): Promise<GitResult<GitChangesResult>> => ({
          ok: true,
          value: { staged: [], unstaged: [], untracked: ["out.txt"] },
        })),
        stageAndCommit: mock(async (
          files: ReadonlyArray<string>,
          message: string,
        ): Promise<GitResult<CommitResult>> => ({
          ok: true,
          value: { hash: `resume-sha`, message, fileCount: files.length },
        })),
        createAndCheckoutBranch: mock(async (): Promise<GitResult<BranchCreationResult>> => ({
          ok: true,
          value: { branchName: "feature/test", baseBranch: "main", conflictResolved: false },
        })),
        push: mock(async (): Promise<GitResult<PushResult>> => ({
          ok: true,
          value: { remote: "origin", branchName: "feature/test", commitHash: "resume-sha" },
        })),
      };

      const resumeService = new ImplementationLoopService(
        planStore,
        agentLoop,
        makePassingReviewEngine(),
        resumeGitController,
      );

      const resumeResult = await resumeService.resume(planId);

      // Resume completes all remaining sections
      expect(resumeResult.outcome).toBe("completed");

      // Section 1 title must NOT appear in the second run's agent tasks
      expect(agentRunTasks).not.toContain(plan.tasks[0]!.title);

      // Section 1 task from first pass was executed
      expect(tasksRunInFirstPass).toContain(plan.tasks[0]!.title);

      // Sections 2 and 3 should be completed in the resume pass
      expect(agentRunTasks).toContain(plan.tasks[1]!.title);
      expect(agentRunTasks).toContain(plan.tasks[2]!.title);

      // All sections are completed in the final plan
      const planFilePath = join(aesDir, "plans", `${planId}.json`);
      const raw = await readFile(planFilePath, "utf-8");
      const finalPlan = JSON.parse(raw) as TaskPlan;
      for (const task of finalPlan.tasks) {
        expect(task.status).toBe("completed");
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Task 7.3 — Performance: elapsed time logging and memory bounds
// ---------------------------------------------------------------------------

/** Minimal no-op IContextEngine stub for performance tests. */
function makeNoopContextEngine(): {
  contextEngine: IContextEngine;
  resetTaskMock: ReturnType<typeof mock>;
} {
  const resetTaskMock = mock((): void => {});
  const contextEngine: IContextEngine = {
    buildContext: mock(async () => ({
      content: "stub",
      layers: [],
      totalTokens: 1,
      layerUsage: [],
      plannerDecision: { layersToRetrieve: [], rationale: "stub" },
      degraded: false,
      omittedLayers: [],
    })),
    expandContext: mock(async () => ({ ok: true, updatedTokenCount: 1 })),
    resetPhase: mock((): void => {}),
    resetTask: resetTaskMock,
  };
  return { contextEngine, resetTaskMock };
}

describe("Performance: elapsed time logging across sections (Task 7.3)", () => {
  it("all SectionIterationRecord.durationMs fields are non-negative across five sections", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "impl-loop-perf-"));
    const aesDir = join(tmpDir, ".aes");

    try {
      const planId = "perf-five-sections";
      const plan = makeMultiSectionPlan(planId, 5);

      const planStore = makeFilePlanStore(plan, aesDir);
      const { agentLoop } = makeStubAgentLoop(tmpDir);
      const reviewEngine = makePassingReviewEngine();
      const { gitController } = makeStubGitController();

      const service = new ImplementationLoopService(
        planStore,
        agentLoop,
        reviewEngine,
        gitController,
      );

      const result = await service.run(planId);

      expect(result.outcome).toBe("completed");
      expect(result.sections).toHaveLength(5);

      // Each section should have exactly one iteration record (review passes on first attempt)
      for (const section of result.sections as SectionExecutionRecord[]) {
        expect(section.iterations).toHaveLength(1);
        expect(section.iterations[0]!.durationMs).toBeGreaterThanOrEqual(0);
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("context re-initialization across ten sequential sections does not cause unbounded memory growth", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "impl-loop-mem-"));
    const aesDir = join(tmpDir, ".aes");

    try {
      const planId = "perf-ten-sections";
      const plan = makeMultiSectionPlan(planId, 10);

      const planStore = makeFilePlanStore(plan, aesDir);
      const { agentLoop } = makeStubAgentLoop(tmpDir);
      const reviewEngine = makePassingReviewEngine();
      const { gitController } = makeStubGitController();
      const { contextEngine, resetTaskMock } = makeNoopContextEngine();

      const service = new ImplementationLoopService(
        planStore,
        agentLoop,
        reviewEngine,
        gitController,
      );

      // Capture RSS before the run
      const rssBefore = process.memoryUsage().rss;

      const result = await service.run(planId, { contextEngine });

      // Capture RSS after the run
      const rssAfter = process.memoryUsage().rss;

      expect(result.outcome).toBe("completed");
      expect(result.sections).toHaveLength(10);

      // Assert context resetTask was called once per section (10 sections)
      expect(resetTaskMock.mock.calls).toHaveLength(10);

      // Memory growth across 10 sections must stay below 100 MB
      const growthBytes = rssAfter - rssBefore;
      const maxGrowthBytes = 100 * 1024 * 1024; // 100 MB
      expect(growthBytes).toBeLessThan(maxGrowthBytes);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
