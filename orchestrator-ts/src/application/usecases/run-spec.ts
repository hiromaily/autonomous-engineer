import type { AesConfig } from "@/application/ports/config";
import type { IImplementationLoop, ImplementationLoopOptions } from "@/application/ports/implementation-loop";
import type { LlmProviderPort } from "@/application/ports/llm";
import type { ILogger } from "@/application/ports/logger";
import type { MemoryPort } from "@/application/ports/memory";
import type { SddFrameworkPort } from "@/application/ports/sdd";
import type { IWorkflowEventBus, IWorkflowStateStore, WorkflowEvent } from "@/application/ports/workflow";
import { PhaseRunner } from "@/application/services/workflow/phase-runner";
import type { WorkflowResult } from "@/application/services/workflow/workflow-engine";
import { WorkflowEngine } from "@/application/services/workflow/workflow-engine";
import { ApprovalGate } from "@/domain/workflow/approval-gate";
import type { FrameworkDefinition } from "@/domain/workflow/framework";
import type { WorkflowPhase } from "@/domain/workflow/types";
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
  readonly frameworkDefinition: FrameworkDefinition;
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
      frameworkDefinition: this.deps.frameworkDefinition,
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
      frameworkDefinition: this.deps.frameworkDefinition,
      specDir,
      language: "en",
    });

    const logger = this.deps.logger;
    let phaseLogHandler: ((event: WorkflowEvent) => void) | undefined;
    if (logger) {
      phaseLogHandler = (event) => {
        if (event.type === "phase:start") {
          logger.info("Phase started", { phase: event.phase, specName });
        } else if (event.type === "phase:complete") {
          logger.info("Phase completed", { phase: event.phase, outcome: "completed", durationMs: event.durationMs });
        } else if (event.type === "phase:error") {
          logger.error("Phase failed", { phase: event.phase, reason: event.error });
        }
      };
      eventBus.on(phaseLogHandler);
    }

    try {
      return await engine.execute(state);
    } finally {
      if (phaseLogHandler) {
        eventBus.off(phaseLogHandler);
      }
    }
  }
}
