import { validateFrameworkDefinition } from "@/domain/workflow/framework";
import type { FrameworkDefinition } from "@/domain/workflow/framework";
import { WORKFLOW_PHASES } from "@/domain/workflow/types";
import { CC_SDD_FRAMEWORK_DEFINITION } from "@/infra/sdd/cc-sdd-framework-definition";
import { describe, expect, it } from "bun:test";

describe("CC_SDD_FRAMEWORK_DEFINITION", () => {
  it("has id 'cc-sdd'", () => {
    expect(CC_SDD_FRAMEWORK_DEFINITION.id).toBe("cc-sdd");
  });

  it("has exactly 14 phases", () => {
    expect(CC_SDD_FRAMEWORK_DEFINITION.phases).toHaveLength(14);
  });

  it("defines phases in WORKFLOW_PHASES order", () => {
    const phaseNames = CC_SDD_FRAMEWORK_DEFINITION.phases.map((p) => p.phase);
    expect(phaseNames).toEqual([...WORKFLOW_PHASES]);
  });

  it("has exactly 6 llm_slash_command phases", () => {
    const count = CC_SDD_FRAMEWORK_DEFINITION.phases.filter(
      (p) => p.type === "llm_slash_command",
    ).length;
    expect(count).toBe(6);
  });

  it("has exactly 5 llm_prompt phases", () => {
    const count = CC_SDD_FRAMEWORK_DEFINITION.phases.filter(
      (p) => p.type === "llm_prompt",
    ).length;
    expect(count).toBe(5);
  });

  it("has exactly 1 human_interaction phase", () => {
    const count = CC_SDD_FRAMEWORK_DEFINITION.phases.filter(
      (p) => p.type === "human_interaction",
    ).length;
    expect(count).toBe(1);
  });

  it("has exactly 1 implementation_loop phase", () => {
    const count = CC_SDD_FRAMEWORK_DEFINITION.phases.filter(
      (p) => p.type === "implementation_loop",
    ).length;
    expect(count).toBe(1);
  });

  it("has exactly 1 git_command phase", () => {
    const count = CC_SDD_FRAMEWORK_DEFINITION.phases.filter(
      (p) => p.type === "git_command",
    ).length;
    expect(count).toBe(1);
  });

  it("passes validateFrameworkDefinition without throwing", () => {
    expect(() => validateFrameworkDefinition(CC_SDD_FRAMEWORK_DEFINITION)).not.toThrow();
  });

  it.each(
    [
      ["SPEC_INIT", "kiro:spec-init"],
      ["SPEC_REQUIREMENTS", "kiro:spec-requirements"],
      ["VALIDATE_GAP", "kiro:validate-gap"],
      ["SPEC_DESIGN", "kiro:spec-design"],
      ["VALIDATE_DESIGN", "kiro:validate-design"],
      ["SPEC_TASKS", "kiro:spec-tasks"],
    ] as const,
  )("%s has content '%s'", (phase, expectedContent) => {
    const p = CC_SDD_FRAMEWORK_DEFINITION.phases.find((x) => x.phase === phase);
    expect(p?.content).toBe(expectedContent);
  });

  it("all llm_prompt phases have non-empty content", () => {
    for (const p of CC_SDD_FRAMEWORK_DEFINITION.phases) {
      if (p.type === "llm_prompt") {
        expect(p.content.length).toBeGreaterThan(0);
      }
    }
  });

  it("llm_prompt phases use {specDir} placeholder in content", () => {
    for (const p of CC_SDD_FRAMEWORK_DEFINITION.phases) {
      if (p.type === "llm_prompt") {
        expect(p.content).toContain("{specDir}");
      }
    }
  });

  it("all llm_prompt phases have an outputFile set", () => {
    for (const p of CC_SDD_FRAMEWORK_DEFINITION.phases) {
      if (p.type === "llm_prompt") {
        expect(p.outputFile).toBeDefined();
        expect((p.outputFile ?? "").length).toBeGreaterThan(0);
      }
    }
  });

  it.each(
    [
      ["VALIDATE_PREREQUISITES", "prerequisite-check.md"],
      ["VALIDATE_REQUIREMENTS", "validation-requirements.md"],
      ["REFLECT_BEFORE_DESIGN", "reflect-before-design.md"],
      ["REFLECT_BEFORE_TASKS", "reflect-before-tasks.md"],
      ["VALIDATE_TASKS", "validation-tasks.md"],
    ] as const,
  )("%s has outputFile '%s'", (phase, expectedFile) => {
    const p = CC_SDD_FRAMEWORK_DEFINITION.phases.find((x) => x.phase === phase);
    expect(p?.outputFile).toBe(expectedFile);
  });

  // -- requiredArtifacts: phases with no prerequisites --

  it.each(["SPEC_INIT", "HUMAN_INTERACTION", "PULL_REQUEST"] as const)(
    "%s has empty requiredArtifacts",
    (phase) => {
      const p = CC_SDD_FRAMEWORK_DEFINITION.phases.find((x) => x.phase === phase);
      expect(p?.requiredArtifacts).toHaveLength(0);
    },
  );

  // -- requiredArtifacts mirrors REQUIRED_ARTIFACTS from workflow-engine.ts --

  it("VALIDATE_PREREQUISITES requires requirements.md", () => {
    const p = CC_SDD_FRAMEWORK_DEFINITION.phases.find((x) => x.phase === "VALIDATE_PREREQUISITES");
    expect(p?.requiredArtifacts).toContain("requirements.md");
  });

  it("SPEC_REQUIREMENTS requires requirements.md", () => {
    const p = CC_SDD_FRAMEWORK_DEFINITION.phases.find((x) => x.phase === "SPEC_REQUIREMENTS");
    expect(p?.requiredArtifacts).toContain("requirements.md");
  });

  it("VALIDATE_REQUIREMENTS requires requirements.md", () => {
    const p = CC_SDD_FRAMEWORK_DEFINITION.phases.find((x) => x.phase === "VALIDATE_REQUIREMENTS");
    expect(p?.requiredArtifacts).toContain("requirements.md");
  });

  it("REFLECT_BEFORE_DESIGN requires requirements.md", () => {
    const p = CC_SDD_FRAMEWORK_DEFINITION.phases.find((x) => x.phase === "REFLECT_BEFORE_DESIGN");
    expect(p?.requiredArtifacts).toContain("requirements.md");
  });

  it("VALIDATE_GAP requires requirements.md", () => {
    const p = CC_SDD_FRAMEWORK_DEFINITION.phases.find((x) => x.phase === "VALIDATE_GAP");
    expect(p?.requiredArtifacts).toContain("requirements.md");
  });

  it("SPEC_DESIGN requires requirements.md", () => {
    const p = CC_SDD_FRAMEWORK_DEFINITION.phases.find((x) => x.phase === "SPEC_DESIGN");
    expect(p?.requiredArtifacts).toContain("requirements.md");
  });

  it("VALIDATE_DESIGN requires design.md", () => {
    const p = CC_SDD_FRAMEWORK_DEFINITION.phases.find((x) => x.phase === "VALIDATE_DESIGN");
    expect(p?.requiredArtifacts).toContain("design.md");
  });

  it("REFLECT_BEFORE_TASKS requires design.md", () => {
    const p = CC_SDD_FRAMEWORK_DEFINITION.phases.find((x) => x.phase === "REFLECT_BEFORE_TASKS");
    expect(p?.requiredArtifacts).toContain("design.md");
  });

  it("SPEC_TASKS requires design.md", () => {
    const p = CC_SDD_FRAMEWORK_DEFINITION.phases.find((x) => x.phase === "SPEC_TASKS");
    expect(p?.requiredArtifacts).toContain("design.md");
  });

  it("VALIDATE_TASKS requires tasks.md", () => {
    const p = CC_SDD_FRAMEWORK_DEFINITION.phases.find((x) => x.phase === "VALIDATE_TASKS");
    expect(p?.requiredArtifacts).toContain("tasks.md");
  });

  it("IMPLEMENTATION requires tasks.md", () => {
    const p = CC_SDD_FRAMEWORK_DEFINITION.phases.find((x) => x.phase === "IMPLEMENTATION");
    expect(p?.requiredArtifacts).toContain("tasks.md");
  });

  // -- approvalGate mirrors APPROVAL_GATE_PHASES from workflow-engine.ts --

  it("HUMAN_INTERACTION has approvalGate 'human_interaction'", () => {
    const p = CC_SDD_FRAMEWORK_DEFINITION.phases.find((x) => x.phase === "HUMAN_INTERACTION");
    expect(p?.approvalGate).toBe("human_interaction");
  });

  it("SPEC_REQUIREMENTS has approvalGate 'requirements'", () => {
    const p = CC_SDD_FRAMEWORK_DEFINITION.phases.find((x) => x.phase === "SPEC_REQUIREMENTS");
    expect(p?.approvalGate).toBe("requirements");
  });

  it("VALIDATE_DESIGN has approvalGate 'design'", () => {
    const p = CC_SDD_FRAMEWORK_DEFINITION.phases.find((x) => x.phase === "VALIDATE_DESIGN");
    expect(p?.approvalGate).toBe("design");
  });

  it("SPEC_TASKS has approvalGate 'tasks'", () => {
    const p = CC_SDD_FRAMEWORK_DEFINITION.phases.find((x) => x.phase === "SPEC_TASKS");
    expect(p?.approvalGate).toBe("tasks");
  });

  it("phases with no approvalGate have undefined approvalGate", () => {
    const phasesWithNoGate = [
      "SPEC_INIT",
      "VALIDATE_PREREQUISITES",
      "VALIDATE_REQUIREMENTS",
      "REFLECT_BEFORE_DESIGN",
      "VALIDATE_GAP",
      "SPEC_DESIGN",
      "REFLECT_BEFORE_TASKS",
      "VALIDATE_TASKS",
      "IMPLEMENTATION",
      "PULL_REQUEST",
    ];
    for (const name of phasesWithNoGate) {
      const p = CC_SDD_FRAMEWORK_DEFINITION.phases.find((x) => x.phase === name);
      expect(p?.approvalGate).toBeUndefined();
    }
  });
});

