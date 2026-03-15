/**
 * E2E tests: SelfHealingLoopService ← → ImplementationLoopService — Tasks 11.1, 11.2
 *
 * Task 11.1 — resolved path: self-healing unblocks a failed section:
 * - Connect SelfHealingLoopService to ImplementationLoopService via selfHealingLoop option
 * - Drive the loop to exhaust retry budget; assert self-healing is invoked and returns "resolved"
 * - Assert the section's retry counter resets to zero (loop continues without a second escalation)
 * - Verify the section is restarted with updatedRules paths injected into the improve prompt
 *   as additional context sources for the PLAN step
 * - Requirements: 6.1, 6.2, 6.3
 *
 * Task 11.2 — unresolved path: escalation halts the loop:
 * - Configure the mock LLM to return no actionable gap → self-healing returns "unresolved"
 * - Assert loop marks section "escalated-to-human", emits section:escalated event with
 *   SelfHealingResult.summary as reason, and halts with "human-intervention-required"
 * - Assert that after a resolved self-healing outcome the section is retried once; if that retry
 *   also fails, the loop does NOT call escalate() again but marks section "escalated-to-human"
 * - Requirements: 6.4, 7.3
 *
 * E2E scope:
 * - Real ImplementationLoopService (full orchestration logic, no internal mocking)
 * - Real SelfHealingLoopService (full self-healing workflow)
 * - In-memory MemoryPort stub
 * - Controlled mock LlmProviderPort and IAgentLoop for deterministic scenarios
 */

