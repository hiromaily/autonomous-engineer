import { TaskPlanningService } from "@/application/services/planning/task-planning-service";
import { describe, expect, it } from "bun:test";
import {
  makeAgentLoop,
  makeBooleanAgentLoop,
  makeContextBuilder,
  makeFailureLlmResult,
  makeLlmFromResults,
  makePlanBody,
  makeStore,
  makeSuccessLlmResult,
} from "./fixtures";

// ---------------------------------------------------------------------------
// Task 6.1 — Plan Generation and Validation Flow
// Requirements: 2.1, 2.2, 2.4, 2.5, 6.4
// ---------------------------------------------------------------------------

describe("TaskPlanningService — task 6.1: plan generation and validation flow", () => {
  // -------------------------------------------------------------------------
  // 6.1.1 — Successful plan generation and execution
  // -------------------------------------------------------------------------

  describe("successful generation and execution", () => {
    it("returns completed when agent loop always returns task-completed", async () => {
      const agentLoop = makeAgentLoop();
      const { store } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makePlanBody([{ id: "step-1" }]))]);

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("Implement feature X", { skipHumanReview: true });

      expect(result.outcome).toBe("completed");
    });

    it("all steps have completed status in the returned plan", async () => {
      const agentLoop = makeAgentLoop();
      const { store } = makeStore();
      const llm = makeLlmFromResults([
        makeSuccessLlmResult(
          makePlanBody([
            { id: "step-1" },
            { id: "step-2", dependsOn: ["step-1"] },
          ]),
        ),
      ]);

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal", { skipHumanReview: true });

      const steps = result.plan.tasks[0]?.steps ?? [];
      expect(steps.every((s) => s.status === "completed")).toBe(true);
    });

    it("plan is persisted to the store before execution begins", async () => {
      const agentLoop = makeAgentLoop();
      const { store, saves } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makePlanBody())]);

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      await service.run("goal", { skipHumanReview: true });

      // The initial save happens before step execution; total saves ≥ 1
      expect(saves.length).toBeGreaterThanOrEqual(1);
    });

    it("returned plan ID is a UUID v4", async () => {
      const agentLoop = makeAgentLoop();
      const { store } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makePlanBody())]);

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal", { skipHumanReview: true });

      expect(result.plan.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 6.1.2 — LLM parse failure and retry exhaustion
  // -------------------------------------------------------------------------

  describe("LLM parse failure and retry logic", () => {
    it("retries and returns completed when LLM succeeds on second attempt after parse failure", async () => {
      const agentLoop = makeAgentLoop();
      const { store } = makeStore();
      const llm = makeLlmFromResults([
        makeSuccessLlmResult("not valid json"),
        makeSuccessLlmResult(makePlanBody()),
      ]);

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal", { skipHumanReview: true });

      expect(result.outcome).toBe("completed");
    });

    it("returns escalated after exhausting all parse retries", async () => {
      const agentLoop = makeAgentLoop();
      const { store } = makeStore();
      const llm = makeLlmFromResults([
        makeSuccessLlmResult("bad json"),
        makeSuccessLlmResult("bad json"),
        makeSuccessLlmResult("bad json"),
      ]);

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal", { skipHumanReview: true });

      expect(result.outcome).toBe("escalated");
    });

    it("returns escalated after exhausting all retries with LLM API errors", async () => {
      const agentLoop = makeAgentLoop();
      const { store } = makeStore();
      const llm = makeLlmFromResults([
        makeFailureLlmResult("API error 1"),
        makeFailureLlmResult("API error 2"),
        makeFailureLlmResult("API error 3"),
      ]);

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal", { skipHumanReview: true });

      expect(result.outcome).toBe("escalated");
      expect(result.escalationContext).toBeDefined();
    });

    it("escalationContext describes the failure when parse retries are exhausted", async () => {
      const agentLoop = makeAgentLoop();
      const { store } = makeStore();
      const llm = makeLlmFromResults([
        makeSuccessLlmResult("{}"),
        makeSuccessLlmResult("{}"),
        makeSuccessLlmResult("{}"),
      ]);

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal", { skipHumanReview: true });

      expect(result.outcome).toBe("escalated");
      expect(result.escalationContext).toBeDefined();
      expect((result.escalationContext?.length ?? 0) > 0).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 6.1.3 — Plan validation failure
  // -------------------------------------------------------------------------

  describe("plan validation failure", () => {
    it("returns validation-error when generated plan has circular dependencies", async () => {
      const agentLoop = makeAgentLoop();
      const { store } = makeStore();
      const cyclicBody = JSON.stringify({
        goal: "goal",
        tasks: [
          {
            id: "task-1",
            title: "Task",
            status: "pending",
            steps: [
              { id: "step-a", description: "A", status: "pending", dependsOn: ["step-b"], statusHistory: [] },
              { id: "step-b", description: "B", status: "pending", dependsOn: ["step-a"], statusHistory: [] },
            ],
          },
        ],
      });
      const llm = makeLlmFromResults([makeSuccessLlmResult(cyclicBody)]);

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal", { skipHumanReview: true });

      expect(result.outcome).toBe("validation-error");
    });

    it("returns validation-error when generated plan has duplicate step IDs", async () => {
      const agentLoop = makeAgentLoop();
      const { store } = makeStore();
      const dupBody = JSON.stringify({
        goal: "goal",
        tasks: [
          {
            id: "task-1",
            title: "Task",
            status: "pending",
            steps: [
              { id: "dup", description: "A", status: "pending", dependsOn: [], statusHistory: [] },
              { id: "dup", description: "B", status: "pending", dependsOn: [], statusHistory: [] },
            ],
          },
        ],
      });
      const llm = makeLlmFromResults([makeSuccessLlmResult(dupBody)]);

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal", { skipHumanReview: true });

      expect(result.outcome).toBe("validation-error");
    });

    it("does not persist the plan when validation fails", async () => {
      const agentLoop = makeAgentLoop();
      const { store, saves } = makeStore();
      const cyclicBody = JSON.stringify({
        goal: "goal",
        tasks: [
          {
            id: "task-1",
            title: "Task",
            status: "pending",
            steps: [
              { id: "x", description: "X", status: "pending", dependsOn: ["y"], statusHistory: [] },
              { id: "y", description: "Y", status: "pending", dependsOn: ["x"], statusHistory: [] },
            ],
          },
        ],
      });
      const llm = makeLlmFromResults([makeSuccessLlmResult(cyclicBody)]);

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      await service.run("goal", { skipHumanReview: true });

      expect(saves).toHaveLength(0);
    });

    it("validation-error result includes the invalid plan", async () => {
      const agentLoop = makeAgentLoop();
      const { store } = makeStore();
      const dupBody = JSON.stringify({
        goal: "my goal",
        tasks: [
          {
            id: "task-1",
            title: "Task",
            status: "pending",
            steps: [
              { id: "dup", description: "A", status: "pending", dependsOn: [], statusHistory: [] },
              { id: "dup", description: "B", status: "pending", dependsOn: [], statusHistory: [] },
            ],
          },
        ],
      });
      const llm = makeLlmFromResults([makeSuccessLlmResult(dupBody)]);

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("my goal", { skipHumanReview: true });

      expect(result.outcome).toBe("validation-error");
      expect(result.plan).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // 6.1.4 — Stop signal halts after current step without aborting mid-step
  // -------------------------------------------------------------------------

  describe("stop signal halts after current step", () => {
    it("halts execution after the current step completes when stop() is called during execution", async () => {
      let serviceRef: TaskPlanningService | undefined;

      // 3-step plan; stop after step-1 completes
      const { agentLoop } = makeBooleanAgentLoop([]);
      // Override run to call stop during step-1
      const originalRun = agentLoop.run.bind(agentLoop);
      let stepCount = 0;
      const trackingAgentLoop = {
        ...agentLoop,
        async run(task: string, opts?: unknown) {
          stepCount++;
          if (stepCount === 1) {
            // Signal stop while step-1 is "executing"
            serviceRef?.stop();
          }
          return originalRun(task, opts as never);
        },
        stop() {},
        getState() {
          return null;
        },
      };

      const { store } = makeStore();
      const llm = makeLlmFromResults([
        makeSuccessLlmResult(
          makePlanBody([
            { id: "step-1" },
            { id: "step-2", dependsOn: ["step-1"] },
            { id: "step-3", dependsOn: ["step-2"] },
          ]),
        ),
      ]);

      serviceRef = new TaskPlanningService(trackingAgentLoop, makeContextBuilder(), llm, store);
      const result = await serviceRef.run("goal", { skipHumanReview: true });

      // Should not be completed (not all 3 steps ran), but must return a result
      expect(result).toBeDefined();
      // step-1 completed (we stopped after it); step-2 and step-3 should not have started
      expect(stepCount).toBe(1);
    });

    it("does not throw when stop() is called during execution", async () => {
      let serviceRef: TaskPlanningService | undefined;

      const { agentLoop } = makeBooleanAgentLoop([]);
      const originalRun = agentLoop.run.bind(agentLoop);
      const interruptingAgentLoop = {
        ...agentLoop,
        async run(task: string, opts?: unknown) {
          serviceRef?.stop();
          return originalRun(task, opts as never);
        },
        stop() {},
        getState() {
          return null;
        },
      };

      const { store } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makePlanBody())]);

      serviceRef = new TaskPlanningService(interruptingAgentLoop, makeContextBuilder(), llm, store);

      await expect(serviceRef.run("goal", { skipHumanReview: true })).resolves.toBeDefined();
    });

    it("stop flag is cleared on the next run() call", async () => {
      const agentLoop = makeAgentLoop();
      const llm = makeLlmFromResults([
        makeSuccessLlmResult(makePlanBody()),
        makeSuccessLlmResult(makePlanBody()),
      ]);
      const { store } = makeStore();
      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);

      // Signal stop before running — run() clears the flag at the start of each call
      service.stop();
      const result = await service.run("goal", { skipHumanReview: true });

      // The run must complete normally; the stop flag from before the call must not block execution
      expect(result.outcome).toBe("completed");
    });
  });
});