// -- validateFrameworkDefinition failure cases --------------------------------

describe("validateFrameworkDefinition — failure cases", () => {
  it("throws when two PhaseDefinition entries have the same phase value", () => {
    const def: FrameworkDefinition = {
      id: "dup-fw",
      phases: [
        { phase: "SPEC_INIT", type: "llm_slash_command", content: "kiro:spec-init", requiredArtifacts: [] },
        { phase: "SPEC_INIT", type: "llm_slash_command", content: "kiro:spec-init", requiredArtifacts: [] },
      ],
    };
    expect(() => validateFrameworkDefinition(def)).toThrow("SPEC_INIT");
  });

  it("throws when content is empty and type is llm_slash_command", () => {
    const def: FrameworkDefinition = {
      id: "empty-cmd-fw",
      phases: [
        { phase: "SPEC_INIT", type: "llm_slash_command", content: "", requiredArtifacts: [] },
      ],
    };
    expect(() => validateFrameworkDefinition(def)).toThrow("llm_slash_command");
  });

  it("throws when content is empty and type is llm_prompt", () => {
    const def: FrameworkDefinition = {
      id: "empty-prompt-fw",
      phases: [
        { phase: "VALIDATE_PREREQUISITES", type: "llm_prompt", content: "", requiredArtifacts: [] },
      ],
    };
    expect(() => validateFrameworkDefinition(def)).toThrow("llm_prompt");
  });
});
