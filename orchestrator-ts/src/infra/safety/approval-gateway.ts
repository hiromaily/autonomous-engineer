import type { ApprovalDecision, IApprovalGateway } from "@/application/ports/safety";
import type { ApprovalRequest } from "@/domain/safety/guards";
import { createInterface } from "node:readline";

/**
 * Factory function that presents a question to the user and awaits input.
 * Rejects on timeout or abort.
 */
export type ReadlineFactory = (question: string, timeoutMs: number) => Promise<string>;

/**
 * Default readline factory using node:readline with a timer-based timeout.
 * Closes the interface on timeout so the readline prompt is dismissed.
 */
const defaultReadlineFactory: ReadlineFactory = (question, timeoutMs) => {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    const timer = setTimeout(() => {
      rl.close();
      reject(new Error("timeout"));
    }, timeoutMs);

    rl.question(question, (answer: string) => {
      clearTimeout(timer);
      rl.close();
      resolve(answer);
    });
  });
};

function buildPrompt(request: ApprovalRequest): string {
  return (
    `\n[SAFETY APPROVAL REQUIRED]\n`
    + `  Risk: ${request.riskClassification}\n`
    + `  Description: ${request.description}\n`
    + `  Expected impact: ${request.expectedImpact}\n`
    + `  Proposed action: ${request.proposedAction}\n`
    + `Approve? [y/N]: `
  );
}

function parseAnswer(raw: string): ApprovalDecision {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "y" || normalized === "yes") return "approved";
  return "denied";
}

function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ABORT_ERR") return true;
  return err.message.toLowerCase().includes("timeout") || err.message.toLowerCase().includes("aborted");
}

/**
 * CLI-based approval gateway.
 *
 * Presents a structured prompt to the terminal operator and awaits a yes/no
 * response. Returns 'timeout' when the readline factory rejects with a
 * timeout/abort error, and 'denied' for any other unexpected error.
 *
 * An injectable ReadlineFactory enables deterministic testing without real
 * terminal interaction.
 */
export class CliApprovalGateway implements IApprovalGateway {
  private readonly readlineFactory: ReadlineFactory;

  constructor(readlineFactory: ReadlineFactory = defaultReadlineFactory) {
    this.readlineFactory = readlineFactory;
  }

  async requestApproval(request: ApprovalRequest, timeoutMs: number): Promise<ApprovalDecision> {
    try {
      const prompt = buildPrompt(request);
      const answer = await this.readlineFactory(prompt, timeoutMs);
      return parseAnswer(answer);
    } catch (err) {
      if (isTimeoutError(err)) return "timeout";
      return "denied";
    }
  }
}