import { ImplementationLoopService } from "@/application/implementation-loop/implementation-loop-service";
import type { AgentLoopResult, IAgentLoop } from "@/application/ports/agent-loop";
import type { GitResult, IGitController } from "@/application/ports/git-controller";
import type {
  IImplementationLoopEventBus,
  IPlanStore,
  IReviewEngine,
  ISelfHealingLoop,
  SectionPersistenceStatus,
} from "@/application/ports/implementation-loop";
import type {
  FailureFilter,
  FailureRecord,
  MemoryEntry,
  MemoryPort,
  MemoryTarget,
  MemoryWriteResult,
  MemoryWriteTrigger,
  ShortTermMemoryPort,
} from "@/application/ports/memory";
import {
  type SelfHealingLoopConfig,
  SelfHealingLoopService,
} from "@/application/self-healing-loop/self-healing-loop-service";
import type { AgentState } from "@/domain/agent/types";
import type {
  BranchCreationResult,
  CommitResult,
  GitChangesResult,
  PushResult,
} from "@/domain/git/types";
import type {
  ImplementationLoopEvent,
  ReviewResult,
  SectionEscalation,
} from "@/domain/implementation-loop/types";
import type { Task, TaskPlan } from "@/domain/planning/types";
import { describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// In-memory MemoryPort stub — accumulates records for post-call assertion
// ---------------------------------------------------------------------------

class InMemoryMemoryPort implements MemoryPort {
  readonly shortTerm: ShortTermMemoryPort = {
    read: () => ({ recentFiles: [] }),
    write: () => {},
    clear: () => {},
  };

  readonly failureRecords: FailureRecord[] = [];
  readonly appendCalls: { target: MemoryTarget; entry: MemoryEntry; trigger: MemoryWriteTrigger }[] = [];

  async query() {
    return { entries: [] };
  }

  async append(target: MemoryTarget, entry: MemoryEntry, trigger: MemoryWriteTrigger): Promise<MemoryWriteResult> {
    this.appendCalls.push({ target, entry, trigger });
    return { ok: true as const, action: "appended" as const };
  }

  async update(): Promise<MemoryWriteResult> {
    return { ok: true as const, action: "updated" as const };
  }

  async writeFailure(record: FailureRecord): Promise<MemoryWriteResult> {
    this.failureRecords.push({ ...record });
    return { ok: true as const, action: "appended" as const };
  }

  async getFailures(filter?: FailureFilter): Promise<readonly FailureRecord[]> {
    if (!filter) return [...this.failureRecords];
    return this.failureRecords.filter(
      (r) =>
        (filter.taskId === undefined || r.taskId === filter.taskId) &&
        (filter.specName === undefined || r.specName === filter.specName),
    );
  }
}

// ---------------------------------------------------------------------------
// LLM mock helpers
// ---------------------------------------------------------------------------

const validRootCauseJson = JSON.stringify({
  attemptsNarrative: "Attempted to implement TypeScript with strict null checks",
  failureNarrative: "TypeScript compiler rejected null assertions repeatedly",
  recurringPattern: "Missing null-check guards in generated TypeScript code",
});

const validGapJson = JSON.stringify({
  targetFile: "coding_rules",
  proposedChange: "Always add null-check guards before accessing optional properties",
  rationale: "Null assertion failures recurring across all retries",
});

const noActionableGapJson = JSON.stringify({
  targetFile: null,
  proposedChange: "",
  rationale: "No actionable knowledge gap identified for this failure pattern",
});

/**
 * Two-phase LLM: first call → root-cause JSON; subsequent calls → gapContent.
 * Mirrors the pattern used in integration tests (task 10).
 */
function makeTwoPhaseLlm(gapContent: string) {
  let callCount = 0;
  return {
    complete: async () => {
      callCount++;
      const content = callCount === 1 ? validRootCauseJson : gapContent;
      return {
        ok: true as const,
        value: { content, usage: { inputTokens: 10, outputTokens: 20 } },
      };
    },
    clearContext: () => {},
  };
}

// ---------------------------------------------------------------------------
// Plan factory
// ---------------------------------------------------------------------------

function makeMinimalPlan(planId: string, sectionId = "section-1"): TaskPlan {
  return {
    id: planId,
    goal: "E2E self-healing test plan",
    tasks: [
      {
        id: sectionId,
        title: "implement feature with self-healing",
        status: "pending",
        steps: [],
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// In-memory IPlanStore — with optional status-update tracking
// ---------------------------------------------------------------------------

interface StatusUpdate {
  sectionId: string;
  status: SectionPersistenceStatus;
}

function makeInMemoryPlanStore(plan: TaskPlan): IPlanStore & { statusUpdates: StatusUpdate[] } {
  let current = plan;
  const statusUpdates: StatusUpdate[] = [];
  return {
    statusUpdates,
    async loadPlan(planId: string) {
      return planId === current.id ? current : null;
    },
    async updateSectionStatus(planId: string, sectionId: string, status: SectionPersistenceStatus) {
      statusUpdates.push({ sectionId, status });
      current = {
        ...current,
        tasks: current.tasks.map((t) =>
          t.id === sectionId ? { ...t, status: status as Task["status"] } : t,
        ),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Event bus spy — captures all emitted events for assertion
// ---------------------------------------------------------------------------

function makeEventBusSpy(): {
  eventBus: IImplementationLoopEventBus;
  events: ImplementationLoopEvent[];
} {
  const events: ImplementationLoopEvent[] = [];
  return {
    eventBus: { emit: (event: ImplementationLoopEvent) => { events.push(event); } },
    events,
  };
}

// ---------------------------------------------------------------------------
// Always-failing agent loop — never reports taskCompleted=true
// ---------------------------------------------------------------------------

function makeAlwaysFailAgentLoop(): { agentLoop: IAgentLoop; callCount: () => number } {
  let count = 0;
  const agentLoop: IAgentLoop = {
    run: mock(async (task: string): Promise<AgentLoopResult> => {
      count++;
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
      return {
        terminationCondition: "MAX_ITERATIONS_REACHED" as const,
        finalState,
        totalIterations: 1,
        taskCompleted: false,
      };
    }),
    stop: mock((): void => {}),
    getState: mock((): Readonly<AgentState> | null => null),
  };
  return { agentLoop, callCount: () => count };
}

// ---------------------------------------------------------------------------
// Agent loop factory — fails `failCount` times then succeeds; captures call args
// ---------------------------------------------------------------------------

function makeFailThenSucceedAgentLoop(failCount: number): {
  agentLoop: IAgentLoop;
  callArgs: string[];
} {
  const callArgs: string[] = [];
  let callIndex = 0;

  const agentLoop: IAgentLoop = {
    run: mock(async (task: string): Promise<AgentLoopResult> => {
      callArgs.push(task);
      callIndex++;

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

      if (callIndex <= failCount) {
        return {
          terminationCondition: "MAX_ITERATIONS_REACHED" as const,
          finalState,
          totalIterations: 1,
          taskCompleted: false,
        };
      }

      return {
        terminationCondition: "TASK_COMPLETED" as const,
        finalState,
        totalIterations: 1,
        taskCompleted: true,
      };
    }),
    stop: mock((): void => {}),
    getState: mock((): Readonly<AgentState> | null => null),
  };

  return { agentLoop, callArgs };
}

// ---------------------------------------------------------------------------
// Review engine — always passes
// ---------------------------------------------------------------------------

function makePassingReviewEngine(): IReviewEngine {
  return {
    review: mock(async (): Promise<ReviewResult> => ({
      outcome: "passed",
      checks: [{ checkName: "all-checks", outcome: "passed", required: true, details: "OK" }],
      feedback: [],
      durationMs: 1,
    })),
  };
}

// ---------------------------------------------------------------------------
// Git controller stub
// ---------------------------------------------------------------------------

function makeStubGitController(): { gitController: IGitController; commits: string[] } {
  const commits: string[] = [];
  const gitController: IGitController = {
    listBranches: mock(async (): Promise<GitResult<ReadonlyArray<string>>> => ({
      ok: true,
      value: ["main"],
    })),
    detectChanges: mock(async (): Promise<GitResult<GitChangesResult>> => ({
      ok: true,
      value: { staged: [], unstaged: [], untracked: ["output.txt"] },
    })),
    stageAndCommit: mock(async (
      _files: ReadonlyArray<string>,
      message: string,
    ): Promise<GitResult<CommitResult>> => {
      commits.push(message);
      return { ok: true, value: { hash: "abc1234", message, fileCount: 1 } };
    }),
    createAndCheckoutBranch: mock(async (): Promise<GitResult<BranchCreationResult>> => ({
      ok: true,
      value: { branchName: "feature/test", baseBranch: "main", conflictResolved: false },
    })),
    push: mock(async (): Promise<GitResult<PushResult>> => ({
      ok: true,
      value: { remote: "origin", branchName: "feature/test", commitHash: "abc1234" },
    })),
  };
  return { gitController, commits };
}

// ---------------------------------------------------------------------------
// Spy wrapper: wraps ISelfHealingLoop.escalate() to count invocations
// ---------------------------------------------------------------------------

function spyOnEscalate(svc: SelfHealingLoopService): {
  spy: ISelfHealingLoop;
  escalateCallCount: () => number;
  lastEscalation: () => SectionEscalation | null;
} {
  let count = 0;
  let last: SectionEscalation | null = null;
  return {
    spy: {
      escalate: async (escalation: SectionEscalation) => {
        count++;
        last = escalation;
        return svc.escalate(escalation);
      },
    },
    escalateCallCount: () => count,
    lastEscalation: () => last,
  };
}

// ---------------------------------------------------------------------------
// Shared self-healing config
// ---------------------------------------------------------------------------

const selfHealingConfig: SelfHealingLoopConfig = {
  workspaceRoot: "/workspace",
  selfHealingTimeoutMs: 10_000,
  analysisTimeoutMs: 5_000,
  maxAnalysisRetries: 1,
  maxRecordSizeBytes: 65_536,
};

// ---------------------------------------------------------------------------
// Task 11.1: E2E resolved path — self-healing unblocks a failed section
// ---------------------------------------------------------------------------

describe("E2E: self-healing resolved path — task 11.1", () => {
  it("returns outcome: 'completed' when self-healing resolves after retry budget is exhausted", async () => {
    // Arrange: maxRetriesPerSection=1; agent fails once then succeeds after healing
    const planId = "e2e-shl-resolved";
    const plan = makeMinimalPlan(planId);
    const planStore = makeInMemoryPlanStore(plan);
    const { agentLoop } = makeFailThenSucceedAgentLoop(1);
    const reviewEngine = makePassingReviewEngine();
    const { gitController } = makeStubGitController();

    const memory = new InMemoryMemoryPort();
    const healingService = new SelfHealingLoopService(
      makeTwoPhaseLlm(validGapJson),
      memory,
      selfHealingConfig,
    );

    const service = new ImplementationLoopService(planStore, agentLoop, reviewEngine, gitController);

    // Act
    const result = await service.run(planId, {
      maxRetriesPerSection: 1,
      selfHealingLoop: healingService,
    });

    // Assert: loop recovered and completed
    expect(result.outcome).toBe("completed");
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.status).toBe("completed");
  });

  it("escalate() is invoked exactly once when the retry budget is exhausted", async () => {
    const planId = "e2e-shl-escalate-invoked";
    const plan = makeMinimalPlan(planId);
    const planStore = makeInMemoryPlanStore(plan);
    const { agentLoop } = makeFailThenSucceedAgentLoop(1);
    const reviewEngine = makePassingReviewEngine();
    const { gitController } = makeStubGitController();

    const memory = new InMemoryMemoryPort();
    const healingService = new SelfHealingLoopService(
      makeTwoPhaseLlm(validGapJson),
      memory,
      selfHealingConfig,
    );
    const { spy, escalateCallCount } = spyOnEscalate(healingService);

    const service = new ImplementationLoopService(planStore, agentLoop, reviewEngine, gitController);

    await service.run(planId, { maxRetriesPerSection: 1, selfHealingLoop: spy });

    expect(escalateCallCount()).toBe(1);
  });

  it("escalation payload contains the section's retryHistory and planId", async () => {
    const planId = "e2e-shl-escalation-payload";
    const sectionId = "section-1";
    const plan = makeMinimalPlan(planId, sectionId);
    const planStore = makeInMemoryPlanStore(plan);
    const { agentLoop } = makeFailThenSucceedAgentLoop(1);
    const reviewEngine = makePassingReviewEngine();
    const { gitController } = makeStubGitController();

    const memory = new InMemoryMemoryPort();
    const healingService = new SelfHealingLoopService(
      makeTwoPhaseLlm(validGapJson),
      memory,
      selfHealingConfig,
    );
    const { spy, lastEscalation } = spyOnEscalate(healingService);

    const service = new ImplementationLoopService(planStore, agentLoop, reviewEngine, gitController);

    await service.run(planId, { maxRetriesPerSection: 1, selfHealingLoop: spy });

    const escalation = lastEscalation();
    expect(escalation).not.toBeNull();
    expect(escalation!.sectionId).toBe(sectionId);
    expect(escalation!.planId).toBe(planId);
    // retryHistory must be non-empty (one failed iteration was accumulated before escalation)
    expect(escalation!.retryHistory.length).toBeGreaterThanOrEqual(1);
  });

  it("section retry counter resets to zero after healing: loop completes without a second escalation", async () => {
    // Arrange: maxRetriesPerSection=2; agent fails twice (exhausts budget) → healing resolves
    // → retryCount reset to 0 → agent fails once more (within reset budget) → agent succeeds.
    // If retryCount was NOT reset, the 3rd failure would trigger a second escalation.
    const planId = "e2e-shl-retry-reset";
    const plan = makeMinimalPlan(planId);
    const planStore = makeInMemoryPlanStore(plan);
    // Fail 3 times total: 2 to exhaust budget + 1 after reset (within budget) + then succeed
    const { agentLoop, callArgs } = makeFailThenSucceedAgentLoop(3);
    const reviewEngine = makePassingReviewEngine();
    const { gitController } = makeStubGitController();

    const memory = new InMemoryMemoryPort();
    const healingService = new SelfHealingLoopService(
      makeTwoPhaseLlm(validGapJson),
      memory,
      selfHealingConfig,
    );
    const { spy, escalateCallCount } = spyOnEscalate(healingService);

    const service = new ImplementationLoopService(planStore, agentLoop, reviewEngine, gitController);

    const result = await service.run(planId, { maxRetriesPerSection: 2, selfHealingLoop: spy });

    // Healing was called exactly once: the 1 extra failure after reset stayed within budget
    expect(escalateCallCount()).toBe(1);
    // Loop ultimately recovered and completed the section
    expect(result.outcome).toBe("completed");
    // Agents: 2 fail (→ escalate) + 1 fail (within reset budget) + 1 success = 4 total
    expect(callArgs.length).toBe(4);
  });

  it("section is restarted with updatedRules paths injected into the improve prompt (PLAN context)", async () => {
    // This verifies requirement 6.3: updatedRules are passed as additional context
    // for the PLAN step by appearing in the improve prompt the agent receives.
    const planId = "e2e-shl-rules-injected";
    const plan = makeMinimalPlan(planId);
    const planStore = makeInMemoryPlanStore(plan);
    // Agent: fails once (maxRetries=1 → escalate → healing resolves) then succeeds
    const { agentLoop, callArgs } = makeFailThenSucceedAgentLoop(1);
    const reviewEngine = makePassingReviewEngine();
    const { gitController } = makeStubGitController();

    const memory = new InMemoryMemoryPort();
    const healingService = new SelfHealingLoopService(
      makeTwoPhaseLlm(validGapJson),
      memory,
      selfHealingConfig,
    );

    const service = new ImplementationLoopService(planStore, agentLoop, reviewEngine, gitController);

    const result = await service.run(planId, {
      maxRetriesPerSection: 1,
      selfHealingLoop: healingService,
    });

    expect(result.outcome).toBe("completed");

    // Two agent calls: first with original task title, second with the healed improve prompt
    expect(callArgs.length).toBe(2);

    const healedPrompt = callArgs[1]!;

    // The healed prompt instructs the agent to retry the section
    expect(healedPrompt).toContain("Retry the implementation of:");

    // The healed prompt includes the workspace-relative path of the updated rule file
    // (requirement 6.3: updatedRules injected as additional context sources)
    expect(healedPrompt).toContain(".kiro/steering/coding_rules.md");
  });

  it("failure record is persisted for the section even when self-healing resolves successfully", async () => {
    // Requirement 5.2: writeFailure() must be called on every escalate() invocation
    const planId = "e2e-shl-failure-record";
    const sectionId = "section-1";
    const plan = makeMinimalPlan(planId, sectionId);
    const planStore = makeInMemoryPlanStore(plan);
    const { agentLoop } = makeFailThenSucceedAgentLoop(1);
    const reviewEngine = makePassingReviewEngine();
    const { gitController } = makeStubGitController();

    const memory = new InMemoryMemoryPort();
    const healingService = new SelfHealingLoopService(
      makeTwoPhaseLlm(validGapJson),
      memory,
      selfHealingConfig,
    );

    const service = new ImplementationLoopService(planStore, agentLoop, reviewEngine, gitController);

    await service.run(planId, { maxRetriesPerSection: 1, selfHealingLoop: healingService });

    const records = await memory.getFailures({ taskId: sectionId });
    expect(records.length).toBe(1);
    expect(records[0]!.taskId).toBe(sectionId);
    expect(records[0]!.specName).toBe(planId);
    expect(records[0]!.phase).toBe("IMPLEMENTATION");
  });

  it("MemoryPort.append is called once for the rule file update on a resolved escalation", async () => {
    // Requirement 6.1: the resolved path writes the proposed change to the target rule file
    const planId = "e2e-shl-append-call";
    const plan = makeMinimalPlan(planId);
    const planStore = makeInMemoryPlanStore(plan);
    const { agentLoop } = makeFailThenSucceedAgentLoop(1);
    const reviewEngine = makePassingReviewEngine();
    const { gitController } = makeStubGitController();

    const memory = new InMemoryMemoryPort();
    const healingService = new SelfHealingLoopService(
      makeTwoPhaseLlm(validGapJson),
      memory,
      selfHealingConfig,
    );

    const service = new ImplementationLoopService(planStore, agentLoop, reviewEngine, gitController);

    await service.run(planId, { maxRetriesPerSection: 1, selfHealingLoop: healingService });

    // The rule file update path must call MemoryPort.append exactly once
    expect(memory.appendCalls.length).toBe(1);
    expect(memory.appendCalls[0]!.target).toEqual({ type: "knowledge", file: "coding_rules" });
    expect(memory.appendCalls[0]!.trigger).toBe("self_healing");
  });
});

// ---------------------------------------------------------------------------
// Task 11.2: E2E unresolved path — escalation halts the loop
// ---------------------------------------------------------------------------

describe("E2E: self-healing unresolved path — task 11.2", () => {
  it("returns outcome: 'human-intervention-required' when self-healing returns unresolved", async () => {
    // LLM returns no actionable gap → SelfHealingLoopService returns "unresolved"
    const planId = "e2e-shl-unresolved";
    const plan = makeMinimalPlan(planId);
    const planStore = makeInMemoryPlanStore(plan);
    const { agentLoop } = makeAlwaysFailAgentLoop();
    const reviewEngine = makePassingReviewEngine();
    const { gitController } = makeStubGitController();

    const memory = new InMemoryMemoryPort();
    const healingService = new SelfHealingLoopService(
      makeTwoPhaseLlm(noActionableGapJson),
      memory,
      selfHealingConfig,
    );

    const service = new ImplementationLoopService(planStore, agentLoop, reviewEngine, gitController);

    const result = await service.run(planId, {
      maxRetriesPerSection: 1,
      selfHealingLoop: healingService,
    });

    expect(result.outcome).toBe("human-intervention-required");
  });

  it("marks section as 'escalated-to-human' when self-healing returns unresolved", async () => {
    const planId = "e2e-shl-unresolved-status";
    const sectionId = "section-1";
    const plan = makeMinimalPlan(planId, sectionId);
    const planStore = makeInMemoryPlanStore(plan);
    const { agentLoop } = makeAlwaysFailAgentLoop();
    const reviewEngine = makePassingReviewEngine();
    const { gitController } = makeStubGitController();

    const memory = new InMemoryMemoryPort();
    const healingService = new SelfHealingLoopService(
      makeTwoPhaseLlm(noActionableGapJson),
      memory,
      selfHealingConfig,
    );

    const service = new ImplementationLoopService(planStore, agentLoop, reviewEngine, gitController);

    await service.run(planId, {
      maxRetriesPerSection: 1,
      selfHealingLoop: healingService,
    });

    const escalatedUpdate = planStore.statusUpdates.find(
      (u) => u.sectionId === sectionId && u.status === "escalated-to-human",
    );
    expect(escalatedUpdate).toBeDefined();
  });

  it("emits a section:escalated event when self-healing returns unresolved", async () => {
    const planId = "e2e-shl-unresolved-event";
    const plan = makeMinimalPlan(planId);
    const planStore = makeInMemoryPlanStore(plan);
    const { agentLoop } = makeAlwaysFailAgentLoop();
    const reviewEngine = makePassingReviewEngine();
    const { gitController } = makeStubGitController();
    const { eventBus, events } = makeEventBusSpy();

    const memory = new InMemoryMemoryPort();
    const healingService = new SelfHealingLoopService(
      makeTwoPhaseLlm(noActionableGapJson),
      memory,
      selfHealingConfig,
    );

    const service = new ImplementationLoopService(planStore, agentLoop, reviewEngine, gitController);

    await service.run(planId, {
      maxRetriesPerSection: 1,
      selfHealingLoop: healingService,
      eventBus,
    });

    const escalatedEvent = events.find((e) => e.type === "section:escalated");
    expect(escalatedEvent).toBeDefined();
  });

  it("section:escalated event reason includes the SelfHealingResult.summary (requirement 7.3)", async () => {
    // Requirement 7.3: the implementation loop shall include the summary from SelfHealingResult
    // as the reason field of the section:escalated event.
    const planId = "e2e-shl-unresolved-reason";
    const plan = makeMinimalPlan(planId);
    const planStore = makeInMemoryPlanStore(plan);
    const { agentLoop } = makeAlwaysFailAgentLoop();
    const reviewEngine = makePassingReviewEngine();
    const { gitController } = makeStubGitController();
    const { eventBus, events } = makeEventBusSpy();

    const memory = new InMemoryMemoryPort();
    const healingService = new SelfHealingLoopService(
      makeTwoPhaseLlm(noActionableGapJson),
      memory,
      selfHealingConfig,
    );

    // Spy to capture the actual SelfHealingResult returned by escalate()
    let capturedHealingSummary: string | null = null;
    const spiedHealingService: ISelfHealingLoop = {
      escalate: async (escalation: SectionEscalation) => {
        const result = await healingService.escalate(escalation);
        capturedHealingSummary = result.summary;
        return result;
      },
    };

    const service = new ImplementationLoopService(planStore, agentLoop, reviewEngine, gitController);

    await service.run(planId, {
      maxRetriesPerSection: 1,
      selfHealingLoop: spiedHealingService,
      eventBus,
    });

    expect(capturedHealingSummary).not.toBeNull();

    const escalatedEvent = events.find((e) => e.type === "section:escalated");
    expect(escalatedEvent).toBeDefined();
    if (escalatedEvent?.type === "section:escalated") {
      // The event reason must include the actual SelfHealingResult.summary
      expect(escalatedEvent.reason).toContain(capturedHealingSummary!);
    }
  });
});

// ---------------------------------------------------------------------------
// Task 11.2: E2E re-escalation guard — no second self-healing call after resolved healing
// ---------------------------------------------------------------------------

describe("E2E: self-healing re-escalation guard — task 11.2", () => {
  it("does NOT call escalate() a second time when retry after healing also fails (requirement 6.4)", async () => {
    // Requirement 6.4: if the retried section fails again after a "resolved" outcome,
    // the loop shall NOT call ISelfHealingLoop.escalate() again.
    const planId = "e2e-shl-no-re-escalate";
    const plan = makeMinimalPlan(planId);
    const planStore = makeInMemoryPlanStore(plan);
    // Agent always fails — after healing resolves, the retry also fails
    const { agentLoop } = makeAlwaysFailAgentLoop();
    const reviewEngine = makePassingReviewEngine();
    const { gitController } = makeStubGitController();

    const memory = new InMemoryMemoryPort();
    // First healing call will resolve (returns validGapJson)
    const healingService = new SelfHealingLoopService(
      makeTwoPhaseLlm(validGapJson),
      memory,
      selfHealingConfig,
    );
    const { spy, escalateCallCount } = spyOnEscalate(healingService);

    const service = new ImplementationLoopService(planStore, agentLoop, reviewEngine, gitController);

    await service.run(planId, {
      maxRetriesPerSection: 1,
      selfHealingLoop: spy,
    });

    // escalate() must be called exactly once: the second budget exhaustion must NOT re-escalate
    expect(escalateCallCount()).toBe(1);
  });

  it("marks section as 'escalated-to-human' when retry after healing also fails (requirement 6.4)", async () => {
    const planId = "e2e-shl-re-fail-status";
    const sectionId = "section-1";
    const plan = makeMinimalPlan(planId, sectionId);
    const planStore = makeInMemoryPlanStore(plan);
    const { agentLoop } = makeAlwaysFailAgentLoop();
    const reviewEngine = makePassingReviewEngine();
    const { gitController } = makeStubGitController();

    const memory = new InMemoryMemoryPort();
    const healingService = new SelfHealingLoopService(
      makeTwoPhaseLlm(validGapJson),
      memory,
      selfHealingConfig,
    );
    const { spy } = spyOnEscalate(healingService);

    const service = new ImplementationLoopService(planStore, agentLoop, reviewEngine, gitController);

    await service.run(planId, {
      maxRetriesPerSection: 1,
      selfHealingLoop: spy,
    });

    // Section must be "escalated-to-human" (not "failed") when healing was involved
    const escalatedUpdate = planStore.statusUpdates.find(
      (u) => u.sectionId === sectionId && u.status === "escalated-to-human",
    );
    expect(escalatedUpdate).toBeDefined();
  });

  it("returns 'human-intervention-required' when retry after healing also fails (requirement 6.4)", async () => {
    const planId = "e2e-shl-re-fail-outcome";
    const plan = makeMinimalPlan(planId);
    const planStore = makeInMemoryPlanStore(plan);
    const { agentLoop } = makeAlwaysFailAgentLoop();
    const reviewEngine = makePassingReviewEngine();
    const { gitController } = makeStubGitController();

    const memory = new InMemoryMemoryPort();
    const healingService = new SelfHealingLoopService(
      makeTwoPhaseLlm(validGapJson),
      memory,
      selfHealingConfig,
    );
    const { spy } = spyOnEscalate(healingService);

    const service = new ImplementationLoopService(planStore, agentLoop, reviewEngine, gitController);

    const result = await service.run(planId, {
      maxRetriesPerSection: 1,
      selfHealingLoop: spy,
    });

    expect(result.outcome).toBe("human-intervention-required");
  });
});

// ---------------------------------------------------------------------------
// Task 11.3: E2E unexpected-throw regression — spec9 catch path
// ---------------------------------------------------------------------------

describe("E2E: self-healing unexpected throw regression — task 11.3", () => {
  it("does not propagate a throw from escalate() to the caller", async () => {
    // Requirement 1.1: escalate() must never throw on any code path.
    // ImplementationLoopService must catch the exception and not propagate it.
    const planId = "e2e-shl-throw-no-propagate";
    const plan = makeMinimalPlan(planId);
    const planStore = makeInMemoryPlanStore(plan);
    const { agentLoop } = makeAlwaysFailAgentLoop();
    const reviewEngine = makePassingReviewEngine();
    const { gitController } = makeStubGitController();

    // Self-healing service that throws unconditionally
    const throwingHealingLoop: ISelfHealingLoop = {
      escalate: async () => {
        throw new Error("Unexpected internal error from self-healing loop");
      },
    };

    const service = new ImplementationLoopService(planStore, agentLoop, reviewEngine, gitController);

    // Must resolve without throwing
    await expect(
      service.run(planId, { maxRetriesPerSection: 1, selfHealingLoop: throwingHealingLoop }),
    ).resolves.toBeDefined();
  });

  it("marks section as 'failed' when escalate() throws unexpectedly", async () => {
    // Requirement 1.1: the catch path should mark the section "failed", not leave it in a bad state.
    const planId = "e2e-shl-throw-failed-status";
    const sectionId = "section-1";
    const plan = makeMinimalPlan(planId, sectionId);
    const planStore = makeInMemoryPlanStore(plan);
    const { agentLoop } = makeAlwaysFailAgentLoop();
    const reviewEngine = makePassingReviewEngine();
    const { gitController } = makeStubGitController();

    const throwingHealingLoop: ISelfHealingLoop = {
      escalate: async () => {
        throw new Error("Unexpected internal error from self-healing loop");
      },
    };

    const service = new ImplementationLoopService(planStore, agentLoop, reviewEngine, gitController);

    await service.run(planId, { maxRetriesPerSection: 1, selfHealingLoop: throwingHealingLoop });

    // Section must be marked "failed" (not "escalated-to-human"), per the spec9 catch path
    const failedUpdate = planStore.statusUpdates.find(
      (u) => u.sectionId === sectionId && u.status === "failed",
    );
    expect(failedUpdate).toBeDefined();
  });

  it("returns 'section-failed' when escalate() throws unexpectedly", async () => {
    // The outer loop outcome reflects the section could not be completed.
    // Because the throw path marks status "failed" (not "escalated-to-human"), the outcome
    // is "section-failed" (not "human-intervention-required").
    const planId = "e2e-shl-throw-outcome";
    const plan = makeMinimalPlan(planId);
    const planStore = makeInMemoryPlanStore(plan);
    const { agentLoop } = makeAlwaysFailAgentLoop();
    const reviewEngine = makePassingReviewEngine();
    const { gitController } = makeStubGitController();

    const throwingHealingLoop: ISelfHealingLoop = {
      escalate: async () => {
        throw new Error("Unexpected internal error from self-healing loop");
      },
    };

    const service = new ImplementationLoopService(planStore, agentLoop, reviewEngine, gitController);

    const result = await service.run(planId, {
      maxRetriesPerSection: 1,
      selfHealingLoop: throwingHealingLoop,
    });

    // The catch path sets status "failed", so the outcome is "section-failed"
    expect(result.outcome).toBe("section-failed");
  });

  it("does not lose existing section records when escalate() throws", async () => {
    // Regression: exception in escalation must not corrupt the loop's result structure.
    const planId = "e2e-shl-throw-records";
    const sectionId = "section-1";
    const plan = makeMinimalPlan(planId, sectionId);
    const planStore = makeInMemoryPlanStore(plan);
    const { agentLoop } = makeAlwaysFailAgentLoop();
    const reviewEngine = makePassingReviewEngine();
    const { gitController } = makeStubGitController();

    const throwingHealingLoop: ISelfHealingLoop = {
      escalate: async () => {
        throw new Error("Unexpected internal error from self-healing loop");
      },
    };

    const service = new ImplementationLoopService(planStore, agentLoop, reviewEngine, gitController);

    const result = await service.run(planId, {
      maxRetriesPerSection: 1,
      selfHealingLoop: throwingHealingLoop,
    });

    // Result must include exactly one section record for the attempted section
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.sectionId).toBe(sectionId);
  });
});
