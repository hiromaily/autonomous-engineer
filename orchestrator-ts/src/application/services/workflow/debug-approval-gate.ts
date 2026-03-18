import type { IDebugEventSink } from "@/application/ports/debug";
import { type ApprovalCheckResult, ApprovalGate, type ApprovalPhase } from "@/domain/workflow/approval-gate";
import { join } from "node:path";

/**
 * Approval gate used in --debug-flow mode.
 *
 * This gate simplifies the approval process for debugging by modifying the
 * standard approval logic:
 *
 * **`check()`** (called on first execution of a phase):
 *   - `human_interaction`: Always returns `approved: false` to pause the workflow
 *     after `SPEC_INIT`, allowing the developer to inspect initial output.
 *   - All other phases (`requirements`, `design`, `tasks`): Are auto-approved.
 *
 * **`checkResume()`** (called when resuming a paused workflow):
 *   - Inherits from `ApprovalGate`, which auto-approves `human_interaction`.
 *     This allows the workflow to continue simply by re-running the command.
 *   - For other phases, it delegates to this class's `check()` method, which
 *     results in them being auto-approved.
 */
export class DebugApprovalGate extends ApprovalGate {
  readonly #sink: IDebugEventSink;

  constructor(sink: IDebugEventSink) {
    super();
    this.#sink = sink;
  }

  override async check(specDir: string, phase: ApprovalPhase, approvalArtifact?: string): Promise<ApprovalCheckResult> {
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
