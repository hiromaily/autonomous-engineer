import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { IWorkflowStateStore, IWorkflowEventBus } from '../ports/workflow';
import type { SddFrameworkPort } from '../ports/sdd';
import type { LlmProviderPort } from '../ports/llm';
import type { AesConfig } from '../ports/config';
import type { MemoryPort } from '../ports/memory';
import type { WorkflowResult } from '../../domain/workflow/workflow-engine';
import type { WorkflowPhase } from '../../domain/workflow/types';
import { WorkflowEngine } from '../../domain/workflow/workflow-engine';
import { PhaseRunner } from '../../domain/workflow/phase-runner';
import { ApprovalGate } from '../../domain/workflow/approval-gate';

export type RunOptions = {
  readonly resume: boolean;
  readonly dryRun: boolean;
  readonly providerOverride?: string | undefined;
};

export interface RunSpecUseCaseDeps {
  readonly stateStore: IWorkflowStateStore;
  readonly eventBus: IWorkflowEventBus;
  readonly sdd: SddFrameworkPort;
  readonly createLlmProvider: (config: AesConfig, providerOverride?: string) => LlmProviderPort;
  readonly memory: MemoryPort;
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
          status: 'failed',
          phase: 'SPEC_INIT' as WorkflowPhase,
          error: `Spec directory does not exist: ${specDir}`,
        };
      }
      return { status: 'completed', completedPhases: [] };
    }

    // Reset ephemeral short-term memory before each workflow run
    this.deps.memory.shortTerm.clear();

    // Resolve initial workflow state
    let state = options.resume ? await stateStore.restore(specName) : null;
    if (state === null) {
      state = stateStore.init(specName);
    }

    // Construct engine with all dependencies
    const llm = createLlmProvider(config, options.providerOverride);
    const phaseRunner = new PhaseRunner({ sdd, llm });
    const approvalGate = new ApprovalGate();

    const engine = new WorkflowEngine({
      stateStore,
      eventBus,
      phaseRunner,
      approvalGate,
      specDir,
      language: 'en',
    });

    return engine.execute(state);
  }
}
