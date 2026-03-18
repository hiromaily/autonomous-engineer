import type { FrameworkDefinition } from "@/domain/workflow/framework";

/**
 * Minimal 14-phase framework definition for unit/integration tests.
 *
 * Uses {specDir} placeholder in llm_prompt content so PhaseRunner interpolation
 * tests can verify correct substitution. Has no approval gates or required
 * artifacts so tests can exercise phase dispatch without extra setup.
 */
export function makeFrameworkDef(): FrameworkDefinition {
  return {
    id: "test-fw",
    phases: [
      { phase: "SPEC_INIT", type: "llm_slash_command", content: "kiro:spec-init", requiredArtifacts: [] },
      { phase: "HUMAN_INTERACTION", type: "human_interaction", content: "", requiredArtifacts: [] },
      {
        phase: "VALIDATE_PREREQUISITES",
        type: "llm_prompt",
        content: "Verify prerequisites for '{specDir}'.",
        requiredArtifacts: [],
      },
      {
        phase: "SPEC_REQUIREMENTS",
        type: "llm_slash_command",
        content: "kiro:spec-requirements",
        requiredArtifacts: [],
      },
      {
        phase: "VALIDATE_REQUIREMENTS",
        type: "llm_prompt",
        content: "Validate requirements at '{specDir}/requirements.md'.",
        requiredArtifacts: [],
      },
      {
        phase: "REFLECT_BEFORE_DESIGN",
        type: "llm_prompt",
        content: "Reflect before design for '{specDir}'.",
        requiredArtifacts: [],
      },
      { phase: "VALIDATE_GAP", type: "llm_slash_command", content: "kiro:validate-gap", requiredArtifacts: [] },
      { phase: "SPEC_DESIGN", type: "llm_slash_command", content: "kiro:spec-design", requiredArtifacts: [] },
      {
        phase: "VALIDATE_DESIGN",
        type: "llm_slash_command",
        content: "kiro:validate-design",
        requiredArtifacts: [],
      },
      {
        phase: "REFLECT_BEFORE_TASKS",
        type: "llm_prompt",
        content: "Reflect before tasks for '{specDir}'.",
        requiredArtifacts: [],
      },
      { phase: "SPEC_TASKS", type: "llm_slash_command", content: "kiro:spec-tasks", requiredArtifacts: [] },
      {
        phase: "VALIDATE_TASKS",
        type: "llm_prompt",
        content: "Validate tasks at '{specDir}/tasks.md'.",
        requiredArtifacts: [],
      },
      { phase: "IMPLEMENTATION", type: "implementation_loop", content: "", requiredArtifacts: [] },
      { phase: "PULL_REQUEST", type: "git_command", content: "", requiredArtifacts: [] },
    ],
  };
}
