import type { IWorkflowEventBus, IWorkflowStateStore, WorkflowEvent } from "@/application/ports/workflow";
import { type WorkflowPhase, type WorkflowState, type WorkflowStatus } from "@/domain/workflow/types";
import { describe, expect, it } from "bun:test";

describe("WorkflowState shape", () => {
  it("accepts a valid running state", () => {
    const state: WorkflowState = {
      specName: "my-feature",
      currentPhase: "SPEC_INIT",
      completedPhases: [],
      status: "running",
      startedAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };

    expect(state.specName).toBe("my-feature");
    expect(state.currentPhase).toBe("SPEC_INIT");
    expect(state.completedPhases).toHaveLength(0);
    expect(state.status).toBe("running");
    expect(state.failureDetail).toBeUndefined();
  });

  it("accepts a paused_for_approval state where currentPhase is the just-completed phase", () => {
    // Invariant: when paused_for_approval, currentPhase holds the phase that triggered the pause
    const state: WorkflowState = {
      specName: "my-feature",
      currentPhase: "HUMAN_INTERACTION",
      completedPhases: ["SPEC_INIT", "HUMAN_INTERACTION"],
      status: "paused_for_approval",
      startedAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T01:00:00Z",
    };

    expect(state.status).toBe("paused_for_approval");
    expect(state.currentPhase).toBe("HUMAN_INTERACTION");
    expect(state.completedPhases).toContain("HUMAN_INTERACTION");
  });

  it("accepts a failed state with failureDetail", () => {
    const state: WorkflowState = {
      specName: "my-feature",
      currentPhase: "SPEC_DESIGN",
      completedPhases: ["SPEC_INIT", "HUMAN_INTERACTION"],
      status: "failed",
      failureDetail: { phase: "SPEC_DESIGN", error: "LLM API error" },
      startedAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T02:00:00Z",
    };

    expect(state.status).toBe("failed");
    expect(state.failureDetail?.phase).toBe("SPEC_DESIGN");
    expect(state.failureDetail?.error).toBe("LLM API error");
  });

  it("accepts a completed state", () => {
    const allPhases: WorkflowPhase[] = [
      "SPEC_INIT", "HUMAN_INTERACTION", "VALIDATE_PREREQUISITES", "SPEC_REQUIREMENTS",
      "VALIDATE_REQUIREMENTS", "REFLECT_BEFORE_DESIGN", "VALIDATE_GAP", "SPEC_DESIGN",
      "VALIDATE_DESIGN", "REFLECT_BEFORE_TASKS", "SPEC_TASKS", "VALIDATE_TASKS",
      "IMPLEMENTATION", "PULL_REQUEST",
    ];
    const state: WorkflowState = {
      specName: "my-feature",
      currentPhase: "PULL_REQUEST",
      completedPhases: allPhases,
      status: "completed",
      startedAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T10:00:00Z",
    };

    expect(state.status).toBe("completed");
    expect(state.completedPhases).toHaveLength(14);
  });
});

describe("WorkflowEvent discriminated union", () => {
  it("narrows phase:start event correctly", () => {
    const event: WorkflowEvent = {
      type: "phase:start",
      phase: "SPEC_REQUIREMENTS",
      timestamp: "2026-01-01T00:00:00Z",
    };

    if (event.type === "phase:start") {
      expect(event.phase).toBe("SPEC_REQUIREMENTS");
      expect(event.timestamp).toBe("2026-01-01T00:00:00Z");
    } else {
      throw new Error("Expected phase:start event");
    }
  });

  it("narrows phase:complete event correctly", () => {
    const event: WorkflowEvent = {
      type: "phase:complete",
      phase: "SPEC_REQUIREMENTS",
      durationMs: 5000,
      artifacts: ["requirements.md"],
    };

    if (event.type === "phase:complete") {
      expect(event.durationMs).toBe(5000);
      expect(event.artifacts).toContain("requirements.md");
    } else {
      throw new Error("Expected phase:complete event");
    }
  });

  it("narrows phase:error event correctly", () => {
    const event: WorkflowEvent = {
      type: "phase:error",
      phase: "SPEC_DESIGN",
      operation: "generateDesign",
      error: "timeout",
    };

    if (event.type === "phase:error") {
      expect(event.operation).toBe("generateDesign");
      expect(event.error).toBe("timeout");
    } else {
      throw new Error("Expected phase:error event");
    }
  });

  it("narrows approval:required event correctly", () => {
    const event: WorkflowEvent = {
      type: "approval:required",
      phase: "SPEC_REQUIREMENTS",
      artifactPath: ".kiro/specs/my-feature/requirements.md",
      instruction: "Review and set approvals.requirements.approved = true",
    };

    if (event.type === "approval:required") {
      expect(event.artifactPath).toContain("requirements.md");
      expect(event.instruction).toContain("approved");
    } else {
      throw new Error("Expected approval:required event");
    }
  });

  it("narrows workflow:complete event correctly", () => {
    const event: WorkflowEvent = {
      type: "workflow:complete",
      completedPhases: ["SPEC_INIT", "SPEC_REQUIREMENTS"],
    };

    if (event.type === "workflow:complete") {
      expect(event.completedPhases).toHaveLength(2);
    } else {
      throw new Error("Expected workflow:complete event");
    }
  });

  it("narrows workflow:failed event correctly", () => {
    const event: WorkflowEvent = {
      type: "workflow:failed",
      phase: "SPEC_TASKS",
      error: "sdd binary not found",
    };

    if (event.type === "workflow:failed") {
      expect(event.phase).toBe("SPEC_TASKS");
      expect(event.error).toBe("sdd binary not found");
    } else {
      throw new Error("Expected workflow:failed event");
    }
  });
});

