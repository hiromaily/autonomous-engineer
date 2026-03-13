import { describe, expect, it } from "bun:test";
import {
  ACTION_CATEGORIES,
  type ActionCategory,
  type ActionPlan,
  type AgentLoopEvent,
  type AgentState,
  LOOP_STEPS,
  type LoopStep,
  type Observation,
  type PlanAdjustment,
  type ReflectionAssessment,
  type ReflectionOutput,
  TERMINATION_CONDITIONS,
  type TerminationCondition,
} from "../../../domain/agent/types";

// ---------------------------------------------------------------------------
// ActionCategory
// ---------------------------------------------------------------------------
describe("ActionCategory", () => {
  it("ACTION_CATEGORIES contains exactly four categories", () => {
    expect(ACTION_CATEGORIES).toHaveLength(4);
  });

  it("ACTION_CATEGORIES contains all required values", () => {
    const expected: ActionCategory[] = [
      "Exploration",
      "Modification",
      "Validation",
      "Documentation",
    ];
    for (const category of expected) {
      expect(ACTION_CATEGORIES).toContain(category);
    }
  });

  it("ACTION_CATEGORIES is frozen (runtime immutable)", () => {
    expect(Object.isFrozen(ACTION_CATEGORIES)).toBe(true);
    expect(() => (ACTION_CATEGORIES as unknown as string[]).push("extra")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// LoopStep
// ---------------------------------------------------------------------------
describe("LoopStep", () => {
  it("LOOP_STEPS contains exactly five steps", () => {
    expect(LOOP_STEPS).toHaveLength(5);
  });

  it("LOOP_STEPS contains all required values", () => {
    const expected: LoopStep[] = ["PLAN", "ACT", "OBSERVE", "REFLECT", "UPDATE_STATE"];
    for (const step of expected) {
      expect(LOOP_STEPS).toContain(step);
    }
  });

  it("LOOP_STEPS is frozen (runtime immutable)", () => {
    expect(Object.isFrozen(LOOP_STEPS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ActionPlan shape
// ---------------------------------------------------------------------------
describe("ActionPlan shape", () => {
  it("accepts a valid ActionPlan with all required fields", () => {
    const plan: ActionPlan = {
      category: "Exploration",
      toolName: "read_file",
      toolInput: { path: "/workspace/src/index.ts" },
      rationale: "Need to understand the current implementation before modifying it.",
    };

    expect(plan.category).toBe("Exploration");
    expect(plan.toolName).toBe("read_file");
    expect(plan.toolInput["path"]).toBe("/workspace/src/index.ts");
    expect(plan.rationale).toBe("Need to understand the current implementation before modifying it.");
  });

  it("accepts ActionPlan with nested toolInput values", () => {
    const plan: ActionPlan = {
      category: "Modification",
      toolName: "write_file",
      toolInput: { path: "/workspace/src/foo.ts", content: "export const x = 1;" },
      rationale: "Adding the new export as planned.",
    };

    expect(plan.category).toBe("Modification");
    expect(plan.toolInput["content"]).toBe("export const x = 1;");
  });

  it("ActionPlan is serializable to JSON and round-trips without data loss", () => {
    const plan: ActionPlan = {
      category: "Validation",
      toolName: "run_tests",
      toolInput: { pattern: "tests/**/*.test.ts" },
      rationale: "Verifying the implementation passes all tests.",
    };

    const json = JSON.stringify(plan);
    const parsed = JSON.parse(json) as ActionPlan;

    expect(parsed.category).toBe(plan.category);
    expect(parsed.toolName).toBe(plan.toolName);
    expect(parsed.toolInput["pattern"]).toBe(plan.toolInput["pattern"]);
    expect(parsed.rationale).toBe(plan.rationale);
  });
});

// ---------------------------------------------------------------------------
// ReflectionAssessment (supporting union type)
// ---------------------------------------------------------------------------
describe("ReflectionAssessment", () => {
  it("accepts all three valid assessment values", () => {
    const assessments: ReflectionAssessment[] = ["expected", "unexpected", "failure"];
    expect(assessments).toHaveLength(3);
    expect(assessments).toContain("expected");
    expect(assessments).toContain("unexpected");
    expect(assessments).toContain("failure");
  });
});

// ---------------------------------------------------------------------------
// PlanAdjustment (supporting union type)
// ---------------------------------------------------------------------------
describe("PlanAdjustment", () => {
  it("accepts all three valid adjustment values", () => {
    const adjustments: PlanAdjustment[] = ["continue", "revise", "stop"];
    expect(adjustments).toHaveLength(3);
    expect(adjustments).toContain("continue");
    expect(adjustments).toContain("revise");
    expect(adjustments).toContain("stop");
  });
});

// ---------------------------------------------------------------------------
// ReflectionOutput shape
// ---------------------------------------------------------------------------
describe("ReflectionOutput shape", () => {
  it("accepts a minimal ReflectionOutput with required fields only", () => {
    const reflection: ReflectionOutput = {
      assessment: "expected",
      learnings: ["The file was read successfully."],
      planAdjustment: "continue",
      summary: "Action produced expected results; proceeding with plan.",
    };

    expect(reflection.assessment).toBe("expected");
    expect(reflection.learnings).toHaveLength(1);
    expect(reflection.planAdjustment).toBe("continue");
    expect(reflection.summary).toBe("Action produced expected results; proceeding with plan.");
    expect(reflection.revisedPlan).toBeUndefined();
    expect(reflection.requiresHumanIntervention).toBeUndefined();
    expect(reflection.taskComplete).toBeUndefined();
  });

  it("accepts a ReflectionOutput with plan revision", () => {
    const reflection: ReflectionOutput = {
      assessment: "unexpected",
      learnings: ["The file structure differs from expected.", "Need to update approach."],
      planAdjustment: "revise",
      revisedPlan: ["Read the config file first", "Then apply the targeted modification"],
      summary: "Unexpected file structure found; plan revised to check config first.",
    };

    expect(reflection.assessment).toBe("unexpected");
    expect(reflection.planAdjustment).toBe("revise");
    expect(reflection.revisedPlan).toHaveLength(2);
    expect(reflection.revisedPlan?.[0]).toBe("Read the config file first");
  });

  it("accepts a ReflectionOutput indicating task completion", () => {
    const reflection: ReflectionOutput = {
      assessment: "expected",
      learnings: ["All tests passed successfully."],
      planAdjustment: "stop",
      taskComplete: true,
      summary: "Task completed: all tests pass and code is correct.",
    };

    expect(reflection.planAdjustment).toBe("stop");
    expect(reflection.taskComplete).toBe(true);
    expect(reflection.requiresHumanIntervention).toBeUndefined();
  });

  it("accepts a ReflectionOutput requiring human intervention", () => {
    const reflection: ReflectionOutput = {
      assessment: "failure",
      learnings: ["Requirement is ambiguous — unclear which approach to take."],
      planAdjustment: "stop",
      requiresHumanIntervention: true,
      summary: "Cannot proceed without clarification on the requirement.",
    };

    expect(reflection.assessment).toBe("failure");
    expect(reflection.requiresHumanIntervention).toBe(true);
    expect(reflection.taskComplete).toBeUndefined();
  });

  it("ReflectionOutput is serializable to JSON and round-trips without data loss", () => {
    const reflection: ReflectionOutput = {
      assessment: "unexpected",
      learnings: ["learning one", "learning two"],
      planAdjustment: "revise",
      revisedPlan: ["step A", "step B"],
      summary: "Plan revision needed.",
    };

    const json = JSON.stringify(reflection);
    const parsed = JSON.parse(json) as ReflectionOutput;

    expect(parsed.assessment).toBe(reflection.assessment);
    expect(parsed.learnings).toEqual(["learning one", "learning two"]);
    expect(parsed.revisedPlan).toEqual(["step A", "step B"]);
    expect(parsed.summary).toBe(reflection.summary);
  });
});

// ---------------------------------------------------------------------------
// TerminationCondition
// ---------------------------------------------------------------------------
describe("TerminationCondition", () => {
  it("TERMINATION_CONDITIONS contains exactly five conditions", () => {
    expect(TERMINATION_CONDITIONS).toHaveLength(5);
  });

  it("TERMINATION_CONDITIONS contains all required values", () => {
    const expected: TerminationCondition[] = [
      "TASK_COMPLETED",
      "MAX_ITERATIONS_REACHED",
      "HUMAN_INTERVENTION_REQUIRED",
      "SAFETY_STOP",
      "RECOVERY_EXHAUSTED",
    ];
    for (const condition of expected) {
      expect(TERMINATION_CONDITIONS).toContain(condition);
    }
  });

  it("TERMINATION_CONDITIONS is frozen (runtime immutable)", () => {
    expect(Object.isFrozen(TERMINATION_CONDITIONS)).toBe(true);
    expect(() => (TERMINATION_CONDITIONS as unknown as string[]).push("extra")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Observation shape
// ---------------------------------------------------------------------------
describe("Observation shape", () => {
  it("accepts a successful observation with string rawOutput", () => {
    const obs: Observation = {
      toolName: "read_file",
      toolInput: { path: "/workspace/src/index.ts" },
      rawOutput: "export const x = 1;",
      success: true,
      recordedAt: "2026-03-11T21:00:00.000Z",
    };

    expect(obs.toolName).toBe("read_file");
    expect(obs.success).toBe(true);
    expect(obs.rawOutput).toBe("export const x = 1;");
    expect(obs.error).toBeUndefined();
    expect(obs.reflection).toBeUndefined();
  });

  it("accepts a failed observation with a structured ToolError", () => {
    const obs: Observation = {
      toolName: "write_file",
      toolInput: { path: "/workspace/src/foo.ts", content: "x" },
      rawOutput: undefined,
      success: false,
      error: { type: "permission", message: "filesystemWrite not granted" },
      recordedAt: "2026-03-11T21:00:01.000Z",
    };

    expect(obs.success).toBe(false);
    expect(obs.error?.type).toBe("permission");
    expect(obs.error?.message).toBe("filesystemWrite not granted");
  });

  it("accepts an observation with reflection metadata attached", () => {
    const reflection: ReflectionOutput = {
      assessment: "expected",
      learnings: ["File content is as expected."],
      planAdjustment: "continue",
      summary: "Proceeding to next step.",
    };

    const obs: Observation = {
      toolName: "read_file",
      toolInput: { path: "/workspace/src/index.ts" },
      rawOutput: "export const x = 1;",
      success: true,
      recordedAt: "2026-03-11T21:00:00.000Z",
      reflection,
    };

    expect(obs.reflection?.assessment).toBe("expected");
    expect(obs.reflection?.learnings).toHaveLength(1);
  });

  it("accepts observations with varied rawOutput types (object, array, null)", () => {
    const objectObs: Observation = {
      toolName: "run_tests",
      toolInput: {},
      rawOutput: { passed: 10, failed: 0 },
      success: true,
      recordedAt: "2026-03-11T21:00:02.000Z",
    };

    const arrayObs: Observation = {
      toolName: "list_files",
      toolInput: { dir: "/workspace" },
      rawOutput: ["index.ts", "types.ts"],
      success: true,
      recordedAt: "2026-03-11T21:00:03.000Z",
    };

    expect((objectObs.rawOutput as Record<string, number>)["passed"]).toBe(10);
    expect(Array.isArray(arrayObs.rawOutput)).toBe(true);
  });

  it("Observation with string rawOutput is serializable to JSON and round-trips without data loss", () => {
    const obs: Observation = {
      toolName: "read_file",
      toolInput: { path: "/workspace/src/index.ts" },
      rawOutput: "file contents here",
      success: true,
      recordedAt: "2026-03-11T21:00:00.000Z",
    };

    const json = JSON.stringify(obs);
    const parsed = JSON.parse(json) as Observation;

    expect(parsed.toolName).toBe(obs.toolName);
    expect(parsed.success).toBe(obs.success);
    expect(parsed.rawOutput).toBe("file contents here");
    expect(parsed.recordedAt).toBe(obs.recordedAt);
    expect(parsed.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AgentState shape
// ---------------------------------------------------------------------------
describe("AgentState shape", () => {
  it("accepts a fresh initial agent state with empty arrays and zero counts", () => {
    const state: AgentState = {
      task: "Implement the agent loop feature",
      plan: [],
      completedSteps: [],
      currentStep: null,
      iterationCount: 0,
      observations: [],
      recoveryAttempts: 0,
      startedAt: "2026-03-11T21:00:00.000Z",
    };

    expect(state.task).toBe("Implement the agent loop feature");
    expect(state.plan).toHaveLength(0);
    expect(state.completedSteps).toHaveLength(0);
    expect(state.currentStep).toBeNull();
    expect(state.iterationCount).toBe(0);
    expect(state.observations).toHaveLength(0);
    expect(state.recoveryAttempts).toBe(0);
    expect(state.startedAt).toBe("2026-03-11T21:00:00.000Z");
  });

  it("accepts an in-progress agent state with plan and currentStep", () => {
    const state: AgentState = {
      task: "Add new feature X",
      plan: ["Read existing code", "Implement the change", "Run tests"],
      completedSteps: ["Read existing code"],
      currentStep: "Implement the change",
      iterationCount: 1,
      observations: [],
      recoveryAttempts: 0,
      startedAt: "2026-03-11T21:00:00.000Z",
    };

    expect(state.plan).toHaveLength(3);
    expect(state.completedSteps).toHaveLength(1);
    expect(state.currentStep).toBe("Implement the change");
    expect(state.iterationCount).toBe(1);
  });

  it("accepts an agent state with accumulated observations", () => {
    const obs1: Observation = {
      toolName: "read_file",
      toolInput: { path: "/workspace/src/index.ts" },
      rawOutput: "export const x = 1;",
      success: true,
      recordedAt: "2026-03-11T21:00:01.000Z",
    };

    const obs2: Observation = {
      toolName: "write_file",
      toolInput: { path: "/workspace/src/index.ts", content: "export const x = 2;" },
      rawOutput: null,
      success: true,
      recordedAt: "2026-03-11T21:00:02.000Z",
    };

    const state: AgentState = {
      task: "Update constant x to 2",
      plan: ["Read file", "Write updated file"],
      completedSteps: ["Read file", "Write updated file"],
      currentStep: null,
      iterationCount: 2,
      observations: [obs1, obs2],
      recoveryAttempts: 0,
      startedAt: "2026-03-11T21:00:00.000Z",
    };

    expect(state.observations).toHaveLength(2);
    expect(state.observations[0]?.toolName).toBe("read_file");
    expect(state.observations[1]?.toolName).toBe("write_file");
    expect(state.iterationCount).toBe(2);
  });

  it("AgentState with string rawOutput observations is serializable to JSON and round-trips without data loss", () => {
    const obs: Observation = {
      toolName: "read_file",
      toolInput: { path: "/workspace/src/index.ts" },
      rawOutput: "file content",
      success: true,
      recordedAt: "2026-03-11T21:00:01.000Z",
    };

    const state: AgentState = {
      task: "Test serialization",
      plan: ["Step one"],
      completedSteps: [],
      currentStep: "Step one",
      iterationCount: 0,
      observations: [obs],
      recoveryAttempts: 0,
      startedAt: "2026-03-11T21:00:00.000Z",
    };

    const json = JSON.stringify(state);
    const parsed = JSON.parse(json) as AgentState;

    expect(parsed.task).toBe(state.task);
    expect(parsed.plan).toEqual(["Step one"]);
    expect(parsed.currentStep).toBe("Step one");
    expect(parsed.iterationCount).toBe(0);
    expect(parsed.observations).toHaveLength(1);
    expect(parsed.observations[0]?.rawOutput).toBe("file content");
    expect(parsed.startedAt).toBe(state.startedAt);
  });
});

// ---------------------------------------------------------------------------
// AgentLoopEvent discriminated union
// ---------------------------------------------------------------------------
describe("AgentLoopEvent discriminated union", () => {
  it("accepts an iteration:start event with required fields", () => {
    const event: AgentLoopEvent = {
      type: "iteration:start",
      iteration: 1,
      currentStep: "Read existing code",
      timestamp: "2026-03-11T21:00:00.000Z",
    };

    expect(event.type).toBe("iteration:start");
    if (event.type === "iteration:start") {
      expect(event.iteration).toBe(1);
      expect(event.currentStep).toBe("Read existing code");
      expect(event.timestamp).toBe("2026-03-11T21:00:00.000Z");
    }
  });

  it("accepts an iteration:start event with null currentStep", () => {
    const event: AgentLoopEvent = {
      type: "iteration:start",
      iteration: 1,
      currentStep: null,
      timestamp: "2026-03-11T21:00:00.000Z",
    };

    if (event.type === "iteration:start") {
      expect(event.currentStep).toBeNull();
    }
  });

  it("accepts an iteration:complete event with required fields", () => {
    const event: AgentLoopEvent = {
      type: "iteration:complete",
      iteration: 1,
      category: "Exploration",
      toolName: "read_file",
      durationMs: 120,
      assessment: "expected",
    };

    expect(event.type).toBe("iteration:complete");
    if (event.type === "iteration:complete") {
      expect(event.iteration).toBe(1);
      expect(event.category).toBe("Exploration");
      expect(event.toolName).toBe("read_file");
      expect(event.durationMs).toBe(120);
      expect(event.assessment).toBe("expected");
    }
  });

  it("accepts a step:start event with required fields", () => {
    const event: AgentLoopEvent = {
      type: "step:start",
      step: "PLAN",
      iteration: 2,
      timestamp: "2026-03-11T21:00:01.000Z",
    };

    expect(event.type).toBe("step:start");
    if (event.type === "step:start") {
      expect(event.step).toBe("PLAN");
      expect(event.iteration).toBe(2);
      expect(event.timestamp).toBe("2026-03-11T21:00:01.000Z");
    }
  });

  it("accepts a step:complete event with required fields", () => {
    const event: AgentLoopEvent = {
      type: "step:complete",
      step: "ACT",
      iteration: 2,
      durationMs: 45,
    };

    expect(event.type).toBe("step:complete");
    if (event.type === "step:complete") {
      expect(event.step).toBe("ACT");
      expect(event.durationMs).toBe(45);
    }
  });

  it("accepts a recovery:attempt event with required fields", () => {
    const event: AgentLoopEvent = {
      type: "recovery:attempt",
      attempt: 1,
      maxAttempts: 3,
      errorMessage: "ENOENT: no such file or directory",
    };

    expect(event.type).toBe("recovery:attempt");
    if (event.type === "recovery:attempt") {
      expect(event.attempt).toBe(1);
      expect(event.maxAttempts).toBe(3);
      expect(event.errorMessage).toBe("ENOENT: no such file or directory");
    }
  });

  it("accepts a terminated event with required fields", () => {
    const finalState: AgentState = {
      task: "Completed task",
      plan: ["Step one"],
      completedSteps: ["Step one"],
      currentStep: null,
      iterationCount: 1,
      observations: [],
      recoveryAttempts: 0,
      startedAt: "2026-03-11T21:00:00.000Z",
    };

    const event: AgentLoopEvent = {
      type: "terminated",
      condition: "TASK_COMPLETED",
      finalState,
      timestamp: "2026-03-11T21:01:00.000Z",
    };

    expect(event.type).toBe("terminated");
    if (event.type === "terminated") {
      expect(event.condition).toBe("TASK_COMPLETED");
      expect(event.finalState.task).toBe("Completed task");
      expect(event.timestamp).toBe("2026-03-11T21:01:00.000Z");
    }
  });

  it("discriminates on the type field to allow exhaustive narrowing", () => {
    const events: AgentLoopEvent[] = [
      { type: "iteration:start", iteration: 1, currentStep: null, timestamp: "2026-03-11T21:00:00.000Z" },
      { type: "step:start", step: "PLAN", iteration: 1, timestamp: "2026-03-11T21:00:00.100Z" },
      { type: "step:complete", step: "PLAN", iteration: 1, durationMs: 50 },
      {
        type: "iteration:complete",
        iteration: 1,
        category: "Exploration",
        toolName: "read_file",
        durationMs: 200,
        assessment: "expected",
      },
    ];

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "iteration:start",
      "step:start",
      "step:complete",
      "iteration:complete",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Compile-time exhaustive checks
// ---------------------------------------------------------------------------
const _exhaustiveAssessment = (a: ReflectionAssessment): string => {
  switch (a) {
    case "expected":
      return "expected";
    case "unexpected":
      return "unexpected";
    case "failure":
      return "failure";
  }
};

const _exhaustiveAdjustment = (a: PlanAdjustment): string => {
  switch (a) {
    case "continue":
      return "continue";
    case "revise":
      return "revise";
    case "stop":
      return "stop";
  }
};

const _exhaustiveLoopStep = (s: LoopStep): string => {
  switch (s) {
    case "PLAN":
      return "PLAN";
    case "ACT":
      return "ACT";
    case "OBSERVE":
      return "OBSERVE";
    case "REFLECT":
      return "REFLECT";
    case "UPDATE_STATE":
      return "UPDATE_STATE";
  }
};

const _exhaustiveCategory = (c: ActionCategory): string => {
  switch (c) {
    case "Exploration":
      return "Exploration";
    case "Modification":
      return "Modification";
    case "Validation":
      return "Validation";
    case "Documentation":
      return "Documentation";
  }
};

const _exhaustiveTermination = (t: TerminationCondition): string => {
  switch (t) {
    case "TASK_COMPLETED":
      return "TASK_COMPLETED";
    case "MAX_ITERATIONS_REACHED":
      return "MAX_ITERATIONS_REACHED";
    case "HUMAN_INTERVENTION_REQUIRED":
      return "HUMAN_INTERVENTION_REQUIRED";
    case "SAFETY_STOP":
      return "SAFETY_STOP";
    case "RECOVERY_EXHAUSTED":
      return "RECOVERY_EXHAUSTED";
  }
};

const _exhaustiveAgentLoopEvent = (e: AgentLoopEvent): string => {
  switch (e.type) {
    case "iteration:start":
      return "iteration:start";
    case "iteration:complete":
      return "iteration:complete";
    case "step:start":
      return "step:start";
    case "step:complete":
      return "step:complete";
    case "recovery:attempt":
      return "recovery:attempt";
    case "terminated":
      return "terminated";
  }
};

// These functions are used only for compile-time checks
void _exhaustiveAssessment;
void _exhaustiveAdjustment;
void _exhaustiveLoopStep;
void _exhaustiveCategory;
void _exhaustiveTermination;
void _exhaustiveAgentLoopEvent;
