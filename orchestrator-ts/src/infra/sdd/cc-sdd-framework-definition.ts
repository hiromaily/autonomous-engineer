import type { FrameworkDefinition } from "@/domain/workflow/framework";

/**
 * Framework definition for the cc-sdd (Claude Code SDD) workflow.
 * Defines all 14 phases in execution order with their types, prompts,
 * required artifacts, and approval gates.
 *
 * This is the single source of truth for cc-sdd workflow configuration,
 * replacing the hardcoded constants (REQUIRED_ARTIFACTS, APPROVAL_GATE_PHASES,
 * WORKFLOW_PHASES) in workflow-engine.ts and phase-runner.ts.
 */
export const CC_SDD_FRAMEWORK_DEFINITION: FrameworkDefinition = {
  id: "cc-sdd",
  phases: [
    {
      phase: "SPEC_INIT",
      type: "llm_slash_command",
      content: "kiro:spec-init",
      requiredArtifacts: [],
    },
    {
      phase: "HUMAN_INTERACTION",
      type: "human_interaction",
      content: "",
      requiredArtifacts: [],
      approvalGate: "human_interaction",
    },
    {
      phase: "VALIDATE_PREREQUISITES",
      type: "llm_prompt",
      content: "Verify that the specification prerequisites are in place for '{specDir}'.\n"
        + "Check that '{specDir}/requirements.md' exists and is non-empty.\n"
        + "If the file is missing or empty, report what is missing and stop.\n"
        + "If the file exists and has content, confirm that prerequisites are satisfied.",
      requiredArtifacts: ["requirements.md"],
      outputFile: "prerequisite-check.md",
    },
    {
      phase: "SPEC_REQUIREMENTS",
      type: "llm_slash_command",
      content: "kiro:spec-requirements",
      requiredArtifacts: ["requirements.md"],
      approvalGate: "requirements",
    },
    {
      phase: "VALIDATE_REQUIREMENTS",
      type: "llm_prompt",
      content: "Review the requirements document at '{specDir}/requirements.md' for completeness and testability.\n"
        + "Check that each requirement is unambiguous, measurable, and independently testable.\n"
        + "Identify any gaps, contradictions, or requirements that cannot be verified by tests.\n"
        + "Provide a structured review report; flag any items that need revision before design begins.",
      requiredArtifacts: ["requirements.md"],
      outputFile: "validation-requirements.md",
    },
    {
      phase: "REFLECT_BEFORE_DESIGN",
      type: "llm_prompt",
      content:
        "Before starting the technical design for '{specDir}', synthesize the key constraints and open questions from '{specDir}/requirements.md'.\n"
        + "Identify the top architectural drivers, non-functional requirements, and any requirements that introduce design risk.\n"
        + "List open questions that the design must resolve, and note any assumptions being made.\n"
        + "This reflection will be used as context when generating the design document.",
      requiredArtifacts: ["requirements.md"],
      outputFile: "reflect-before-design.md",
    },
    {
      phase: "VALIDATE_GAP",
      type: "llm_slash_command",
      content: "kiro:validate-gap",
      requiredArtifacts: ["requirements.md"],
    },
    {
      phase: "SPEC_DESIGN",
      type: "llm_slash_command",
      content: "kiro:spec-design",
      requiredArtifacts: ["requirements.md"],
    },
    {
      phase: "VALIDATE_DESIGN",
      type: "llm_slash_command",
      content: "kiro:validate-design",
      requiredArtifacts: ["design.md"],
      approvalGate: "design",
    },
    {
      phase: "REFLECT_BEFORE_TASKS",
      type: "llm_prompt",
      content:
        "Before generating the implementation task breakdown for '{specDir}', synthesize the key design decisions and patterns from '{specDir}/design.md'.\n"
        + "Identify the major components, interfaces, and their responsibilities as established by the design.\n"
        + "Note any design patterns, constraints, or ordering dependencies that will affect how tasks must be sequenced.\n"
        + "This reflection will be used as context when generating the tasks document.",
      requiredArtifacts: ["design.md"],
      outputFile: "reflect-before-tasks.md",
    },
    {
      phase: "SPEC_TASKS",
      type: "llm_slash_command",
      content: "kiro:spec-tasks",
      requiredArtifacts: ["design.md"],
      approvalGate: "tasks",
    },
    {
      phase: "VALIDATE_TASKS",
      type: "llm_prompt",
      content:
        "Review the implementation task breakdown at '{specDir}/tasks.md' for completeness and implementation readiness.\n"
        + "Check that every requirement from '{specDir}/requirements.md' is covered by at least one task.\n"
        + "Verify that task dependencies are correctly ordered and that no task depends on an unimplemented component.\n"
        + "Confirm that each task is small enough to implement and test independently.\n"
        + "Provide a structured review report; flag any gaps or sequencing issues before implementation begins.",
      requiredArtifacts: ["tasks.md"],
      outputFile: "validation-tasks.md",
    },
    {
      phase: "IMPLEMENTATION",
      type: "implementation_loop",
      content: "",
      requiredArtifacts: ["tasks.md"],
    },
    {
      phase: "PULL_REQUEST",
      type: "git_command",
      content: "",
      requiredArtifacts: [],
    },
  ],
};
