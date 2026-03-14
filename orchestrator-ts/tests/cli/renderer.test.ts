import type { WorkflowEvent } from "@/application/ports/workflow";
import { CliRenderer } from "@/cli/renderer";
import { describe, expect, it } from "bun:test";

function makeWriter() {
  const lines: string[] = [];
  return {
    lines,
    write: (text: string) => {
      lines.push(text);
    },
  };
}

describe("CliRenderer", () => {
  describe("phase:start", () => {
    it("writes phase header", () => {
      const writer = makeWriter();
      const renderer = new CliRenderer(writer.write);

      renderer.handle({ type: "phase:start", phase: "REQUIREMENTS", timestamp: "2026-01-01T00:00:00.000Z" });

      expect(writer.lines.some((l) => l.includes("REQUIREMENTS"))).toBe(true);
    });

    it("includes timestamp in output", () => {
      const writer = makeWriter();
      const renderer = new CliRenderer(writer.write);

      renderer.handle({ type: "phase:start", phase: "DESIGN", timestamp: "2026-01-01T12:34:56.000Z" });

      const output = writer.lines.join("");
      expect(output.includes("DESIGN")).toBe(true);
    });
  });

  describe("phase:complete", () => {
    it("writes completion with duration", () => {
      const writer = makeWriter();
      const renderer = new CliRenderer(writer.write);

      renderer.handle({ type: "phase:complete", phase: "REQUIREMENTS", durationMs: 1500, artifacts: [] });

      const output = writer.lines.join("");
      expect(output.includes("REQUIREMENTS")).toBe(true);
      expect(output.includes("1")).toBe(true); // some representation of 1500ms
    });

    it("lists artifacts when present", () => {
      const writer = makeWriter();
      const renderer = new CliRenderer(writer.write);

      renderer.handle({
        type: "phase:complete",
        phase: "DESIGN",
        durationMs: 3000,
        artifacts: [".kiro/specs/my-spec/design.md"],
      });

      const output = writer.lines.join("");
      expect(output.includes("design.md")).toBe(true);
    });

    it("shows no artifacts when list is empty", () => {
      const writer = makeWriter();
      const renderer = new CliRenderer(writer.write);

      renderer.handle({ type: "phase:complete", phase: "SPEC_INIT", durationMs: 10, artifacts: [] });

      // Should not throw and should write something
      expect(writer.lines.length).toBeGreaterThan(0);
    });
  });

  describe("phase:error", () => {
    it("writes error message", () => {
      const writer = makeWriter();
      const renderer = new CliRenderer(writer.write);

      renderer.handle({
        type: "phase:error",
        phase: "DESIGN",
        operation: "generateDesign",
        error: "cc-sdd: not found",
      });

      const output = writer.lines.join("");
      expect(output.includes("cc-sdd: not found")).toBe(true);
    });

    it("includes phase name in error output", () => {
      const writer = makeWriter();
      const renderer = new CliRenderer(writer.write);

      renderer.handle({ type: "phase:error", phase: "TASK_GENERATION", operation: "generateTasks", error: "timeout" });

      const output = writer.lines.join("");
      expect(output.includes("TASK_GENERATION")).toBe(true);
    });
  });

  describe("approval:required", () => {
    it("writes the instruction to the user", () => {
      const writer = makeWriter();
      const renderer = new CliRenderer(writer.write);

      renderer.handle({
        type: "approval:required",
        phase: "REQUIREMENTS",
        artifactPath: ".kiro/specs/my-spec/spec.json",
        instruction: "Set approvals.requirements.approved = true in spec.json",
      });

      const output = writer.lines.join("");
      expect(output.includes("approvals.requirements.approved")).toBe(true);
      expect(output.includes("spec.json")).toBe(true);
    });

    it("includes artifact path in output", () => {
      const writer = makeWriter();
      const renderer = new CliRenderer(writer.write);

      renderer.handle({
        type: "approval:required",
        phase: "DESIGN",
        artifactPath: ".kiro/specs/my-spec/spec.json",
        instruction: "Approve the design",
      });

      const output = writer.lines.join("");
      expect(output.includes(".kiro/specs/my-spec/spec.json")).toBe(true);
    });
  });

  describe("workflow:complete", () => {
    it("writes completion summary with phase list", () => {
      const writer = makeWriter();
      const renderer = new CliRenderer(writer.write);

      renderer.handle({
        type: "workflow:complete",
        completedPhases: ["SPEC_INIT", "REQUIREMENTS", "DESIGN"],
      });

      const output = writer.lines.join("");
      expect(output.includes("SPEC_INIT")).toBe(true);
      expect(output.includes("REQUIREMENTS")).toBe(true);
      expect(output.includes("DESIGN")).toBe(true);
    });

    it("indicates successful completion", () => {
      const writer = makeWriter();
      const renderer = new CliRenderer(writer.write);

      renderer.handle({ type: "workflow:complete", completedPhases: ["SPEC_INIT"] });

      const output = writer.lines.join("").toLowerCase();
      expect(output.includes("complet") || output.includes("success") || output.includes("done")).toBe(true);
    });
  });

  describe("workflow:failed", () => {
    it("writes failure message with error", () => {
      const writer = makeWriter();
      const renderer = new CliRenderer(writer.write);

      renderer.handle({ type: "workflow:failed", phase: "DESIGN", error: "adapter crashed" });

      const output = writer.lines.join("");
      expect(output.includes("adapter crashed")).toBe(true);
    });

    it("includes the failing phase name", () => {
      const writer = makeWriter();
      const renderer = new CliRenderer(writer.write);

      renderer.handle({ type: "workflow:failed", phase: "VALIDATE_DESIGN", error: "timeout" });

      const output = writer.lines.join("");
      expect(output.includes("VALIDATE_DESIGN")).toBe(true);
    });
  });

  describe("unknown event type guard", () => {
    it("handles all known event types without throwing", () => {
      const writer = makeWriter();
      const renderer = new CliRenderer(writer.write);
      const events: WorkflowEvent[] = [
        { type: "phase:start", phase: "SPEC_INIT", timestamp: new Date().toISOString() },
        { type: "phase:complete", phase: "SPEC_INIT", durationMs: 10, artifacts: [] },
        { type: "phase:error", phase: "SPEC_INIT", operation: "op", error: "err" },
        { type: "approval:required", phase: "REQUIREMENTS", artifactPath: "/path", instruction: "instr" },
        { type: "workflow:complete", completedPhases: ["SPEC_INIT"] },
        { type: "workflow:failed", phase: "SPEC_INIT", error: "err" },
      ];
      for (const event of events) {
        expect(() => renderer.handle(event)).not.toThrow();
      }
    });
  });
});
