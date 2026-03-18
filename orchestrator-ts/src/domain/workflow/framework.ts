import type { ApprovalPhase } from "@/domain/workflow/approval-gate";
import type { WorkflowPhase } from "@/domain/workflow/types";

export type PhaseExecutionType =
  | "llm_slash_command"
  | "llm_prompt"
  | "human_interaction"
  | "git_command"
  | "implementation_loop";

export interface PhaseDefinition {
  readonly phase: WorkflowPhase;
  readonly type: PhaseExecutionType;
  readonly content: string;
  readonly requiredArtifacts: readonly string[];
  readonly approvalGate?: ApprovalPhase;
}

export interface FrameworkDefinition {
  readonly id: string;
  readonly phases: readonly PhaseDefinition[];
}

/** Returns the PhaseDefinition for the given phase, or undefined if not registered. */
export function findPhaseDefinition(def: FrameworkDefinition, phase: WorkflowPhase): PhaseDefinition | undefined {
  return def.phases.find((p) => p.phase === phase);
}

/**
 * Validates that a FrameworkDefinition is structurally correct.
 * Throws a descriptive error on the first violation found.
 * No return value on success.
 */
export function validateFrameworkDefinition(def: FrameworkDefinition): void {
  const seen = new Set<string>();
  for (const p of def.phases) {
    if (seen.has(p.phase)) {
      throw new Error(
        `Framework definition "${def.id}" has duplicate phase: "${p.phase}"`,
      );
    }
    seen.add(p.phase);

    if ((p.type === "llm_slash_command" || p.type === "llm_prompt") && p.content === "") {
      throw new Error(
        `Framework definition "${def.id}" phase "${p.phase}" (type: ${p.type}) must have non-empty content`,
      );
    }
  }
}
