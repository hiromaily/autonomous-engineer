import { beforeEach, describe, expect, it } from "bun:test";
import { TaskPlanningService } from "../../../application/planning/task-planning-service";
import type { IAgentLoop } from "../../../application/ports/agent-loop";
import type { LlmProviderPort } from "../../../application/ports/llm";
import type { IPlanContextBuilder, ITaskPlanStore, TaskPlanResult } from "../../../application/ports/task-planning";
import {
  makeAgentLoop,
  makeContextBuilder,
  makeFailureLlmResult,
  makeLlmFromResults,
  makePlanBody,
  makeStore,
  makeSuccessLlmResult,
} from "./fixtures";

// ---------------------------------------------------------------------------
// Task 5.1 — Plan Generation Pipeline
// ---------------------------------------------------------------------------

describe("TaskPlanningService — task 5.1: plan generation pipeline", () => {
  let agentLoop: IAgentLoop;

  beforeEach(() => {
    agentLoop = makeAgentLoop();
  });

  // -------------------------------------------------------------------------
  // 5.1.1 — Context builder integration
  // -------------------------------------------------------------------------

  describe("context assembly", () => {
    it("calls buildPlanContext with the provided goal", async () => {
      let capturedGoal: string | undefined;
      const contextBuilder: IPlanContextBuilder = {
        async buildPlanContext(goal: string) {
          capturedGoal = goal;
          return "plan context";
        },
        async buildRevisionContext() {
          return "";
        },
      };

      const { store } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makePlanBody())]);

      const service = new TaskPlanningService(agentLoop, contextBuilder, llm, store);
      await service.run("Implement feature X");

      expect(capturedGoal).toBe("Implement feature X");
    });

    it("passes the context string to the LLM complete() call", async () => {
      let capturedPrompt: string | undefined;
      const contextBuilder = makeContextBuilder("my-special-context");
      const llm: LlmProviderPort = {
        async complete(prompt: string) {
          capturedPrompt = prompt;
          return makeSuccessLlmResult(makePlanBody());
        },
        clearContext() {},
      };

      const { store } = makeStore();
      const service = new TaskPlanningService(agentLoop, contextBuilder, llm, store);
      await service.run("goal");

      expect(capturedPrompt).toBe("my-special-context");
    });

    it("uses a fallback prompt containing the goal when contextBuilder throws", async () => {
      let capturedPrompt: string | undefined;
      const failingContextBuilder: IPlanContextBuilder = {
        async buildPlanContext(): Promise<string> {
          throw new Error("context engine unavailable");
        },
        async buildRevisionContext() {
          return "";
        },
      };
      const llm: LlmProviderPort = {
        async complete(prompt: string) {
          capturedPrompt = prompt;
          return makeSuccessLlmResult(makePlanBody());
        },
        clearContext() {},
      };

      const { store } = makeStore();
      const service = new TaskPlanningService(agentLoop, failingContextBuilder, llm, store);
      await service.run("Implement auth system");

      // Fallback prompt must contain the goal so the LLM knows what to plan for
      expect(capturedPrompt).toContain("Implement auth system");
    });
  });

  // -------------------------------------------------------------------------
  // 5.1.2 — Plan parsing and UUID assignment
  // -------------------------------------------------------------------------

  describe("plan parsing and ID assignment", () => {
    it("assigns a new UUID planId to the parsed plan", async () => {
      const { store, saves } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makePlanBody())]);

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal");

      expect(result.plan.id).toBeDefined();
      // Must be a UUID v4 format
      expect(result.plan.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it("different runs produce different plan IDs", async () => {
      const llm1 = makeLlmFromResults([makeSuccessLlmResult(makePlanBody())]);
      const llm2 = makeLlmFromResults([makeSuccessLlmResult(makePlanBody())]);
      const { store: store1 } = makeStore();
      const { store: store2 } = makeStore();

      const service1 = new TaskPlanningService(agentLoop, makeContextBuilder(), llm1, store1);
      const service2 = new TaskPlanningService(agentLoop, makeContextBuilder(), llm2, store2);

      const result1 = await service1.run("goal");
      const result2 = await service2.run("goal");

      expect(result1.plan.id).not.toBe(result2.plan.id);
    });

    it("the plan returned in the result has correct timestamps", async () => {
      const before = new Date().toISOString();
      const { store } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makePlanBody())]);

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal");
      const after = new Date().toISOString();

      expect(result.plan.createdAt >= before).toBe(true);
      expect(result.plan.createdAt <= after).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 5.1.3 — Persistence
  // -------------------------------------------------------------------------

  describe("persistence", () => {
    it("saves the validated plan to the store after successful generation", async () => {
      const { store, saves } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makePlanBody())]);

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      await service.run("goal");

      // At least the initial generation save must occur; execution may add more
      expect(saves.length).toBeGreaterThanOrEqual(1);
      expect(saves[0]?.goal).toBe("Implement feature X");
    });

    it("the saved plan matches the plan returned in the result", async () => {
      const { store, saves } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makePlanBody())]);

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal");

      expect(saves[0]?.id).toBe(result.plan.id);
    });

    it("returns escalated outcome when store.save() throws", async () => {
      const failingStore: ITaskPlanStore = {
        async save() {
          throw new Error("disk full");
        },
        async load() {
          return null;
        },
        async listResumable() {
          return [];
        },
      };

      const llm = makeLlmFromResults([makeSuccessLlmResult(makePlanBody())]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        llm,
        failingStore,
      );
      const result = await service.run("goal");

      expect(result.outcome).toBe("escalated");
      expect(result.escalationContext).toContain("disk full");
    });

    it("does not save the plan when validation fails", async () => {
      const cyclicBody = JSON.stringify({
        goal: "cyclic goal",
        tasks: [
          {
            id: "task-1",
            title: "Task",
            status: "pending",
            steps: [
              {
                id: "step-a",
                description: "Step A",
                status: "pending",
                dependsOn: ["step-b"],
                statusHistory: [],
              },
              {
                id: "step-b",
                description: "Step B",
                status: "pending",
                dependsOn: ["step-a"],
                statusHistory: [],
              },
            ],
          },
        ],
      });

      const { store, saves } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(cyclicBody)]);
      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      await service.run("goal");

      expect(saves).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 5.1.4 — Validation
  // -------------------------------------------------------------------------

  describe("plan validation", () => {
    it("returns validation-error outcome when generated plan has circular dependencies", async () => {
      const cyclicBody = JSON.stringify({
        goal: "cyclic goal",
        tasks: [
          {
            id: "task-1",
            title: "Task",
            status: "pending",
            steps: [
              {
                id: "step-a",
                description: "Step A",
                status: "pending",
                dependsOn: ["step-b"],
                statusHistory: [],
              },
              {
                id: "step-b",
                description: "Step B",
                status: "pending",
                dependsOn: ["step-a"],
                statusHistory: [],
              },
            ],
          },
        ],
      });

      const { store } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(cyclicBody)]);
      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal");

      expect(result.outcome).toBe("validation-error");
    });

    it("returns validation-error outcome when generated plan has duplicate step IDs", async () => {
      const dupBody = JSON.stringify({
        goal: "dup goal",
        tasks: [
          {
            id: "task-1",
            title: "Task",
            status: "pending",
            steps: [
              {
                id: "step-a",
                description: "Step A",
                status: "pending",
                dependsOn: [],
                statusHistory: [],
              },
              {
                id: "step-a",
                description: "Step A duplicate",
                status: "pending",
                dependsOn: [],
                statusHistory: [],
              },
            ],
          },
        ],
      });

      const { store } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(dupBody)]);
      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal");

      expect(result.outcome).toBe("validation-error");
    });

    it("returns validation-error with the invalid plan included in the result", async () => {
      const dupBody = JSON.stringify({
        goal: "dup goal",
        tasks: [
          {
            id: "task-1",
            title: "Task",
            status: "pending",
            steps: [
              {
                id: "dup",
                description: "Step",
                status: "pending",
                dependsOn: [],
                statusHistory: [],
              },
              {
                id: "dup",
                description: "Step duplicate",
                status: "pending",
                dependsOn: [],
                statusHistory: [],
              },
            ],
          },
        ],
      });

      const { store } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(dupBody)]);
      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal");

      expect(result.outcome).toBe("validation-error");
      expect(result.plan).toBeDefined();
    });

    it("returns completed outcome for a valid plan (no validation errors)", async () => {
      const { store } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makePlanBody())]);
      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal");

      expect(result.outcome).toBe("completed");
    });
  });

  // -------------------------------------------------------------------------
  // 5.1.5 — Parse retry logic
  // -------------------------------------------------------------------------

  describe("parse retry logic", () => {
    it("retries when the LLM returns unparseable JSON, succeeds on second attempt", async () => {
      const { store, saves } = makeStore();
      const llm = makeLlmFromResults([
        makeSuccessLlmResult("not valid json"),
        makeSuccessLlmResult(makePlanBody()),
      ]);

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal");

      expect(result.outcome).toBe("completed");
      expect(saves.length).toBeGreaterThanOrEqual(1);
    });

    it("retries when the LLM returns an error response, succeeds on second attempt", async () => {
      const { store, saves } = makeStore();
      const llm = makeLlmFromResults([
        makeFailureLlmResult("rate limit exceeded"),
        makeSuccessLlmResult(makePlanBody()),
      ]);

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal");

      expect(result.outcome).toBe("completed");
      expect(saves.length).toBeGreaterThanOrEqual(1);
    });

    it("returns escalated outcome after exhausting all parse retries (3 failures)", async () => {
      const { store } = makeStore();
      const llm = makeLlmFromResults([
        makeSuccessLlmResult("not json"),
        makeSuccessLlmResult("also not json"),
        makeSuccessLlmResult("still not json"),
      ]);

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal");

      expect(result.outcome).toBe("escalated");
    });

    it("returns escalated outcome after exhausting all retries with LLM errors", async () => {
      const { store } = makeStore();
      const llm = makeLlmFromResults([
        makeFailureLlmResult("error 1"),
        makeFailureLlmResult("error 2"),
        makeFailureLlmResult("error 3"),
      ]);

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal");

      expect(result.outcome).toBe("escalated");
    });

    it("includes escalation context when retries are exhausted", async () => {
      const { store } = makeStore();
      const llm = makeLlmFromResults([
        makeSuccessLlmResult("not json"),
        makeSuccessLlmResult("not json"),
        makeSuccessLlmResult("not json"),
      ]);

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal");

      expect(result.escalationContext).toBeDefined();
      expect(result.escalationContext?.length).toBeGreaterThan(0);
    });

    it("succeeds on the third attempt (max retries boundary)", async () => {
      const { store, saves } = makeStore();
      const llm = makeLlmFromResults([
        makeSuccessLlmResult("not json"),
        makeSuccessLlmResult("not json"),
        makeSuccessLlmResult(makePlanBody()),
      ]);

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal");

      expect(result.outcome).toBe("completed");
      expect(saves.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // 5.1.6 — stop() and listResumable()
  // -------------------------------------------------------------------------

  describe("stop() and listResumable()", () => {
    it("stop() can be called without throwing", () => {
      const { store } = makeStore();
      const llm = makeLlmFromResults([]);
      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);

      expect(() => service.stop()).not.toThrow();
    });

    it("listResumable() delegates to the plan store", async () => {
      const store: ITaskPlanStore = {
        async save() {},
        async load() {
          return null;
        },
        async listResumable() {
          return ["plan-a", "plan-b"];
        },
      };
      const llm = makeLlmFromResults([]);
      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);

      const ids = await service.listResumable();
      expect(ids).toContain("plan-a");
      expect(ids).toContain("plan-b");
    });
  });
});
