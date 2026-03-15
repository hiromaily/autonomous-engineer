import type { IImplementationLoop } from "@/application/ports/implementation-loop";
import type { LlmProviderPort } from "@/application/ports/llm";
import type { SddFrameworkPort, SpecContext } from "@/application/ports/sdd";
import type { WorkflowPhase } from "./types";

export type PhaseResult =
  | { readonly ok: true; readonly artifacts: readonly string[] }
  | { readonly ok: false; readonly error: string };

export interface PhaseRunnerDeps {
  readonly sdd: SddFrameworkPort;
  readonly llm: LlmProviderPort;
  /** Optional implementation loop service. When provided, the IMPLEMENTATION phase delegates
   *  to `implementationLoop.run(specName)`. When absent, the phase stubs to success. */
  readonly implementationLoop?: IImplementationLoop;
}

export class PhaseRunner {
  private readonly sdd: SddFrameworkPort;
  private readonly llm: LlmProviderPort;
  private readonly implementationLoop: IImplementationLoop | undefined;

  constructor(deps: PhaseRunnerDeps) {
    this.sdd = deps.sdd;
    this.llm = deps.llm;
    this.implementationLoop = deps.implementationLoop;
  }

  async execute(phase: WorkflowPhase, ctx: SpecContext): Promise<PhaseResult> {
    switch (phase) {
      case "REQUIREMENTS": {
        const result = await this.sdd.generateRequirements(ctx);
        return this.mapSddResult(result);
      }
      case "DESIGN": {
        const result = await this.sdd.generateDesign(ctx);
        return this.mapSddResult(result);
      }
      case "VALIDATE_DESIGN": {
        const result = await this.sdd.validateDesign(ctx);
        return this.mapSddResult(result);
      }
      case "TASK_GENERATION": {
        const result = await this.sdd.generateTasks(ctx);
        return this.mapSddResult(result);
      }
      case "SPEC_INIT":
      case "PULL_REQUEST":
        // Stubs: wired in spec4 and spec8; return success with no artifacts
        return { ok: true, artifacts: [] };
      case "IMPLEMENTATION": {
        if (this.implementationLoop) {
          const result = await this.implementationLoop.run(ctx.specName);
          if (result.outcome === "completed") {
            return { ok: true, artifacts: [] };
          }
          return { ok: false, error: result.haltReason ?? result.outcome };
        }
        // Stub: no implementation loop wired yet
        return { ok: true, artifacts: [] };
      }
      default: {
        const _exhaustiveCheck: never = phase;
        throw new Error(`Unhandled workflow phase: ${_exhaustiveCheck}`);
      }
    }
  }

  async onEnter(_phase: WorkflowPhase): Promise<void> {
    // Reset LLM context at every phase transition to prevent accumulated
    // conversation state from carrying over between phases (Req 4.2, 4.3)
    this.llm.clearContext();
  }

  async onExit(_phase: WorkflowPhase): Promise<void> {
    // Lifecycle hook — extended in future specs
  }

  private mapSddResult(result: Awaited<ReturnType<SddFrameworkPort["generateRequirements"]>>): PhaseResult {
    if (result.ok) {
      return { ok: true, artifacts: [result.artifactPath] };
    }
    const stderr = result.error.stderr.trim();
    const errorMessage = stderr
      ? `${stderr} (exit ${result.error.exitCode})`
      : `SDD adapter failed (exit ${result.error.exitCode})`;
    return { ok: false, error: errorMessage };
  }
}