describe("IWorkflowStateStore contract (mock implementation)", () => {
  it("can be implemented by a mock and used against the interface", async () => {
    const stored: WorkflowState[] = [];

    const store: IWorkflowStateStore = {
      init(specName: string): WorkflowState {
        return {
          specName,
          currentPhase: "SPEC_INIT",
          completedPhases: [],
          status: "running",
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      },
      async persist(state: WorkflowState): Promise<void> {
        stored.push(state);
      },
      async restore(specName: string): Promise<WorkflowState | null> {
        return stored.findLast(s => s.specName === specName) ?? null;
      },
    };

    const initial = store.init("test-spec");
    expect(initial.currentPhase).toBe("SPEC_INIT");
    expect(initial.status).toBe("running");

    await store.persist(initial);
    const restored = await store.restore("test-spec");
    expect(restored?.specName).toBe("test-spec");

    const missing = await store.restore("nonexistent");
    expect(missing).toBeNull();
  });
});

describe("IWorkflowEventBus contract (mock implementation)", () => {
  it("can be implemented by a mock and used against the interface", () => {
    const received: WorkflowEvent[] = [];

    const bus: IWorkflowEventBus = {
      emit(event: WorkflowEvent): void {
        for (const handler of handlers) {
          handler(event);
        }
      },
      on(handler: (event: WorkflowEvent) => void): void {
        handlers.push(handler);
      },
      off(handler: (event: WorkflowEvent) => void): void {
        const idx = handlers.indexOf(handler);
        if (idx !== -1) handlers.splice(idx, 1);
      },
    };
    const handlers: Array<(event: WorkflowEvent) => void> = [];

    const collector = (e: WorkflowEvent) => received.push(e);
    bus.on(collector);

    bus.emit({ type: "phase:start", phase: "SPEC_INIT", timestamp: new Date().toISOString() });
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe("phase:start");

    bus.off(collector);
    bus.emit({ type: "workflow:complete", completedPhases: [] });
    expect(received).toHaveLength(1); // handler removed, no new event
  });
});

describe("WorkflowEvent discriminated union — IMPLEMENTATION phase (task 5.1)", () => {
  it("phase:start event accepts IMPLEMENTATION phase", () => {
    const event: WorkflowEvent = {
      type: "phase:start",
      phase: "IMPLEMENTATION",
      timestamp: "2026-01-01T00:00:00Z",
    };

    if (event.type === "phase:start") {
      expect(event.phase).toBe("IMPLEMENTATION");
      expect(event.timestamp).toBe("2026-01-01T00:00:00Z");
    } else {
      throw new Error("Expected phase:start event");
    }
  });

  it("phase:complete event accepts IMPLEMENTATION phase", () => {
    const event: WorkflowEvent = {
      type: "phase:complete",
      phase: "IMPLEMENTATION",
      durationMs: 12000,
      artifacts: [],
    };

    if (event.type === "phase:complete") {
      expect(event.phase).toBe("IMPLEMENTATION");
      expect(event.durationMs).toBe(12000);
      expect(event.artifacts).toHaveLength(0);
    } else {
      throw new Error("Expected phase:complete event");
    }
  });

  it("phase:error event accepts IMPLEMENTATION phase", () => {
    const event: WorkflowEvent = {
      type: "phase:error",
      phase: "IMPLEMENTATION",
      operation: "ImplementationLoopService.run",
      error: "section-failed",
    };

    if (event.type === "phase:error") {
      expect(event.phase).toBe("IMPLEMENTATION");
      expect(event.operation).toBe("ImplementationLoopService.run");
      expect(event.error).toBe("section-failed");
    } else {
      throw new Error("Expected phase:error event");
    }
  });

  it("IMPLEMENTATION is a valid WorkflowPhase string", () => {
    // WorkflowPhase is now a string alias — any string is assignable at runtime.
    // Type-level check: assign to WorkflowPhase without cast.
    const phase: WorkflowPhase = "IMPLEMENTATION";
    expect(phase).toBe("IMPLEMENTATION");
  });
});

// Compile-time checks: ensure all WorkflowStatus values are recognised
const _exhaustiveStatusCheck = (status: WorkflowStatus): string => {
  switch (status) {
    case "running":
      return "running";
    case "paused_for_approval":
      return "paused";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
  }
};
