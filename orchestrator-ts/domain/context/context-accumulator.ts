import type {
	AccumulatedEntry,
	ContextAccumulatorConfig,
	ExpansionEvent,
	IContextAccumulator,
} from "../../application/ports/context";

export class ContextAccumulator implements IContextAccumulator {
	private readonly entries = new Map<string, AccumulatedEntry[]>();
	private readonly expansionEvents: ExpansionEvent[] = [];
	private expansionCount = 0;
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
		const key = `${phaseId}:${taskId}`;
		const bucket = this.entries.get(key);
		if (!bucket) return [];
		// Filter to ensure only entries for the requested phase are returned
		return bucket.filter((e) => e.phaseId === phaseId);
	}

	// ---------------------------------------------------------------------------
	// recordExpansion
	// ---------------------------------------------------------------------------

	recordExpansion(event: ExpansionEvent): { ok: boolean; errorReason?: string } {
		if (this.expansionCount >= this.maxExpansions) {
			return {
				ok: false,
				errorReason: `Expansion limit of ${this.maxExpansions} reached for this iteration.`,
			};
		}
		this.expansionEvents.push(event);
		this.expansionCount += 1;
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
		// Delete all entries keyed under the given phaseId
		for (const key of this.entries.keys()) {
			if (key.startsWith(`${phaseId}:`)) {
				this.entries.delete(key);
			}
		}
		// Clear active phase so a new phase can be started
		if (this.activePhaseId === phaseId) {
			this.activePhaseId = null;
		}
		this._resetExpansionCounter();
	}

	// ---------------------------------------------------------------------------
	// resetTask
	// ---------------------------------------------------------------------------

	resetTask(taskId: string): void {
		// Delete all entries for any key ending in `:taskId`
		for (const key of this.entries.keys()) {
			if (key.endsWith(`:${taskId}`)) {
				this.entries.delete(key);
			}
		}
		this._resetExpansionCounter();
	}

	// ---------------------------------------------------------------------------
	// Private helpers
	// ---------------------------------------------------------------------------

	private _resetExpansionCounter(): void {
		this.expansionEvents.length = 0;
		this.expansionCount = 0;
	}
}
