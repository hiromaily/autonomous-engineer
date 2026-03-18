import type { ApprovalPhase } from "@/domain/workflow/approval-gate";

export type PhaseExecutionType =
  | "llm_slash_command"
  | "llm_prompt"
  | "human_interaction"
  | "suspension"
  | "git_command"
  | "implementation_loop";

export interface PhaseDefinition {
  readonly phase: string;
  readonly type: PhaseExecutionType;
  readonly content: string;
  readonly requiredArtifacts: readonly string[];
  readonly approvalGate?: ApprovalPhase;
  /** Overrides the hardcoded artifact filename mapping for approval gate checks.
   *  When set, the approval gate will look for this file instead of the default. */
  readonly approvalArtifact?: string;
  /** For llm_prompt phases: filename relative to specDir where the LLM response will be written.
   *  When set, the response is persisted so subsequent phases (e.g. SDD commands) can read it. */
  readonly outputFile?: string;
}

export interface FrameworkDefinition {
  readonly id: string;
  readonly phases: readonly PhaseDefinition[];
}

/** Returns the PhaseDefinition for the given phase, or undefined if not registered. */
export function findPhaseDefinition(def: FrameworkDefinition, phase: string): PhaseDefinition | undefined {
  return def.phases.find((p) => p.phase === phase);
}

export const VALID_APPROVAL_PHASES: readonly string[] = ["human_interaction", "requirements", "design", "tasks"];

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

    if (p.approvalGate !== undefined && !VALID_APPROVAL_PHASES.includes(p.approvalGate)) {
      throw new Error(
        `Framework "${def.id}" phase "${p.phase}" has unknown approvalGate: "${p.approvalGate}"`,
      );
    }
  }
}
