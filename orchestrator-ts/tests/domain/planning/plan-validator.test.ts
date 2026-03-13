import { describe, expect, it } from "bun:test";
import { PlanValidator } from "../../../domain/planning/plan-validator";
import type { Step, Task, TaskPlan } from "../../../domain/planning/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep(id: string, dependsOn: string[] = []): Step {
  return {
    id,
    description: `Step ${id}`,
    status: "pending",
    dependsOn,
    statusHistory: [],
  };
}

function makePlan(steps: Step[]): TaskPlan {
  const task: Task = {
    id: "task-1",
    title: "Task One",
    status: "pending",
    steps,
  };
  return {
    id: "plan-001",
    goal: "Test goal",
    tasks: [task],
    createdAt: "2026-03-13T10:00:00.000Z",
    updatedAt: "2026-03-13T10:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// PlanValidator — happy path
// ---------------------------------------------------------------------------
describe("PlanValidator — valid plans", () => {
  const validator = new PlanValidator();

  it("returns valid=true and empty errors for an empty plan (no tasks)", () => {
    const plan: TaskPlan = {
      id: "plan-empty",
      goal: "empty",
      tasks: [],
      createdAt: "2026-03-13T10:00:00.000Z",
      updatedAt: "2026-03-13T10:00:00.000Z",
    };

    const result = validator.validate(plan);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.executionOrder).toHaveLength(0);
  });

  it("returns valid=true for a single step with no dependencies", () => {
    const plan = makePlan([makeStep("step-1")]);
    const result = validator.validate(plan);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.executionOrder).toEqual(["step-1"]);
  });

  it("returns correct topological order for a linear chain A → B → C", () => {
    const plan = makePlan([
      makeStep("step-a"),
      makeStep("step-b", ["step-a"]),
      makeStep("step-c", ["step-b"]),
    ]);
    const result = validator.validate(plan);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    // step-a must appear before step-b, which must appear before step-c
    const order = result.executionOrder;
    expect(order.indexOf("step-a")).toBeLessThan(order.indexOf("step-b"));
    expect(order.indexOf("step-b")).toBeLessThan(order.indexOf("step-c"));
    expect(order).toHaveLength(3);
  });

  it("returns a valid topological order for a diamond DAG (A → B, A → C, B → D, C → D)", () => {
    const plan = makePlan([
      makeStep("step-a"),
      makeStep("step-b", ["step-a"]),
      makeStep("step-c", ["step-a"]),
      makeStep("step-d", ["step-b", "step-c"]),
    ]);
    const result = validator.validate(plan);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    const order = result.executionOrder;
    expect(order).toHaveLength(4);
    expect(order.indexOf("step-a")).toBeLessThan(order.indexOf("step-b"));
    expect(order.indexOf("step-a")).toBeLessThan(order.indexOf("step-c"));
    expect(order.indexOf("step-b")).toBeLessThan(order.indexOf("step-d"));
    expect(order.indexOf("step-c")).toBeLessThan(order.indexOf("step-d"));
  });

  it("treats steps with empty dependsOn as immediately eligible (no errors)", () => {
    const plan = makePlan([
      makeStep("step-1", []),
      makeStep("step-2", []),
    ]);
    const result = validator.validate(plan);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.executionOrder).toHaveLength(2);
  });

  it("handles steps spread across multiple tasks", () => {
    const task1: Task = {
      id: "task-1",
      title: "Task One",
      status: "pending",
      steps: [makeStep("step-a"), makeStep("step-b", ["step-a"])],
    };
    const task2: Task = {
      id: "task-2",
      title: "Task Two",
      status: "pending",
      steps: [makeStep("step-c", ["step-b"])],
    };
    const plan: TaskPlan = {
      id: "plan-multi",
      goal: "multi-task plan",
      tasks: [task1, task2],
      createdAt: "2026-03-13T10:00:00.000Z",
      updatedAt: "2026-03-13T10:00:00.000Z",
    };

    const result = validator.validate(plan);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    const order = result.executionOrder;
    expect(order.indexOf("step-a")).toBeLessThan(order.indexOf("step-b"));
    expect(order.indexOf("step-b")).toBeLessThan(order.indexOf("step-c"));
  });

  it("returns all step IDs in executionOrder when valid is true", () => {
    const steps = ["s1", "s2", "s3", "s4"].map((id) => makeStep(id));
    const plan = makePlan(steps);
    const result = validator.validate(plan);

    expect(result.valid).toBe(true);
    expect(result.executionOrder).toHaveLength(4);
    for (const id of ["s1", "s2", "s3", "s4"]) {
      expect(result.executionOrder).toContain(id);
    }
  });
});

