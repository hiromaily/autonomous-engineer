import { describe, it, expect } from "bun:test";
import { validateFrameworkDefinition } from "@/domain/workflow/framework";
import { makeFrameworkDef } from "../helpers/workflow";

describe("validateFrameworkDefinition - loopPhases", () => {
  it("accepts valid loop-phases", () => {
    const def = makeFrameworkDef({
      loopPhases: [
        { phase: "SPEC_IMPL", type: "llm_slash_command", content: "kiro:spec-impl" },
        { phase: "VALIDATE_IMPL", type: "llm_prompt", content: "Review the implementation of task {taskId}." },
        { phase: "COMMIT", type: "git_command", content: "" },
      ],
    });
    expect(() => validateFrameworkDefinition(def)).not.toThrow();
  });

  it("throws on unknown loop-phase type", () => {
    const def = makeFrameworkDef({
      loopPhases: [
        // Cast to any to simulate a bad YAML-loaded value at runtime
        { phase: "BAD_PHASE", type: "implementation_loop" as never, content: "something" },
      ],
    });
    expect(() => validateFrameworkDefinition(def)).toThrow(
      `Framework "test-fw" phase "IMPLEMENTATION": loop-phases[0] ("BAD_PHASE") has invalid type "implementation_loop". ` +
        `Valid loop phase types: llm_slash_command, llm_prompt, git_command`,
    );
  });

  it("throws on llm_slash_command with empty content", () => {
    const def = makeFrameworkDef({
      loopPhases: [
        { phase: "SPEC_IMPL", type: "llm_slash_command", content: "" },
      ],
    });
    expect(() => validateFrameworkDefinition(def)).toThrow(
      `Framework "test-fw" phase "IMPLEMENTATION": loop-phases[0] ("SPEC_IMPL") ` +
        `(type: llm_slash_command) must have non-empty content`,
    );
  });

  it("throws on llm_prompt with empty content", () => {
    const def = makeFrameworkDef({
      loopPhases: [
        { phase: "VALIDATE_IMPL", type: "llm_prompt", content: "" },
      ],
    });
    expect(() => validateFrameworkDefinition(def)).toThrow(
      `Framework "test-fw" phase "IMPLEMENTATION": loop-phases[0] ("VALIDATE_IMPL") ` +
        `(type: llm_prompt) must have non-empty content`,
    );
  });

  it("accepts git_command with empty content", () => {
    const def = makeFrameworkDef({
      loopPhases: [
        { phase: "COMMIT", type: "git_command", content: "" },
      ],
    });
    expect(() => validateFrameworkDefinition(def)).not.toThrow();
  });

  it("accepts absence of loop-phases (backward compat)", () => {
    const def = makeFrameworkDef();
    expect(() => validateFrameworkDefinition(def)).not.toThrow();
  });
});
