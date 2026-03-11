import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WORKFLOW_PHASES } from './types';
import type { WorkflowPhase, WorkflowState } from './types';
import type { IWorkflowStateStore, IWorkflowEventBus } from '../../application/ports/workflow';
import type { PhaseRunner } from './phase-runner';
import type { ApprovalGate, ApprovalPhase } from './approval-gate';
import type { SpecContext } from '../../application/ports/sdd';

export type WorkflowResult =
  | { readonly status: 'completed'; readonly completedPhases: readonly WorkflowPhase[] }
  | { readonly status: 'paused'; readonly phase: WorkflowPhase; readonly reason: 'approval_required' }
  | { readonly status: 'failed'; readonly phase: WorkflowPhase; readonly error: string };

/** Artifact filenames (relative to specDir) that must exist before entering each phase. */
const REQUIRED_ARTIFACTS: Partial<Record<WorkflowPhase, readonly string[]>> = {
  DESIGN:          ['requirements.md'],
  VALIDATE_DESIGN: ['design.md'],
  TASK_GENERATION: ['design.md'],
  IMPLEMENTATION:  ['tasks.md'],
};

/**
 * Phases that trigger a human approval gate check after successful execution.
 * Maps workflow phase → approval gate key read from spec.json approvals object.
 */
const APPROVAL_GATE_PHASES: Partial<Record<WorkflowPhase, ApprovalPhase>> = {
  REQUIREMENTS:    'requirements',
  VALIDATE_DESIGN: 'design',
  TASK_GENERATION: 'tasks',
};

export interface WorkflowEngineDeps {
  readonly stateStore: IWorkflowStateStore;
  readonly eventBus: IWorkflowEventBus;
  readonly phaseRunner: PhaseRunner;
  readonly approvalGate: ApprovalGate;
  /** Full path to the spec directory (e.g. `.kiro/specs/my-spec`). */
  readonly specDir: string;
  readonly language: string;
}

export class WorkflowEngine {
  private currentState!: WorkflowState;
  private isRunning = false;

  constructor(private readonly deps: WorkflowEngineDeps) {}

  /** Return a snapshot of the current workflow state. */
  getState(): WorkflowState {
    return this.currentState;
  }

  /** Execute the workflow starting from the given state.
   *  Throws if a concurrent execution is already in progress. */
  async execute(state: WorkflowState): Promise<WorkflowResult> {
    if (this.isRunning) {
      throw new Error('WorkflowEngine is already running; concurrent execution is not allowed.');
    }
    this.isRunning = true;
    this.currentState = state;

    try {
      return await this.runPendingPhases();
    } finally {
      this.isRunning = false;
    }
  }

  // --------------------------------------------------------------------------

  private async runPendingPhases(): Promise<WorkflowResult> {
    const { stateStore, eventBus, phaseRunner, specDir, language } = this.deps;
    const specName = this.currentState.specName;
    const ctx: SpecContext = { specName, specDir, language };

    // Handle resume from paused_for_approval: re-check gate for the paused phase
    // without re-executing it (Req 5.5, 5.6, 4.6).
    if (this.currentState.status === 'paused_for_approval') {
      const resumeResult = await this.advancePausedPhase();
      if (resumeResult !== null) return resumeResult;
      // advancePausedPhase returned null → phase advanced, fall through to main loop.
    }

    for (const phase of this.pendingPhases()) {
      // 1. Emit phase:start — always emitted at phase entry (Req 8.1).
      eventBus.emit({ type: 'phase:start', phase, timestamp: new Date().toISOString() });

      // 2. Validate that required artifacts from prior phases exist on disk.
      const artifactError = await this.checkRequiredArtifacts(phase);
      if (artifactError !== null) {
        eventBus.emit({ type: 'phase:error', phase, operation: 'artifact-validation', error: artifactError });
        return await this.failAt(phase, artifactError);
      }

      // 3. Check ready_for_implementation before entering IMPLEMENTATION (Req 4.6).
      if (phase === 'IMPLEMENTATION') {
        const readyResult = await this.checkReadyForImplementation();
        if (!readyResult.ready) {
          return await this.pauseAt('TASK_GENERATION', join(specDir, 'spec.json'), readyResult.instruction);
        }
      }

      // 4. Persist state (currentPhase = this phase, status = running) before
      //    invoking any operations — crash-recovery invariant.
      const runningState: WorkflowState = {
        ...this.currentState,
        currentPhase: phase,
        status: 'running',
        updatedAt: new Date().toISOString(),
      };
      this.currentState = runningState;
      await stateStore.persist(runningState);

      // 5. Lifecycle hook: clears LLM context at phase entry (Req 4.2, 4.3).
      await phaseRunner.onEnter(phase);

      // 6. Execute the phase; track wall-clock duration for phase:complete (Req 8.2).
      const startMs = Date.now();
      const result = await phaseRunner.execute(phase, ctx);
      const durationMs = Date.now() - startMs;

      // 7. Lifecycle hook post-exit.
      await phaseRunner.onExit(phase);

      if (!result.ok) {
        eventBus.emit({ type: 'phase:error', phase, operation: phase, error: result.error });
        return await this.failAt(phase, result.error);
      }

      // 8. Emit phase:complete with duration and artifacts (Req 8.2).
      eventBus.emit({ type: 'phase:complete', phase, durationMs, artifacts: result.artifacts });

      // 9. Check approval gate for phases that require human review (Req 5.1–5.6).
      const approvalType = APPROVAL_GATE_PHASES[phase];
      if (approvalType !== undefined) {
        const gateResult = await this.deps.approvalGate.check(specDir, approvalType);
        if (!gateResult.approved) {
          return await this.pauseAt(phase, gateResult.artifactPath, gateResult.instruction);
        }
      }

      // 10. Mark phase as complete.
      this.currentState = {
        ...this.currentState,
        completedPhases: [...this.currentState.completedPhases, phase],
        updatedAt: new Date().toISOString(),
      };
    }

    // All phases completed successfully.
    const finalState: WorkflowState = {
      ...this.currentState,
      status: 'completed',
      updatedAt: new Date().toISOString(),
    };
    this.currentState = finalState;
    await stateStore.persist(finalState);

    // Emit workflow:complete (Req 8.3).
    eventBus.emit({ type: 'workflow:complete', completedPhases: finalState.completedPhases });

    return { status: 'completed', completedPhases: finalState.completedPhases };
  }

