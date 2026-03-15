import type { IDebugEventSink } from "@/application/ports/debug";
import { type ApprovalCheckResult, ApprovalGate, type ApprovalPhase } from "@/domain/workflow/approval-gate";

/**
 * Auto-approving gate used in --debug-flow mode.
 *
 * - Always returns { approved: true } without reading disk.
 * - Emits one `approval:auto` event per check() call.
 */
export class DebugApprovalGate extends ApprovalGate {
  readonly #sink: IDebugEventSink;

  constructor(sink: IDebugEventSink) {
    super();
    this.#sink = sink;
  }

  override async check(_specDir: string, phase: ApprovalPhase): Promise<ApprovalCheckResult> {
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
