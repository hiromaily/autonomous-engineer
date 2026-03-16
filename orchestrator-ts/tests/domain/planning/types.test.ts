import {
  PLAN_REVIEW_REASONS,
  type PlanEvent,
  type PlanReviewReason,
  type Step,
  STEP_STATUSES,
  type StepStatus,
  type Task,
  TASK_STATUSES,
  type TaskPlan,
  type TaskStatus,
} from "@/domain/planning/types";
import { describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// StepStatus
// ---------------------------------------------------------------------------
describe("StepStatus", () => {
  it("STEP_STATUSES contains exactly four statuses", () => {
    expect(STEP_STATUSES).toHaveLength(4);
  });

  it("STEP_STATUSES contains all required values", () => {
    const expected: StepStatus[] = ["pending", "in_progress", "completed", "failed"];
    for (const status of expected) {
      expect(STEP_STATUSES).toContain(status);
    }
  });

  it("STEP_STATUSES is frozen (runtime immutable)", () => {
    expect(Object.isFrozen(STEP_STATUSES)).toBe(true);
    expect(() => (STEP_STATUSES as unknown as string[]).push("extra")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// TaskStatus
// ---------------------------------------------------------------------------
describe("TaskStatus", () => {
  it("TASK_STATUSES contains exactly five statuses", () => {
    expect(TASK_STATUSES).toHaveLength(5);
  });

  it("TASK_STATUSES contains all required values", () => {
    const expected: TaskStatus[] = ["pending", "in_progress", "completed", "failed", "escalated-to-human"];
    for (const status of expected) {
      expect(TASK_STATUSES).toContain(status);
    }
  });

  it("TASK_STATUSES is frozen (runtime immutable)", () => {
    expect(Object.isFrozen(TASK_STATUSES)).toBe(true);
    expect(() => (TASK_STATUSES as unknown as string[]).push("extra")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Step shape
// ---------------------------------------------------------------------------
describe("Step shape", () => {
  it("accepts a minimal Step with empty dependsOn and empty statusHistory", () => {
    const step: Step = {
      id: "step-1",
      description: "Read the existing code",
      status: "pending",
      dependsOn: [],
      statusHistory: [],
    };

    expect(step.id).toBe("step-1");
    expect(step.description).toBe("Read the existing code");
    expect(step.status).toBe("pending");
    expect(step.dependsOn).toHaveLength(0);
    expect(step.statusHistory).toHaveLength(0);
  });

  it("accepts a Step with dependencies", () => {
    const step: Step = {
      id: "step-2",
      description: "Implement the change",
      status: "pending",
      dependsOn: ["step-1"],
      statusHistory: [],
    };

    expect(step.dependsOn).toHaveLength(1);
    expect(step.dependsOn[0]).toBe("step-1");
  });

  it("accepts a Step with statusHistory recording transitions", () => {
    const step: Step = {
      id: "step-1",
      description: "Run tests",
      status: "completed",
      dependsOn: [],
      statusHistory: [
        { status: "pending", at: "2026-03-13T10:00:00.000Z" },
        { status: "in_progress", at: "2026-03-13T10:01:00.000Z" },
        { status: "completed", at: "2026-03-13T10:02:00.000Z" },
      ],
    };

    expect(step.statusHistory).toHaveLength(3);
    expect(step.statusHistory[0]?.status).toBe("pending");
    expect(step.statusHistory[1]?.status).toBe("in_progress");
    expect(step.statusHistory[2]?.status).toBe("completed");
    expect(step.statusHistory[0]?.at).toBe("2026-03-13T10:00:00.000Z");
  });

  it("accepts a failed Step with statusHistory", () => {
    const step: Step = {
      id: "step-3",
      description: "Deploy to production",
      status: "failed",
      dependsOn: ["step-2"],
      statusHistory: [
        { status: "pending", at: "2026-03-13T10:00:00.000Z" },
        { status: "in_progress", at: "2026-03-13T10:01:00.000Z" },
        { status: "failed", at: "2026-03-13T10:05:00.000Z" },
      ],
    };

    expect(step.status).toBe("failed");
    expect(step.statusHistory).toHaveLength(3);
    expect(step.statusHistory[2]?.status).toBe("failed");
  });

  it("Step is serializable to JSON and round-trips without data loss", () => {
    const step: Step = {
      id: "step-1",
      description: "Test step",
      status: "in_progress",
      dependsOn: ["step-0"],
      statusHistory: [{ status: "pending", at: "2026-03-13T09:00:00.000Z" }],
    };

    const json = JSON.stringify(step);
    const parsed = JSON.parse(json) as Step;

    expect(parsed.id).toBe(step.id);
    expect(parsed.description).toBe(step.description);
    expect(parsed.status).toBe(step.status);
    expect(parsed.dependsOn).toEqual(["step-0"]);
    expect(parsed.statusHistory).toHaveLength(1);
    expect(parsed.statusHistory[0]?.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// Task shape
// ---------------------------------------------------------------------------
describe("Task shape", () => {
  it("accepts a Task with no steps", () => {
    const task: Task = {
      id: "task-1",
      title: "Setup environment",
      status: "pending",
      steps: [],
    };

    expect(task.id).toBe("task-1");
    expect(task.title).toBe("Setup environment");
    expect(task.status).toBe("pending");
    expect(task.steps).toHaveLength(0);
  });

  it("accepts a Task with multiple steps", () => {
    const step1: Step = {
      id: "step-1",
      description: "Read config",
      status: "completed",
      dependsOn: [],
      statusHistory: [],
    };
    const step2: Step = {
      id: "step-2",
      description: "Apply config",
      status: "pending",
      dependsOn: ["step-1"],
      statusHistory: [],
    };

    const task: Task = {
      id: "task-1",
      title: "Configure system",
      status: "in_progress",
      steps: [step1, step2],
    };

    expect(task.steps).toHaveLength(2);
    expect(task.steps[0]?.id).toBe("step-1");
    expect(task.steps[1]?.id).toBe("step-2");
    expect(task.status).toBe("in_progress");
  });

  it("Task is serializable to JSON and round-trips without data loss", () => {
    const task: Task = {
      id: "task-1",
      title: "Test task",
      status: "completed",
      steps: [
        {
          id: "step-1",
          description: "Do thing",
          status: "completed",
          dependsOn: [],
          statusHistory: [],
        },
      ],
    };

    const json = JSON.stringify(task);
    const parsed = JSON.parse(json) as Task;

    expect(parsed.id).toBe(task.id);
    expect(parsed.title).toBe(task.title);
    expect(parsed.status).toBe(task.status);
    expect(parsed.steps).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// TaskPlan shape
// ---------------------------------------------------------------------------
describe("TaskPlan shape", () => {
  it("accepts a minimal TaskPlan with no tasks", () => {
    const plan: TaskPlan = {
      id: "plan-uuid-001",
      goal: "Implement feature X",
      tasks: [],
      createdAt: "2026-03-13T10:00:00.000Z",
      updatedAt: "2026-03-13T10:00:00.000Z",
    };

    expect(plan.id).toBe("plan-uuid-001");
    expect(plan.goal).toBe("Implement feature X");
    expect(plan.tasks).toHaveLength(0);
    expect(plan.createdAt).toBe("2026-03-13T10:00:00.000Z");
    expect(plan.updatedAt).toBe("2026-03-13T10:00:00.000Z");
  });

  it("accepts a TaskPlan with tasks and steps", () => {
    const plan: TaskPlan = {
      id: "plan-uuid-002",
      goal: "Refactor the auth module",
      tasks: [
        {
          id: "task-1",
          title: "Analyze current auth",
          status: "completed",
          steps: [
            {
              id: "step-1-1",
              description: "Read auth.ts",
              status: "completed",
              dependsOn: [],
              statusHistory: [],
            },
          ],
        },
        {
          id: "task-2",
          title: "Implement new auth",
          status: "pending",
          steps: [],
        },
      ],
      createdAt: "2026-03-13T09:00:00.000Z",
      updatedAt: "2026-03-13T10:00:00.000Z",
    };

    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[0]?.id).toBe("task-1");
    expect(plan.tasks[0]?.steps).toHaveLength(1);
    expect(plan.tasks[1]?.id).toBe("task-2");
    expect(plan.tasks[1]?.steps).toHaveLength(0);
  });

  it("TaskPlan is serializable to JSON and round-trips without data loss", () => {
    const plan: TaskPlan = {
      id: "plan-uuid-003",
      goal: "Test plan",
      tasks: [
        {
          id: "task-1",
          title: "Task one",
          status: "pending",
          steps: [],
        },
      ],
      createdAt: "2026-03-13T10:00:00.000Z",
      updatedAt: "2026-03-13T10:00:00.000Z",
    };

    const json = JSON.stringify(plan);
    const parsed = JSON.parse(json) as TaskPlan;

    expect(parsed.id).toBe(plan.id);
    expect(parsed.goal).toBe(plan.goal);
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.createdAt).toBe(plan.createdAt);
    expect(parsed.updatedAt).toBe(plan.updatedAt);
  });
});

// ---------------------------------------------------------------------------
// PlanReviewReason
// ---------------------------------------------------------------------------
describe("PlanReviewReason", () => {
  it("PLAN_REVIEW_REASONS contains exactly two reasons", () => {
    expect(PLAN_REVIEW_REASONS).toHaveLength(2);
  });

  it("PLAN_REVIEW_REASONS contains all required values", () => {
    const expected: PlanReviewReason[] = ["large-plan", "high-risk-operations"];
    for (const reason of expected) {
      expect(PLAN_REVIEW_REASONS).toContain(reason);
    }
  });

  it("PLAN_REVIEW_REASONS is frozen (runtime immutable)", () => {
    expect(Object.isFrozen(PLAN_REVIEW_REASONS)).toBe(true);
    expect(() => (PLAN_REVIEW_REASONS as unknown as string[]).push("extra")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// PlanEvent discriminated union
// ---------------------------------------------------------------------------
describe("PlanEvent discriminated union", () => {
  it("accepts a plan:created event", () => {
    const event: PlanEvent = {
      type: "plan:created",
      planId: "plan-001",
      goal: "Implement feature X",
      timestamp: "2026-03-13T10:00:00.000Z",
    };

    expect(event.type).toBe("plan:created");
    if (event.type === "plan:created") {
      expect(event.planId).toBe("plan-001");
      expect(event.goal).toBe("Implement feature X");
      expect(event.timestamp).toBe("2026-03-13T10:00:00.000Z");
    }
  });

  it("accepts a plan:validated event", () => {
    const event: PlanEvent = {
      type: "plan:validated",
      planId: "plan-001",
      timestamp: "2026-03-13T10:00:01.000Z",
    };

    expect(event.type).toBe("plan:validated");
    if (event.type === "plan:validated") {
      expect(event.planId).toBe("plan-001");
    }
  });

  it("accepts a plan:revision event", () => {
    const event: PlanEvent = {
      type: "plan:revision",
      planId: "plan-001",
      stepId: "step-2",
      originalDescription: "Deploy directly",
      revisedDescription: "Deploy via staging environment",
      reason: "Risk reduction",
      timestamp: "2026-03-13T10:00:02.000Z",
    };

    expect(event.type).toBe("plan:revision");
    if (event.type === "plan:revision") {
      expect(event.stepId).toBe("step-2");
      expect(event.originalDescription).toBe("Deploy directly");
      expect(event.revisedDescription).toBe("Deploy via staging environment");
      expect(event.reason).toBe("Risk reduction");
    }
  });

  it("accepts a step:start event", () => {
    const event: PlanEvent = {
      type: "step:start",
      planId: "plan-001",
      stepId: "step-1",
      attempt: 1,
      timestamp: "2026-03-13T10:01:00.000Z",
    };

    expect(event.type).toBe("step:start");
    if (event.type === "step:start") {
      expect(event.stepId).toBe("step-1");
      expect(event.attempt).toBe(1);
    }
  });

  it("accepts a step:completed event", () => {
    const event: PlanEvent = {
      type: "step:completed",
      planId: "plan-001",
      stepId: "step-1",
      durationMs: 5000,
      timestamp: "2026-03-13T10:01:05.000Z",
    };

    expect(event.type).toBe("step:completed");
    if (event.type === "step:completed") {
      expect(event.durationMs).toBe(5000);
    }
  });

  it("accepts a step:failed event", () => {
    const event: PlanEvent = {
      type: "step:failed",
      planId: "plan-001",
      stepId: "step-2",
      attempt: 2,
      errorSummary: "Command exited with code 1",
      recoveryAction: "retry",
      timestamp: "2026-03-13T10:02:00.000Z",
    };

    expect(event.type).toBe("step:failed");
    if (event.type === "step:failed") {
      expect(event.attempt).toBe(2);
      expect(event.errorSummary).toBe("Command exited with code 1");
      expect(event.recoveryAction).toBe("retry");
    }
  });

  it("accepts a step:escalated event", () => {
    const event: PlanEvent = {
      type: "step:escalated",
      planId: "plan-001",
      stepId: "step-3",
      timestamp: "2026-03-13T10:03:00.000Z",
    };

    expect(event.type).toBe("step:escalated");
    if (event.type === "step:escalated") {
      expect(event.stepId).toBe("step-3");
    }
  });

  it("accepts a plan:awaiting-review event with large-plan reason", () => {
    const event: PlanEvent = {
      type: "plan:awaiting-review",
      planId: "plan-001",
      reason: "large-plan",
      timestamp: "2026-03-13T10:00:00.000Z",
    };

    expect(event.type).toBe("plan:awaiting-review");
    if (event.type === "plan:awaiting-review") {
      expect(event.reason).toBe("large-plan");
    }
  });

  it("accepts a plan:awaiting-review event with high-risk-operations reason", () => {
    const event: PlanEvent = {
      type: "plan:awaiting-review",
      planId: "plan-001",
      reason: "high-risk-operations",
      timestamp: "2026-03-13T10:00:00.000Z",
    };

    expect(event.type).toBe("plan:awaiting-review");
    if (event.type === "plan:awaiting-review") {
      expect(event.reason).toBe("high-risk-operations");
    }
  });

  it("accepts a plan:completed event", () => {
    const event: PlanEvent = {
      type: "plan:completed",
      planId: "plan-001",
      totalSteps: 5,
      durationMs: 30000,
      timestamp: "2026-03-13T10:10:00.000Z",
    };

    expect(event.type).toBe("plan:completed");
    if (event.type === "plan:completed") {
      expect(event.totalSteps).toBe(5);
      expect(event.durationMs).toBe(30000);
    }
  });

  it("accepts a plan:escalated event", () => {
    const event: PlanEvent = {
      type: "plan:escalated",
      planId: "plan-001",
      failedStepId: "step-3",
      timestamp: "2026-03-13T10:10:00.000Z",
    };

    expect(event.type).toBe("plan:escalated");
    if (event.type === "plan:escalated") {
      expect(event.failedStepId).toBe("step-3");
    }
  });

  it("discriminates on the type field to allow exhaustive narrowing", () => {
    const events: PlanEvent[] = [
      { type: "plan:created", planId: "p1", goal: "goal", timestamp: "2026-03-13T10:00:00.000Z" },
      { type: "plan:validated", planId: "p1", timestamp: "2026-03-13T10:00:01.000Z" },
      { type: "step:start", planId: "p1", stepId: "s1", attempt: 1, timestamp: "2026-03-13T10:00:02.000Z" },
      { type: "plan:completed", planId: "p1", totalSteps: 1, durationMs: 1000, timestamp: "2026-03-13T10:00:03.000Z" },
    ];

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "plan:created",
      "plan:validated",
      "step:start",
      "plan:completed",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Compile-time exhaustive checks
// ---------------------------------------------------------------------------
const _exhaustiveStepStatus = (s: StepStatus): string => {
  switch (s) {
    case "pending":
      return "pending";
    case "in_progress":
      return "in_progress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
  }
};

const _exhaustiveTaskStatus = (s: TaskStatus): string => {
  switch (s) {
    case "pending":
      return "pending";
    case "in_progress":
      return "in_progress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "escalated-to-human":
      return "escalated-to-human";
  }
};

const _exhaustivePlanReviewReason = (r: PlanReviewReason): string => {
  switch (r) {
    case "large-plan":
      return "large-plan";
    case "high-risk-operations":
      return "high-risk-operations";
  }
};

const _exhaustivePlanEvent = (e: PlanEvent): string => {
  switch (e.type) {
    case "plan:created":
      return "plan:created";
    case "plan:validated":
      return "plan:validated";
    case "plan:revision":
      return "plan:revision";
    case "step:start":
      return "step:start";
    case "step:completed":
      return "step:completed";
    case "step:failed":
      return "step:failed";
    case "step:escalated":
      return "step:escalated";
    case "plan:awaiting-review":
      return "plan:awaiting-review";
    case "plan:completed":
      return "plan:completed";
    case "plan:escalated":
      return "plan:escalated";
  }
};

// These functions are used only for compile-time checks
void _exhaustiveStepStatus;
void _exhaustiveTaskStatus;
void _exhaustivePlanReviewReason;
void _exhaustivePlanEvent;