  /**
   * Resume from paused_for_approval: re-check the approval gate for the paused phase
   * without re-executing it. Returns null when the phase advances (caller continues
   * with the main loop), or a WorkflowResult when still paused.
   */
  private async advancePausedPhase(): Promise<WorkflowResult | null> {
    const pausedPhase = this.currentState.currentPhase;
    const { approvalGate, specDir } = this.deps;
    const approvalType = APPROVAL_GATE_PHASES[pausedPhase];

    if (approvalType === undefined) {
      // No gate for this phase — should not happen; fall through to main loop.
      return null;
    }

    const gateResult = await approvalGate.check(specDir, approvalType);
    if (!gateResult.approved) {
      return await this.pauseAt(pausedPhase, gateResult.artifactPath, gateResult.instruction);
    }

    // Also check ready_for_implementation if the paused phase was TASK_GENERATION.
    if (pausedPhase === 'TASK_GENERATION') {
      const readyResult = await this.checkReadyForImplementation();
      if (!readyResult.ready) {
        return await this.pauseAt(pausedPhase, join(specDir, 'spec.json'), readyResult.instruction);
      }
    }

    // Approved — mark paused phase as completed, update status to running.
    const advancedState: WorkflowState = {
      ...this.currentState,
      completedPhases: [...this.currentState.completedPhases, pausedPhase],
      status: 'running',
      updatedAt: new Date().toISOString(),
    };
    this.currentState = advancedState;
    await this.deps.stateStore.persist(advancedState);

    return null; // Continue with main loop.
  }

  /** Phases not yet completed, in WORKFLOW_PHASES order. */
  private pendingPhases(): readonly WorkflowPhase[] {
    const completed = new Set(this.currentState.completedPhases);
    return WORKFLOW_PHASES.filter((p) => !completed.has(p));
  }

  /** Returns an error message if a required artifact is missing, null otherwise. */
  private async checkRequiredArtifacts(phase: WorkflowPhase): Promise<string | null> {
    const required = REQUIRED_ARTIFACTS[phase];
    if (required === undefined) return null;

    for (const filename of required) {
      const filePath = join(this.deps.specDir, filename);
      try {
        await access(filePath);
      } catch {
        return `Required artifact missing before ${phase}: ${filePath}`;
      }
    }
    return null;
  }

  /**
   * Read `ready_for_implementation` from spec.json in the spec directory.
   * Returns `{ ready: false }` if the file is missing, malformed, or the field
   * is not `true` — fail closed.
   */
  private async checkReadyForImplementation(): Promise<{ ready: boolean; instruction: string }> {
    const specJsonPath = join(this.deps.specDir, 'spec.json');
    try {
      const raw = await readFile(specJsonPath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed['ready_for_implementation'] === true) {
        return { ready: true, instruction: '' };
      }
    } catch { /* missing or malformed → not ready */ }

    return {
      ready: false,
      instruction: `Set ready_for_implementation = true in ${specJsonPath} to proceed to IMPLEMENTATION.`,
    };
  }

  /**
   * Persist a paused_for_approval state, emit approval:required, and return
   * the paused WorkflowResult. Single owner of pause-state transitions.
   */
  private async pauseAt(
    phase: WorkflowPhase,
    artifactPath: string,
    instruction: string,
  ): Promise<WorkflowResult> {
    const pausedState: WorkflowState = {
      ...this.currentState,
      currentPhase: phase,
      status: 'paused_for_approval',
      updatedAt: new Date().toISOString(),
    };
    this.currentState = pausedState;
    await this.deps.stateStore.persist(pausedState);
    this.deps.eventBus.emit({ type: 'approval:required', phase, artifactPath, instruction });
    return { status: 'paused', phase, reason: 'approval_required' };
  }

  /** Persist a failed state, emit workflow:failed, and return the failed WorkflowResult. */
  private async failAt(phase: WorkflowPhase, error: string): Promise<WorkflowResult> {
    const failedState: WorkflowState = {
      ...this.currentState,
      status: 'failed',
      failureDetail: { phase, error },
      updatedAt: new Date().toISOString(),
    };
    this.currentState = failedState;
    await this.deps.stateStore.persist(failedState);
    // Emit workflow:failed before returning to the caller (Req 8.3).
    this.deps.eventBus.emit({ type: 'workflow:failed', phase, error });
    return { status: 'failed', phase, error };
  }
}
