import type { FrameworkDefinitionPort } from "@/application/ports/framework";
import {
  type FrameworkDefinition,
  type PhaseExecutionType,
  validateFrameworkDefinition,
} from "@/domain/workflow/framework";
import { describe, expect, it } from "bun:test";

// Compile-time check: all PhaseExecutionType values are handled exhaustively
const _exhaustivePhaseTypeCheck = (t: PhaseExecutionType): string => {
  switch (t) {
    case "llm_slash_command":
      return "llm_slash_command";
    case "llm_prompt":
      return "llm_prompt";
    case "human_interaction":
      return "human_interaction";
    case "suspension":
      return "suspension";
    case "git_command":
      return "git_command";
    case "implementation_loop":
      return "implementation_loop";
  }
};

// ---- Task 1.1: PhaseExecutionType and FrameworkDefinition shape ----

describe("PhaseExecutionType", () => {
  it("accepts all six execution type literal values", () => {
    const types: PhaseExecutionType[] = [
      "llm_slash_command",
      "llm_prompt",
      "human_interaction",
      "suspension",
      "git_command",
      "implementation_loop",
    ];
    expect(types).toHaveLength(6);
  });
});

describe("FrameworkDefinition shape", () => {
  it("accepts a valid definition with id and phases list", () => {
    const def: FrameworkDefinition = {
      id: "test-fw",
      phases: [
        {
          phase: "SPEC_INIT",
          type: "llm_slash_command",
          content: "kiro:spec-init",
          requiredArtifacts: [],
        },
      ],
    };
    expect(def.id).toBe("test-fw");
    expect(def.phases).toHaveLength(1);
  });

  it("accepts a phase with an optional approvalGate", () => {
    const def: FrameworkDefinition = {
      id: "test-fw",
      phases: [
        {
          phase: "SPEC_REQUIREMENTS",
          type: "llm_slash_command",
          content: "kiro:spec-requirements",
          requiredArtifacts: ["requirements.md"],
          approvalGate: "requirements",
        },
      ],
    };
    expect(def.phases[0]?.approvalGate).toBe("requirements");
  });
});

// ---- Task 1.2: validateFrameworkDefinition ----

describe("validateFrameworkDefinition", () => {
  it("passes for a valid definition with distinct phases and non-empty content", () => {
    const def: FrameworkDefinition = {
      id: "test-fw",
      phases: [
        {
          phase: "SPEC_INIT",
          type: "llm_slash_command",
          content: "kiro:spec-init",
          requiredArtifacts: [],
        },
        {
          phase: "SPEC_REQUIREMENTS",
          type: "llm_slash_command",
          content: "kiro:spec-requirements",
          requiredArtifacts: [],
        },
      ],
    };
    expect(() => validateFrameworkDefinition(def)).not.toThrow();
  });

  it("throws when two phases share the same phase value (duplicate)", () => {
    const def: FrameworkDefinition = {
      id: "test-fw",
      phases: [
        {
          phase: "SPEC_INIT",
          type: "llm_slash_command",
          content: "kiro:spec-init",
          requiredArtifacts: [],
        },
        {
          phase: "SPEC_INIT",
          type: "llm_prompt",
          content: "some prompt text",
          requiredArtifacts: [],
        },
      ],
    };
    expect(() => validateFrameworkDefinition(def)).toThrow(/duplicate/i);
  });

  it("throws when an llm_slash_command phase has empty content", () => {
    const def: FrameworkDefinition = {
      id: "test-fw",
      phases: [
        {
          phase: "SPEC_INIT",
          type: "llm_slash_command",
          content: "",
          requiredArtifacts: [],
        },
      ],
    };
    expect(() => validateFrameworkDefinition(def)).toThrow(/content/i);
  });

  it("throws when an llm_prompt phase has empty content", () => {
    const def: FrameworkDefinition = {
      id: "test-fw",
      phases: [
        {
          phase: "VALIDATE_PREREQUISITES",
          type: "llm_prompt",
          content: "",
          requiredArtifacts: [],
        },
      ],
    };
    expect(() => validateFrameworkDefinition(def)).toThrow(/content/i);
  });

  it("allows empty content for human_interaction phase", () => {
    const def: FrameworkDefinition = {
      id: "test-fw",
      phases: [
        {
          phase: "HUMAN_INTERACTION",
          type: "human_interaction",
          content: "",
          requiredArtifacts: [],
        },
      ],
    };
    expect(() => validateFrameworkDefinition(def)).not.toThrow();
  });

  it("allows empty content for git_command phase", () => {
    const def: FrameworkDefinition = {
      id: "test-fw",
      phases: [
        {
          phase: "PULL_REQUEST",
          type: "git_command",
          content: "",
          requiredArtifacts: [],
        },
      ],
    };
    expect(() => validateFrameworkDefinition(def)).not.toThrow();
  });

  it("allows empty content for implementation_loop phase", () => {
    const def: FrameworkDefinition = {
      id: "test-fw",
      phases: [
        {
          phase: "IMPLEMENTATION",
          type: "implementation_loop",
          content: "",
          requiredArtifacts: [],
        },
      ],
    };
    expect(() => validateFrameworkDefinition(def)).not.toThrow();
  });

  it("throws when a phase has an unknown approvalGate value", () => {
    const def: FrameworkDefinition = {
      id: "test-fw",
      phases: [
        {
          phase: "SPEC_REQUIREMENTS",
          type: "llm_slash_command",
          content: "kiro:spec-requirements",
          requiredArtifacts: [],
          // Cast needed: TypeScript would normally catch the invalid literal at
          // compile time, but we're testing the runtime validation path.
          approvalGate: "not_a_real_gate" as "requirements",
        },
      ],
    };
    expect(() => validateFrameworkDefinition(def)).toThrow(/approvalGate/i);
  });

  it("allows empty content for suspension phase", () => {
    const def: FrameworkDefinition = {
      id: "test-fw",
      phases: [
        {
          phase: "HUMAN_INTERACTION",
          type: "suspension",
          content: "",
          requiredArtifacts: [],
        },
      ],
    };
    expect(() => validateFrameworkDefinition(def)).not.toThrow();
  });
});

// ---- Task 1.3: FrameworkDefinitionPort interface shape ----

describe("FrameworkDefinitionPort contract (mock implementation)", () => {
  it("can be satisfied by a simple in-memory implementation", async () => {
    const defs = new Map<string, FrameworkDefinition>([
      [
        "test-fw",
        {
          id: "test-fw",
          phases: [
            {
              phase: "SPEC_INIT",
              type: "llm_slash_command",
              content: "kiro:spec-init",
              requiredArtifacts: [],
            },
          ],
        },
      ],
    ]);

    const port: FrameworkDefinitionPort = {
      async load(frameworkId: string): Promise<FrameworkDefinition> {
        const def = defs.get(frameworkId);
        if (!def) {
          throw new Error(`Unknown framework: ${frameworkId}. Available: ${[...defs.keys()].join(", ")}`);
        }
        return def;
      },
    };

    const loaded = await port.load("test-fw");
    expect(loaded.id).toBe("test-fw");
    expect(loaded.phases).toHaveLength(1);
  });

  it("throws when framework id is not found", async () => {
    const port: FrameworkDefinitionPort = {
      async load(frameworkId: string): Promise<FrameworkDefinition> {
        throw new Error(`Unknown framework: ${frameworkId}. Available: test-fw`);
      },
    };

    await expect(port.load("unknown-fw")).rejects.toThrow(/unknown/i);
  });
});
