import type { IDebugEventSink } from "@/application/ports/debug";
import { type ApprovalCheckResult, ApprovalGate, type ApprovalPhase } from "@/domain/workflow/approval-gate";
import { join } from "node:path";

/**
 * Approval gate used in --debug-flow mode.
 *
 * The only behavioural difference from the base ApprovalGate is that the mock
 * LLM is used instead of a real one. Approval logic follows the same rules:
 *
 * check() — called after a phase executes:
 *   - `human_interaction`: returns not-approved so the workflow pauses after
 *     SPEC_INIT. The user inspects the output, then re-runs to continue.
 *   - all other phases: auto-approved (no human review required in debug mode).
 *
 * checkResume() — called when resuming from a paused state:
 *   - inherited from ApprovalGate: auto-approves `human_interaction`, delegates
 *     to check() for all other phases.
 */
export class DebugApprovalGate extends ApprovalGate {
  readonly #sink: IDebugEventSink;

  constructor(sink: IDebugEventSink) {
    super();
    this.#sink = sink;
  }

  override async check(specDir: string, phase: ApprovalPhase): Promise<ApprovalCheckResult> {
    if (phase === "human_interaction") {
      return {
        approved: false,
        artifactPath: join(specDir, "requirements.md"),
        instruction: "Paused after SPEC_INIT. Re-run to continue from the next phase.",
      };
    }

    this.#sink.emit({
      type: "approval:auto",
      phase: phase.toUpperCase(),
      approvalType: phase,
      outcome: "approved",
      timestamp: new Date().toISOString(),
    });
    return { approved: true };
  }
}
