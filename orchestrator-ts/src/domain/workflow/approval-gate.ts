import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type ApprovalPhase = "human_interaction" | "requirements" | "design" | "tasks";

export type ApprovalCheckResult =
  | { readonly approved: true }
  | { readonly approved: false; readonly artifactPath: string; readonly instruction: string };

export class ApprovalGate {
  /**
   * Called when resuming from a previously paused state (advancePausedPhase).
   *
   * `human_interaction` is auto-approved on resume: simply re-running the
   * command after the workflow paused is sufficient to continue. No manual
   * spec.json edit is required.
   *
   * All other phases still delegate to check() — those gates represent genuine
   * human review of generated artifacts and must be explicitly approved in
   * spec.json before the workflow can advance.
   */
  async checkResume(specDir: string, phase: ApprovalPhase): Promise<ApprovalCheckResult> {
    if (phase === "human_interaction") {
      return { approved: true };
    }
    return this.check(specDir, phase);
  }

  async check(specDir: string, phase: ApprovalPhase): Promise<ApprovalCheckResult> {
    const specJsonPath = join(specDir, "spec.json");

    let parsed: unknown;
    try {
      const raw = await readFile(specJsonPath, "utf-8");
      parsed = JSON.parse(raw);
    } catch {
      // Missing file or malformed JSON → fail closed
      return this.pending(specDir, phase, specJsonPath);
    }

    if (getApprovalField(parsed, phase) !== true) {
      return this.pending(specDir, phase, specJsonPath);
    }

    return { approved: true };
  }

  private pending(specDir: string, phase: ApprovalPhase, specJsonPath: string): ApprovalCheckResult {
    const artifactPath = join(specDir, artifactFilename(phase));
    const field = `approvals.${phase}.approved`;
    const instruction = `Review ${artifactPath}, then set ${field} = true in ${specJsonPath} and re-run to continue.`;
    return { approved: false, artifactPath, instruction };
  }
}

function getApprovalField(parsed: unknown, phase: ApprovalPhase): unknown {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const approvals = (parsed as Record<string, unknown>).approvals;
  if (typeof approvals !== "object" || approvals === null) return undefined;
  const phaseObj = (approvals as Record<string, unknown>)[phase];
  if (typeof phaseObj !== "object" || phaseObj === null) return undefined;
  return (phaseObj as Record<string, unknown>).approved;
}

function artifactFilename(phase: ApprovalPhase): string {
  switch (phase) {
    case "human_interaction":
    case "requirements":
      return "requirements.md";
    case "design":
      return "design.md";
    case "tasks":
      return "tasks.md";
    default: {
      const _exhaustiveCheck: never = phase;
      throw new Error(`Unhandled approval phase: ${_exhaustiveCheck}`);
    }
  }
}
