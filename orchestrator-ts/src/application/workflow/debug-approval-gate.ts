import type { IDebugEventSink } from "@/application/ports/debug";
import { type ApprovalCheckResult, ApprovalGate, type ApprovalPhase } from "@/domain/workflow/approval-gate";

/**
 * Approval gate used in --debug-flow mode.
 *
 * - `human_interaction` is NOT auto-approved: delegates to the real ApprovalGate
 *   so the workflow genuinely pauses after SPEC_INIT, giving the developer a chance
 *   to inspect the generated spec.json / requirements.md before continuing.
 * - All other phases (`requirements`, `design`, `tasks`) are auto-approved and
 *   emit one `approval:auto` debug event per check() call.
 */
export class DebugApprovalGate extends ApprovalGate {
  readonly #sink: IDebugEventSink;

  constructor(sink: IDebugEventSink) {
    super();
    this.#sink = sink;
  }

  override async check(specDir: string, phase: ApprovalPhase): Promise<ApprovalCheckResult> {
    // HUMAN_INTERACTION requires genuine human input — delegate to the real gate so
    // the workflow pauses until approvals.human_interaction.approved is set to true.
    if (phase === "human_interaction") {
      return super.check(specDir, phase);
    }

    // All other phases are auto-approved in debug-flow mode.
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
