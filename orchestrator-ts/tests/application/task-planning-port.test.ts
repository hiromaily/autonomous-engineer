import { describe, expect, it } from "bun:test";
import type {
  IHumanReviewGateway,
  IPlanContextBuilder,
  IPlanEventBus,
  ITaskPlanner,
  ITaskPlanStore,
  PlanReviewDecision,
  TaskPlannerLogger,
  TaskPlannerOptions,
  TaskPlanOutcome,
  TaskPlanResult,
} from "../../src/application/ports/task-planning";
import type { PlanEvent, PlanReviewReason, TaskPlan } from "../../src/domain/planning/types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePlan(overrides: Partial<TaskPlan> = {}): TaskPlan {
  return {
    id: "plan-1",
    goal: "Implement the feature",
    tasks: [],
    createdAt: "2026-03-13T00:00:00.000Z",
    updatedAt: "2026-03-13T00:00:00.000Z",
    ...overrides,
  };
}

function makePlanner(overrides: Partial<ITaskPlanner> = {}): ITaskPlanner {
  return {
    async run(): Promise<TaskPlanResult> {
      return { outcome: "completed", plan: makePlan() };
    },
    async resume(): Promise<TaskPlanResult> {
      return { outcome: "completed", plan: makePlan() };
    },
    async listResumable(): Promise<ReadonlyArray<string>> {
      return [];
    },
    stop(): void {},
    ...overrides,
  };
}

function makeEventBus(): { bus: IPlanEventBus; handlers: ((event: PlanEvent) => void)[] } {
  const handlers: ((event: PlanEvent) => void)[] = [];
  const bus: IPlanEventBus = {
    emit(event: PlanEvent): void {
      for (const handler of handlers) handler(event);
    },
    on(handler: (event: PlanEvent) => void): void {
      handlers.push(handler);
    },
    off(handler: (event: PlanEvent) => void): void {
      const idx = handlers.indexOf(handler);
      if (idx !== -1) handlers.splice(idx, 1);
    },
  };
  return { bus, handlers };
}

// ---------------------------------------------------------------------------
// TaskPlannerOptions shape
// ---------------------------------------------------------------------------

describe("TaskPlannerOptions shape", () => {
  it("accepts an options object with all required fields", () => {
    const options: TaskPlannerOptions = {
      maxStepRetries: 3,
      maxAutoApproveSteps: 10,
      skipHumanReview: false,
    };

    expect(options.maxStepRetries).toBe(3);
    expect(options.maxAutoApproveSteps).toBe(10);
    expect(options.skipHumanReview).toBe(false);
    expect(options.agentLoopOptions).toBeUndefined();
    expect(options.eventBus).toBeUndefined();
    expect(options.logger).toBeUndefined();
  });

  it("accepts skipHumanReview: true to bypass the gate", () => {
    const options: TaskPlannerOptions = {
      maxStepRetries: 1,
      maxAutoApproveSteps: 10,
      skipHumanReview: true,
    };

    expect(options.skipHumanReview).toBe(true);
  });

  it("accepts optional agentLoopOptions, eventBus, and logger fields", () => {
    const logger: TaskPlannerLogger = {
      info: (_msg, _data) => {},
      error: (_msg, _data) => {},
    };

    const options: TaskPlannerOptions = {
      maxStepRetries: 3,
      maxAutoApproveSteps: 10,
      skipHumanReview: false,
      agentLoopOptions: { maxIterations: 20 },
      logger,
    };

    expect(options.agentLoopOptions?.maxIterations).toBe(20);
    expect(options.logger).toBe(logger);
  });
});

// ---------------------------------------------------------------------------
// TaskPlanOutcome — all six variants
// ---------------------------------------------------------------------------

