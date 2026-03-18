import type { IImplementationLoop, ImplementationLoopOptions } from "@/application/ports/implementation-loop";
import type { LlmProviderPort } from "@/application/ports/llm";
import type { SddFrameworkPort, SddOperationResult, SpecContext } from "@/application/ports/sdd";
import type { WorkflowPhase } from "@/domain/workflow/types";

export type PhaseResult =
  | { readonly ok: true; readonly artifacts: readonly string[] }
  | { readonly ok: false; readonly error: string };

export interface PhaseRunnerDeps {
  readonly sdd: SddFrameworkPort;
  readonly llm: LlmProviderPort;
  /** Optional implementation loop service. When provided, the IMPLEMENTATION phase delegates
   *  to `implementationLoop.run(specName)`. When absent, the phase stubs to success. */
  readonly implementationLoop?: IImplementationLoop;
  /** Optional options forwarded to `implementationLoop.run()` calls (e.g. debug agentEventBus). */
  readonly implementationLoopOptions?: Partial<ImplementationLoopOptions>;
}

export class PhaseRunner {
  private readonly sdd: SddFrameworkPort;
  private readonly llm: LlmProviderPort;
  private readonly implementationLoop: IImplementationLoop | undefined;
  private readonly implementationLoopOptions: Partial<ImplementationLoopOptions> | undefined;

  constructor(deps: PhaseRunnerDeps) {
    this.sdd = deps.sdd;
    this.llm = deps.llm;
    this.implementationLoop = deps.implementationLoop;
    this.implementationLoopOptions = deps.implementationLoopOptions;
  }

  async execute(phase: WorkflowPhase, ctx: SpecContext): Promise<PhaseResult> {
    switch (phase) {
      // llm_slash_command phases — delegated to the SDD framework adapter
      case "SPEC_INIT": {
        const result = await this.sdd.executeCommand("kiro:spec-init", ctx);
        return this.mapSddResult(result);
      }
      case "SPEC_REQUIREMENTS": {
        const result = await this.sdd.executeCommand("kiro:spec-requirements", ctx);
        return this.mapSddResult(result);
      }
      case "VALIDATE_GAP": {
        const result = await this.sdd.executeCommand("kiro:validate-gap", ctx);
        return this.mapSddResult(result);
      }
      case "SPEC_DESIGN": {
        const result = await this.sdd.executeCommand("kiro:spec-design", ctx);
        return this.mapSddResult(result);
      }
      case "VALIDATE_DESIGN": {
        const result = await this.sdd.executeCommand("kiro:validate-design", ctx);
        return this.mapSddResult(result);
      }
      case "SPEC_TASKS": {
        const result = await this.sdd.executeCommand("kiro:spec-tasks", ctx);
        return this.mapSddResult(result);
      }
      // llm_prompt phases — stub until task 5 wires LLM dispatch
      case "VALIDATE_PREREQUISITES":
      case "VALIDATE_REQUIREMENTS":
      case "REFLECT_BEFORE_DESIGN":
      case "REFLECT_BEFORE_TASKS":
      case "VALIDATE_TASKS":
        return { ok: true, artifacts: [] };
      case "HUMAN_INTERACTION":
      case "PULL_REQUEST":
        // HUMAN_INTERACTION is a pause point — the approval gate handles the wait.
        // PULL_REQUEST wired in a future spec.
        return { ok: true, artifacts: [] };
      case "IMPLEMENTATION": {
        if (this.implementationLoop) {
          const result = await this.implementationLoop.run(ctx.specName, this.implementationLoopOptions);
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

  private mapSddResult(result: SddOperationResult): PhaseResult {
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
