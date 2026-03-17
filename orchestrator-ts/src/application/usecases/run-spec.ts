import type { AesConfig } from "@/application/ports/config";
import type { IImplementationLoop, ImplementationLoopOptions } from "@/application/ports/implementation-loop";
import type { LlmProviderPort } from "@/application/ports/llm";
import type { ILogger } from "@/application/ports/logger";
import type { MemoryPort } from "@/application/ports/memory";
import type { SddFrameworkPort } from "@/application/ports/sdd";
import type { IWorkflowEventBus, IWorkflowStateStore } from "@/application/ports/workflow";
import { ApprovalGate } from "@/domain/workflow/approval-gate";
import { PhaseRunner } from "@/domain/workflow/phase-runner";
import type { WorkflowPhase } from "@/domain/workflow/types";
import type { WorkflowResult } from "@/domain/workflow/workflow-engine";
import { WorkflowEngine } from "@/domain/workflow/workflow-engine";
import { access } from "node:fs/promises";
import { join } from "node:path";

export type RunOptions = {
  readonly dryRun: boolean;
  readonly providerOverride?: string | undefined;
};

export interface RunSpecUseCaseDeps {
  readonly stateStore: IWorkflowStateStore;
  readonly eventBus: IWorkflowEventBus;
  readonly sdd: SddFrameworkPort;
  readonly createLlmProvider: (config: AesConfig, providerOverride?: string) => LlmProviderPort;
  readonly memory: MemoryPort;
  /** Optional implementation loop service injected into the workflow's IMPLEMENTATION phase. */
  readonly implementationLoop?: IImplementationLoop;
  /** Optional approval gate override; when present, replaces the internally constructed ApprovalGate. */
  readonly approvalGate?: ApprovalGate;
  /** Optional options forwarded to the implementation loop (e.g. agentEventBus for debug-flow). */
  readonly implementationLoopOptions?: Partial<ImplementationLoopOptions>;
  /** Optional operational logger injected for phase lifecycle events. */
  readonly logger?: ILogger;
}

export class RunSpecUseCase {
  constructor(private readonly deps: RunSpecUseCaseDeps) {}

  async run(specName: string, config: AesConfig, options: RunOptions): Promise<WorkflowResult> {
    const { stateStore, eventBus, sdd, createLlmProvider } = this.deps;
    const specDir = join(config.specDir, specName);

    // dry-run: validate spec directory exists; no workflow execution
    if (options.dryRun) {
      try {
        await access(specDir);
      } catch {
        return {
          status: "failed",
          phase: "SPEC_INIT" as WorkflowPhase,
          error: `Spec directory does not exist: ${specDir}`,
        };
      }
      return { status: "completed", completedPhases: [] };
    }

    // Reset ephemeral short-term memory before each workflow run
    this.deps.memory.shortTerm.clear();

    // Always check for persisted state first; only initialise fresh when none exists.
    // This ensures re-runs automatically resume from the last paused/failed phase
    // without requiring an explicit flag.
    const state = (await stateStore.restore(specName)) ?? stateStore.init(specName);

    // Construct engine with all dependencies
    const llm = createLlmProvider(config, options.providerOverride);
    const phaseRunner = new PhaseRunner({
      sdd,
      llm,
      ...(this.deps.implementationLoop !== undefined ? { implementationLoop: this.deps.implementationLoop } : {}),
      ...(this.deps.implementationLoopOptions !== undefined
        ? { implementationLoopOptions: this.deps.implementationLoopOptions }
        : {}),
    });
    const approvalGate = this.deps.approvalGate ?? new ApprovalGate();

    const engine = new WorkflowEngine({
      stateStore,
      eventBus,
      phaseRunner,
      approvalGate,
      specDir,
      language: "en",
    });

    return engine.execute(state);
  }
}