describe("TaskPlanOutcome type", () => {
  it("accepts all six outcome variants", () => {
    const outcomes: TaskPlanOutcome[] = [
      "completed",
      "escalated",
      "validation-error",
      "human-rejected",
      "waiting-for-input",
      "dependency-unavailable",
    ];

    expect(outcomes).toHaveLength(6);
    expect(outcomes).toContain("completed");
    expect(outcomes).toContain("escalated");
    expect(outcomes).toContain("validation-error");
    expect(outcomes).toContain("human-rejected");
    expect(outcomes).toContain("waiting-for-input");
    expect(outcomes).toContain("dependency-unavailable");
  });
});

// ---------------------------------------------------------------------------
// TaskPlanResult shape
// ---------------------------------------------------------------------------

describe("TaskPlanResult shape", () => {
  it("accepts a completed result with plan and no optional fields", () => {
    const plan = makePlan();

    const result: TaskPlanResult = { outcome: "completed", plan };

    expect(result.outcome).toBe("completed");
    expect(result.plan.id).toBe("plan-1");
    expect(result.failedStepId).toBeUndefined();
    expect(result.escalationContext).toBeUndefined();
  });

  it("accepts an escalated result with failedStepId and escalationContext", () => {
    const plan = makePlan();

    const result: TaskPlanResult = {
      outcome: "escalated",
      plan,
      failedStepId: "step-42",
      escalationContext: "Agent loop exhausted all retries for step-42",
    };

    expect(result.outcome).toBe("escalated");
    expect(result.failedStepId).toBe("step-42");
    expect(result.escalationContext).toContain("step-42");
  });

  it("accepts a waiting-for-input result with plan and no step info", () => {
    const plan = makePlan({ id: "plan-waiting" });

    const result: TaskPlanResult = { outcome: "waiting-for-input", plan };

    expect(result.outcome).toBe("waiting-for-input");
    expect(result.plan.id).toBe("plan-waiting");
  });
});

// ---------------------------------------------------------------------------
// ITaskPlanner contract via mock
// ---------------------------------------------------------------------------

describe("ITaskPlanner contract (mock implementation)", () => {
  it("run() returns a TaskPlanResult without throwing", async () => {
    const plan = makePlan();
    const planner = makePlanner({
      async run() {
        return { outcome: "completed", plan };
      },
    });

    const result = await planner.run("Implement the feature");
    expect(result.outcome).toBe("completed");
    expect(result.plan.id).toBe("plan-1");
  });

  it("resume() returns a TaskPlanResult for the given planId", async () => {
    const planner = makePlanner({
      async resume(planId) {
        return { outcome: "completed", plan: makePlan({ id: planId }) };
      },
      async listResumable() {
        return ["plan-resumed"];
      },
    });

    const result = await planner.resume("plan-resumed");
    expect(result.outcome).toBe("completed");
    expect(result.plan.id).toBe("plan-resumed");
  });

  it("listResumable() returns an array of plan IDs", async () => {
    const planner = makePlanner({
      async listResumable() {
        return ["plan-a", "plan-b"];
      },
    });

    const ids = await planner.listResumable();
    expect(ids).toHaveLength(2);
    expect(ids).toContain("plan-a");
    expect(ids).toContain("plan-b");
  });

  it("stop() can be called without arguments", () => {
    let stopped = false;
    const planner = makePlanner({
      stop() {
        stopped = true;
      },
    });

    planner.stop();
    expect(stopped).toBe(true);
  });

  it("run() returns dependency-unavailable when a dependency is missing", async () => {
    const plan = makePlan();
    const planner = makePlanner({
      async run() {
        return { outcome: "dependency-unavailable", plan, escalationContext: "Missing: IAgentLoop" };
      },
    });

    const result = await planner.run("goal");
    expect(result.outcome).toBe("dependency-unavailable");
    expect(result.escalationContext).toContain("IAgentLoop");
  });
});

// ---------------------------------------------------------------------------
// ITaskPlanStore contract via mock
// ---------------------------------------------------------------------------

