import type { IImplementationLoop, ImplementationLoopOptions } from "@/application/ports/implementation-loop";
import type { LlmProviderPort } from "@/application/ports/llm";
import type { SddFrameworkPort, SddOperationResult, SpecContext } from "@/application/ports/sdd";
import { findPhaseDefinition } from "@/domain/workflow/framework";
import type { FrameworkDefinition } from "@/domain/workflow/framework";
import type { WorkflowPhase } from "@/domain/workflow/types";

export type PhaseResult =
  | { readonly ok: true; readonly artifacts: readonly string[] }
  | { readonly ok: false; readonly error: string };

export interface PhaseRunnerDeps {
  readonly sdd: SddFrameworkPort;
  readonly llm: LlmProviderPort;
  readonly frameworkDefinition: FrameworkDefinition;
  /** Optional implementation loop service. When provided, the IMPLEMENTATION phase delegates
   *  to `implementationLoop.run(specName)`. When absent, the phase stubs to success. */
  readonly implementationLoop?: IImplementationLoop;
  /** Optional options forwarded to `implementationLoop.run()` calls (e.g. debug agentEventBus). */
  readonly implementationLoopOptions?: Partial<ImplementationLoopOptions>;
}

export class PhaseRunner {
  private readonly sdd: SddFrameworkPort;
  private readonly llm: LlmProviderPort;
  private readonly frameworkDefinition: FrameworkDefinition;
  private readonly implementationLoop: IImplementationLoop | undefined;
  private readonly implementationLoopOptions: Partial<ImplementationLoopOptions> | undefined;

  constructor(deps: PhaseRunnerDeps) {
    this.sdd = deps.sdd;
    this.llm = deps.llm;
    this.frameworkDefinition = deps.frameworkDefinition;
    this.implementationLoop = deps.implementationLoop;
    this.implementationLoopOptions = deps.implementationLoopOptions;
  }

  async execute(phase: WorkflowPhase, ctx: SpecContext): Promise<PhaseResult> {
    const phaseDef = findPhaseDefinition(this.frameworkDefinition, phase);
    if (!phaseDef) {
      throw new Error(`Unregistered workflow phase: ${phase} in framework ${this.frameworkDefinition.id}`);
    }

    const interpolate = (content: string): string =>
      content
        .replaceAll("{specDir}", ctx.specDir)
        .replaceAll("{specName}", ctx.specName)
        .replaceAll("{language}", ctx.language);

    switch (phaseDef.type) {
      case "llm_slash_command": {
        const result = await this.sdd.executeCommand(interpolate(phaseDef.content), ctx);
        return this.mapSddResult(result);
      }
      case "llm_prompt": {
        const result = await this.llm.complete(interpolate(phaseDef.content));
        if (result.ok) {
          return { ok: true, artifacts: [] };
        }
        return { ok: false, error: result.error.message };
      }
      case "human_interaction":
      case "git_command":
        return { ok: true, artifacts: [] };
      case "implementation_loop": {
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
        const _exhaustive: never = phaseDef.type;
        throw new Error(`Unhandled phase execution type: ${_exhaustive}`);
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
