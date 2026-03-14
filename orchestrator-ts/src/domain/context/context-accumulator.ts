import type {
  AccumulatedEntry,
  ContextAccumulatorConfig,
  ExpansionEvent,
  IContextAccumulator,
} from "@/application/ports/context";

export class ContextAccumulator implements IContextAccumulator {
  private readonly entries = new Map<string, AccumulatedEntry[]>();
  private expansionEvents: ExpansionEvent[] = [];
  private readonly maxExpansions: number;
  private activePhaseId: string | null = null;

  constructor(config: ContextAccumulatorConfig) {
    this.maxExpansions = config.maxExpansionsPerIteration;
  }

  // ---------------------------------------------------------------------------
  // accumulate
  // ---------------------------------------------------------------------------

  accumulate(entry: AccumulatedEntry): void {
    if (this.activePhaseId === null) {
      this.activePhaseId = entry.phaseId;
    } else if (entry.phaseId !== this.activePhaseId) {
      throw new Error(
        `[ContextAccumulator] Cannot accumulate entry with phaseId "${entry.phaseId}" — active phase is "${this.activePhaseId}". Call resetPhase() before switching phases.`,
      );
    }

    const key = `${entry.phaseId}:${entry.taskId}`;
    const bucket = this.entries.get(key) ?? [];
    bucket.push(entry);
    this.entries.set(key, bucket);
  }

  // ---------------------------------------------------------------------------
  // getEntries
  // ---------------------------------------------------------------------------

  getEntries(phaseId: string, taskId: string): ReadonlyArray<AccumulatedEntry> {
    // The key encodes both phaseId and taskId, so all entries in the bucket
    // are guaranteed to belong to this exact (phaseId, taskId) scope.
    return this.entries.get(`${phaseId}:${taskId}`) ?? [];
  }

  // ---------------------------------------------------------------------------
  // recordExpansion
  // ---------------------------------------------------------------------------

  recordExpansion(event: ExpansionEvent): { ok: boolean; errorReason?: string } {
    if (this.expansionEvents.length >= this.maxExpansions) {
      return {
        ok: false,
        errorReason: `Expansion limit of ${this.maxExpansions} reached for this iteration.`,
      };
    }
    this.expansionEvents.push(event);
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // getExpansionEvents
  // ---------------------------------------------------------------------------

  getExpansionEvents(): ReadonlyArray<ExpansionEvent> {
    return this.expansionEvents;
  }

  // ---------------------------------------------------------------------------
  // resetPhase
  // ---------------------------------------------------------------------------

  resetPhase(phaseId: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(`${phaseId}:`)) {
        this.entries.delete(key);
      }
    }
    if (this.activePhaseId === phaseId) {
      this.activePhaseId = null;
    }
    this.resetExpansionState();
  }

  // ---------------------------------------------------------------------------
  // resetTask
  // ---------------------------------------------------------------------------

  resetTask(taskId: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.endsWith(`:${taskId}`)) {
        this.entries.delete(key);
      }
    }
    this.resetExpansionState();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private resetExpansionState(): void {
    this.expansionEvents = [];
  }
}