describe("ITaskPlanStore contract (mock implementation)", () => {
  it("save() persists a plan and load() retrieves it", async () => {
    const stored = new Map<string, TaskPlan>();

    const store: ITaskPlanStore = {
      async save(plan) {
        stored.set(plan.id, plan);
      },
      async load(planId) {
        return stored.get(planId) ?? null;
      },
      async listResumable() {
        return [...stored.keys()];
      },
    };

    const plan = makePlan({ id: "plan-stored" });
    await store.save(plan);
    const loaded = await store.load("plan-stored");
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe("plan-stored");
  });

  it("load() returns null when the plan does not exist", async () => {
    const store: ITaskPlanStore = {
      async save() {},
      async load() {
        return null;
      },
      async listResumable() {
        return [];
      },
    };

    const result = await store.load("non-existent");
    expect(result).toBeNull();
  });

  it("listResumable() returns IDs of plans with incomplete tasks", async () => {
    const store: ITaskPlanStore = {
      async save() {},
      async load() {
        return null;
      },
      async listResumable() {
        return ["plan-in-progress"];
      },
    };

    const ids = await store.listResumable();
    expect(ids).toContain("plan-in-progress");
  });
});

// ---------------------------------------------------------------------------
// IPlanContextBuilder contract via mock
// ---------------------------------------------------------------------------

describe("IPlanContextBuilder contract (mock implementation)", () => {
  it("buildPlanContext() returns a prompt string for the goal", async () => {
    const builder: IPlanContextBuilder = {
      async buildPlanContext(goal) {
        return `Generate a task plan for: ${goal}`;
      },
      async buildRevisionContext() {
        return "";
      },
    };

    const prompt = await builder.buildPlanContext("Add authentication system");
    expect(prompt).toContain("Add authentication system");
  });

  it("buildPlanContext() accepts optional repositoryContext", async () => {
    const builder: IPlanContextBuilder = {
      async buildPlanContext(goal, repoContext) {
        return `${goal}\n${repoContext ?? ""}`;
      },
      async buildRevisionContext() {
        return "";
      },
    };

    const prompt = await builder.buildPlanContext("goal", "TypeScript monorepo");
    expect(prompt).toContain("TypeScript monorepo");
  });

  it("buildRevisionContext() receives plan, failedStepId, and failure summary", async () => {
    const plan = makePlan({ id: "plan-revision" });

    const builder: IPlanContextBuilder = {
      async buildPlanContext() {
        return "";
      },
      async buildRevisionContext(p, failedStepId, summary) {
        return `Revise plan ${p.id}: step ${failedStepId} failed — ${summary}`;
      },
    };

    const prompt = await builder.buildRevisionContext(plan, "step-7", "tool execution timed out");
    expect(prompt).toContain("plan-revision");
    expect(prompt).toContain("step-7");
    expect(prompt).toContain("tool execution timed out");
  });
});

// ---------------------------------------------------------------------------
// IHumanReviewGateway contract via mock
// ---------------------------------------------------------------------------

describe("IHumanReviewGateway contract (mock implementation)", () => {
  it("reviewPlan() returns approved: true when the reviewer accepts", async () => {
    const gateway: IHumanReviewGateway = {
      async reviewPlan(): Promise<PlanReviewDecision> {
        return { approved: true };
      },
    };

    const decision = await gateway.reviewPlan(makePlan(), "large-plan", 30_000);
    expect(decision.approved).toBe(true);
  });

  it("reviewPlan() returns approved: false with feedback when the reviewer rejects", async () => {
    const gateway: IHumanReviewGateway = {
      async reviewPlan(): Promise<PlanReviewDecision> {
        return { approved: false, feedback: "Step 3 is too risky — please break it into smaller steps" };
      },
    };

    const decision = await gateway.reviewPlan(makePlan(), "high-risk-operations", 30_000);
    expect(decision.approved).toBe(false);
    if (!decision.approved) {
      expect(decision.feedback).toContain("too risky");
    }
  });

  it("reviewPlan() receives the correct PlanReviewReason variants", async () => {
    const reasons: PlanReviewReason[] = [];

    const gateway: IHumanReviewGateway = {
      async reviewPlan(_plan, reason): Promise<PlanReviewDecision> {
        reasons.push(reason);
        return { approved: true };
      },
    };

    const plan = makePlan();
    await gateway.reviewPlan(plan, "large-plan", 30_000);
    await gateway.reviewPlan(plan, "high-risk-operations", 30_000);

    expect(reasons).toHaveLength(2);
    expect(reasons).toContain("large-plan");
    expect(reasons).toContain("high-risk-operations");
  });
});

