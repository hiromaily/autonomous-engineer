import type { ApprovalPhase } from "@/domain/workflow/approval-gate";

export type PhaseExecutionType =
  | "llm_slash_command"
  | "llm_prompt"
  | "human_interaction"
  | "suspension"
  | "git_command"
  | "implementation_loop";

export type LoopPhaseExecutionType =
  | "llm_slash_command"
  | "llm_prompt"
  | "git_command";

export const VALID_LOOP_PHASE_EXECUTION_TYPES = new Set<string>([
  "llm_slash_command", "llm_prompt", "git_command",
]);

/**
 * Definition for a single sub-phase that runs inside each iteration of an implementation_loop.
 * Intentionally minimal — omits orchestration fields (approvalGate, requiredArtifacts, etc.)
 * that have no meaning within a per-task iteration.
 */
export interface LoopPhaseDefinition {
  /** Logical name, e.g. "SPEC_IMPL". Used in logging only. */
  readonly phase: string;
  /** Execution type. Only llm_slash_command, llm_prompt, git_command are valid. */
  readonly type: LoopPhaseExecutionType;
  /**
   * For llm_slash_command: the command name (e.g. "kiro:spec-impl"). Task ID is always
   *   appended automatically as " {taskId}" by the service. Do NOT include {taskId} here.
   * For llm_prompt: the prompt template. Supports {specName}, {specDir}, {language}, {taskId}.
   * For git_command: empty string (commit behavior is hardcoded in the service).
   */
  readonly content: string;
}

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
  /**
   * For implementation_loop phases only: the ordered list of sub-phases to execute
   * in each task iteration. When absent, the service uses its hardcoded default sequence.
   */
  readonly loopPhases?: readonly LoopPhaseDefinition[];
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

    if (p.type === "implementation_loop" && p.loopPhases !== undefined) {
      for (const [i, lp] of p.loopPhases.entries()) {
        if (!lp.phase || lp.phase.trim() === "") {
          throw new Error(
            `Framework "${def.id}" phase "${p.phase}": loop-phases[${i}] is missing a "phase" name`,
          );
        }
        if (!VALID_LOOP_PHASE_EXECUTION_TYPES.has(lp.type)) {
          throw new Error(
            `Framework "${def.id}" phase "${p.phase}": loop-phases[${i}] ("${lp.phase}") has invalid type "${lp.type}". ` +
            `Valid loop phase types: ${[...VALID_LOOP_PHASE_EXECUTION_TYPES].join(", ")}`,
          );
        }
        if ((lp.type === "llm_slash_command" || lp.type === "llm_prompt") && lp.content === "") {
          throw new Error(
            `Framework "${def.id}" phase "${p.phase}": loop-phases[${i}] ("${lp.phase}") ` +
            `(type: ${lp.type}) must have non-empty content`,
          );
        }
      }
    }
  }
}