// ---------------------------------------------------------------------------
// PlanValidator — duplicate ID detection
// ---------------------------------------------------------------------------
describe("PlanValidator — duplicate ID detection", () => {
  const validator = new PlanValidator();

  it("detects duplicate step IDs within the same task", () => {
    const plan = makePlan([makeStep("step-1"), makeStep("step-1")]);
    const result = validator.validate(plan);

    expect(result.valid).toBe(false);
    expect(result.executionOrder).toHaveLength(0);
    const dupErrors = result.errors.filter((e) => e.code === "duplicate-id");
    expect(dupErrors.length).toBeGreaterThan(0);
    expect(dupErrors[0]?.message).toContain("step-1");
  });

  it("detects duplicate step IDs across different tasks", () => {
    const task1: Task = {
      id: "task-1",
      title: "Task One",
      status: "pending",
      steps: [makeStep("shared-id")],
    };
    const task2: Task = {
      id: "task-2",
      title: "Task Two",
      status: "pending",
      steps: [makeStep("shared-id")],
    };
    const plan: TaskPlan = {
      id: "plan-dup",
      goal: "dup test",
      tasks: [task1, task2],
      createdAt: "2026-03-13T10:00:00.000Z",
      updatedAt: "2026-03-13T10:00:00.000Z",
    };

    const result = validator.validate(plan);

    expect(result.valid).toBe(false);
    const dupErrors = result.errors.filter((e) => e.code === "duplicate-id");
    expect(dupErrors.length).toBeGreaterThan(0);
  });

  it("detects duplicate task IDs", () => {
    const task1: Task = { id: "dup-task", title: "T1", status: "pending", steps: [] };
    const task2: Task = { id: "dup-task", title: "T2", status: "pending", steps: [] };
    const plan: TaskPlan = {
      id: "plan-dup-task",
      goal: "dup task test",
      tasks: [task1, task2],
      createdAt: "2026-03-13T10:00:00.000Z",
      updatedAt: "2026-03-13T10:00:00.000Z",
    };

    const result = validator.validate(plan);

    expect(result.valid).toBe(false);
    const dupErrors = result.errors.filter((e) => e.code === "duplicate-id");
    expect(dupErrors.length).toBeGreaterThan(0);
    expect(dupErrors[0]?.message).toContain("dup-task");
  });
});

// ---------------------------------------------------------------------------
// PlanValidator — missing dependency detection
// ---------------------------------------------------------------------------
describe("PlanValidator — missing dependency detection", () => {
  const validator = new PlanValidator();

  it("produces a missing-dependency error when a step references a non-existent step", () => {
    const plan = makePlan([makeStep("step-1", ["step-does-not-exist"])]);
    const result = validator.validate(plan);

    expect(result.valid).toBe(false);
    expect(result.executionOrder).toHaveLength(0);
    const missingErrors = result.errors.filter((e) => e.code === "missing-dependency");
    expect(missingErrors.length).toBeGreaterThan(0);
    expect(missingErrors[0]?.message).toContain("step-does-not-exist");
  });

  it("reports all missing dependencies from a single step in one pass", () => {
    const plan = makePlan([makeStep("step-1", ["missing-a", "missing-b"])]);
    const result = validator.validate(plan);

    expect(result.valid).toBe(false);
    const missingErrors = result.errors.filter((e) => e.code === "missing-dependency");
    expect(missingErrors.length).toBe(2);
  });

  it("reports missing dependencies from multiple steps in one pass", () => {
    const plan = makePlan([
      makeStep("step-1", ["ghost-1"]),
      makeStep("step-2", ["ghost-2"]),
    ]);
    const result = validator.validate(plan);

    expect(result.valid).toBe(false);
    const missingErrors = result.errors.filter((e) => e.code === "missing-dependency");
    expect(missingErrors.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// PlanValidator — circular dependency detection
// ---------------------------------------------------------------------------
describe("PlanValidator — circular dependency detection", () => {
  const validator = new PlanValidator();

  it("detects a two-node cycle (A → B → A)", () => {
    const plan = makePlan([
      makeStep("step-a", ["step-b"]),
      makeStep("step-b", ["step-a"]),
    ]);
    const result = validator.validate(plan);

    expect(result.valid).toBe(false);
    expect(result.executionOrder).toHaveLength(0);
    const cycleErrors = result.errors.filter((e) => e.code === "circular-dependency");
    expect(cycleErrors.length).toBeGreaterThan(0);
  });

  it("detects a three-node cycle (A → B → C → A)", () => {
    const plan = makePlan([
      makeStep("step-a", ["step-c"]),
      makeStep("step-b", ["step-a"]),
      makeStep("step-c", ["step-b"]),
    ]);
    const result = validator.validate(plan);

    expect(result.valid).toBe(false);
    const cycleErrors = result.errors.filter((e) => e.code === "circular-dependency");
    expect(cycleErrors.length).toBeGreaterThan(0);
  });

  it("detects a self-referencing step (A → A)", () => {
    const plan = makePlan([makeStep("step-a", ["step-a"])]);
    const result = validator.validate(plan);

    expect(result.valid).toBe(false);
    // Either missing-dependency or circular-dependency is acceptable — step-a's dep on itself
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// PlanValidator — accumulated errors (non-fail-fast)
// ---------------------------------------------------------------------------
describe("PlanValidator — error accumulation", () => {
  const validator = new PlanValidator();

  it("accumulates multiple error types in a single validate call", () => {
    // duplicate ID + missing dependency — both should be reported
    const plan = makePlan([
      makeStep("step-dup"),
      makeStep("step-dup"),
      makeStep("step-x", ["missing-dep"]),
    ]);
    const result = validator.validate(plan);

    expect(result.valid).toBe(false);
    const dupErrors = result.errors.filter((e) => e.code === "duplicate-id");
    const missingErrors = result.errors.filter((e) => e.code === "missing-dependency");
    expect(dupErrors.length).toBeGreaterThan(0);
    expect(missingErrors.length).toBeGreaterThan(0);
  });

  it("returns executionOrder as empty array when valid is false", () => {
    const plan = makePlan([makeStep("step-1", ["missing"])]);
    const result = validator.validate(plan);

    expect(result.valid).toBe(false);
    expect(result.executionOrder).toHaveLength(0);
  });
});