// ---------------------------------------------------------------------------
// IPlanEventBus contract via mock
// ---------------------------------------------------------------------------

describe("IPlanEventBus contract (mock implementation)", () => {
  it("emit() delivers the event to registered on() handlers", () => {
    const { bus } = makeEventBus();
    const received: PlanEvent[] = [];

    bus.on((e) => received.push(e));
    bus.emit({ type: "plan:created", planId: "plan-1", goal: "Build feature", timestamp: "2026-03-13T00:00:00.000Z" });

    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe("plan:created");
  });

  it("off() removes a handler so it no longer receives events", () => {
    const { bus } = makeEventBus();
    const received: PlanEvent[] = [];

    const handler = (e: PlanEvent): void => {
      received.push(e);
    };
    bus.on(handler);

    bus.emit({
      type: "step:start",
      planId: "plan-1",
      stepId: "step-1",
      attempt: 1,
      timestamp: "2026-03-13T00:00:00.000Z",
    });
    expect(received).toHaveLength(1);

    bus.off(handler);
    bus.emit({
      type: "step:completed",
      planId: "plan-1",
      stepId: "step-1",
      durationMs: 100,
      timestamp: "2026-03-13T00:00:00.000Z",
    });
    expect(received).toHaveLength(1);
  });

  it("emit() with no handlers registered does not throw", () => {
    const { bus } = makeEventBus();

    expect(() => {
      bus.emit({
        type: "plan:completed",
        planId: "plan-1",
        totalSteps: 5,
        durationMs: 5000,
        timestamp: "2026-03-13T00:00:00.000Z",
      });
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// TaskPlannerLogger contract via mock
// ---------------------------------------------------------------------------

describe("TaskPlannerLogger contract (mock implementation)", () => {
  it("info() receives a message and optional metadata", () => {
    const logs: { message: string; data?: Readonly<Record<string, unknown>> }[] = [];

    const logger: TaskPlannerLogger = {
      info(message, data) {
        logs.push({ message, data });
      },
      error() {},
    };

    logger.info("Step started", { planId: "plan-1", stepId: "step-1" });
    expect(logs).toHaveLength(1);
    expect(logs[0]?.message).toBe("Step started");
    expect(logs[0]?.data?.["planId"]).toBe("plan-1");
  });

  it("error() receives a message and optional metadata", () => {
    const errors: { message: string; data?: Readonly<Record<string, unknown>> }[] = [];

    const logger: TaskPlannerLogger = {
      info() {},
      error(message, data) {
        errors.push({ message, data });
      },
    };

    logger.error("Step failed after retries", { stepId: "step-7", attempt: 3 });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe("Step failed after retries");
    expect(errors[0]?.data?.["attempt"]).toBe(3);
  });

  it("info() and error() can be called without metadata", () => {
    const infoLogs: string[] = [];
    const errorLogs: string[] = [];

    const logger: TaskPlannerLogger = {
      info(message) {
        infoLogs.push(message);
      },
      error(message) {
        errorLogs.push(message);
      },
    };

    logger.info("Plan created");
    logger.error("Unexpected persistence error");

    expect(infoLogs[0]).toBe("Plan created");
    expect(errorLogs[0]).toBe("Unexpected persistence error");
  });
});
