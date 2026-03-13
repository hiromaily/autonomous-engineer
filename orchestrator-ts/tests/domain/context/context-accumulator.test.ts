import { describe, expect, it } from "bun:test";
import { ContextAccumulator } from "../../../domain/context/context-accumulator";
import type {
	AccumulatedEntry,
	ExpansionEvent,
} from "../../../application/ports/context";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(
	phaseId: string,
	taskId: string,
	overrides: Partial<AccumulatedEntry> = {},
): AccumulatedEntry {
	return {
		layerId: "codeContext",
		content: "some content",
		phaseId,
		taskId,
		...overrides,
	};
}

function makeExpansionEvent(
	resourceId = "file.ts",
	overrides: Partial<ExpansionEvent> = {},
): ExpansionEvent {
	return {
		resourceId,
		targetLayer: "codeContext",
		addedTokenCount: 50,
		newCumulativeTokenCount: 50,
		timestamp: new Date().toISOString(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// accumulate()
// ---------------------------------------------------------------------------

describe("ContextAccumulator.accumulate", () => {
	it("adds an entry and retrieves it via getEntries", () => {
		const acc = new ContextAccumulator({ maxExpansionsPerIteration: 10 });
		const entry = makeEntry("phase1", "task1");
		acc.accumulate(entry);
		const result = acc.getEntries("phase1", "task1");
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual(entry);
	});

	it("accumulates multiple entries under the same scope", () => {
		const acc = new ContextAccumulator({ maxExpansionsPerIteration: 10 });
		acc.accumulate(makeEntry("phase1", "task1", { content: "a" }));
		acc.accumulate(makeEntry("phase1", "task1", { content: "b" }));
		const result = acc.getEntries("phase1", "task1");
		expect(result).toHaveLength(2);
	});

	it("throws when entry phaseId differs from the active phase", () => {
		const acc = new ContextAccumulator({ maxExpansionsPerIteration: 10 });
		acc.accumulate(makeEntry("phase1", "task1"));
		expect(() => acc.accumulate(makeEntry("phase2", "task1"))).toThrow();
	});

	it("allows a new phase after resetPhase clears the active phase", () => {
		const acc = new ContextAccumulator({ maxExpansionsPerIteration: 10 });
		acc.accumulate(makeEntry("phase1", "task1"));
		acc.resetPhase("phase1");
		// After reset, a new phase should be accepted
		expect(() => acc.accumulate(makeEntry("phase2", "task1"))).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// getEntries() — phase isolation
// ---------------------------------------------------------------------------

describe("ContextAccumulator.getEntries — phase isolation", () => {
	it("never returns entries whose phaseId differs from the requested phase", () => {
		const acc = new ContextAccumulator({ maxExpansionsPerIteration: 10 });
		acc.accumulate(makeEntry("phase1", "task1", { content: "phase1-entry" }));
		// Reset to allow phase2
		acc.resetPhase("phase1");
		acc.accumulate(makeEntry("phase2", "task1", { content: "phase2-entry" }));

		const phase1Entries = acc.getEntries("phase1", "task1");
		expect(phase1Entries).toHaveLength(0); // phase1 was cleared

		const phase2Entries = acc.getEntries("phase2", "task1");
		expect(phase2Entries).toHaveLength(1);
		expect(phase2Entries[0].content).toBe("phase2-entry");
	});

	it("returns empty array for an unknown scope", () => {
		const acc = new ContextAccumulator({ maxExpansionsPerIteration: 10 });
		expect(acc.getEntries("unknown", "task1")).toEqual([]);
	});

	it("does not cross-contaminate entries from different tasks in the same phase", () => {
		const acc = new ContextAccumulator({ maxExpansionsPerIteration: 10 });
		acc.accumulate(makeEntry("phase1", "task1", { content: "t1" }));
		acc.accumulate(makeEntry("phase1", "task2", { content: "t2" }));
		expect(acc.getEntries("phase1", "task1")).toHaveLength(1);
		expect(acc.getEntries("phase1", "task2")).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// recordExpansion()
// ---------------------------------------------------------------------------

describe("ContextAccumulator.recordExpansion", () => {
	it("records an expansion event and returns ok: true when within limit", () => {
		const acc = new ContextAccumulator({ maxExpansionsPerIteration: 3 });
		const result = acc.recordExpansion(makeExpansionEvent("r1"));
		expect(result.ok).toBe(true);
		expect(result.errorReason).toBeUndefined();
	});

	it("returns ok: false with errorReason once the limit is reached", () => {
		const acc = new ContextAccumulator({ maxExpansionsPerIteration: 2 });
		acc.recordExpansion(makeExpansionEvent("r1"));
		acc.recordExpansion(makeExpansionEvent("r2"));
		// Third call exceeds limit
		const result = acc.recordExpansion(makeExpansionEvent("r3"));
		expect(result.ok).toBe(false);
		expect(result.errorReason).toBeDefined();
	});

	it("does not append to the event log when the limit is exceeded", () => {
		const acc = new ContextAccumulator({ maxExpansionsPerIteration: 1 });
		acc.recordExpansion(makeExpansionEvent("r1"));
		acc.recordExpansion(makeExpansionEvent("r2")); // exceeds limit
		const events = acc.getExpansionEvents();
		expect(events).toHaveLength(1);
	});

	it("returns ok: true up to and including the limit", () => {
		const acc = new ContextAccumulator({ maxExpansionsPerIteration: 2 });
		expect(acc.recordExpansion(makeExpansionEvent("r1")).ok).toBe(true);
		expect(acc.recordExpansion(makeExpansionEvent("r2")).ok).toBe(true);
		expect(acc.recordExpansion(makeExpansionEvent("r3")).ok).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// getExpansionEvents()
// ---------------------------------------------------------------------------

describe("ContextAccumulator.getExpansionEvents", () => {
	it("returns all recorded expansion events in order", () => {
		const acc = new ContextAccumulator({ maxExpansionsPerIteration: 10 });
		acc.recordExpansion(makeExpansionEvent("r1"));
		acc.recordExpansion(makeExpansionEvent("r2"));
		const events = acc.getExpansionEvents();
		expect(events).toHaveLength(2);
		expect(events[0].resourceId).toBe("r1");
		expect(events[1].resourceId).toBe("r2");
	});

	it("returns an empty array before any expansion events", () => {
		const acc = new ContextAccumulator({ maxExpansionsPerIteration: 10 });
		expect(acc.getExpansionEvents()).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// resetPhase()
// ---------------------------------------------------------------------------

describe("ContextAccumulator.resetPhase", () => {
	it("removes only entries tagged with the given phaseId", () => {
		const acc = new ContextAccumulator({ maxExpansionsPerIteration: 10 });
		acc.accumulate(makeEntry("phase1", "task1", { content: "p1" }));
		acc.resetPhase("phase1");
		// Phase1 entries are cleared, phase2 can now be accumulated
		acc.accumulate(makeEntry("phase2", "task2", { content: "p2" }));
		expect(acc.getEntries("phase1", "task1")).toHaveLength(0);
		expect(acc.getEntries("phase2", "task2")).toHaveLength(1);
	});

	it("resets the expansion counter", () => {
		const acc = new ContextAccumulator({ maxExpansionsPerIteration: 1 });
		acc.recordExpansion(makeExpansionEvent("r1"));
		// Limit is now reached
		expect(acc.recordExpansion(makeExpansionEvent("r2")).ok).toBe(false);
		// Reset
		acc.accumulate(makeEntry("phase1", "task1"));
		acc.resetPhase("phase1");
		// Counter should be reset — can record again
		expect(acc.recordExpansion(makeExpansionEvent("r3")).ok).toBe(true);
	});

	it("clears only the specified phase, leaving accumulated state for other phases intact until their own reset", () => {
		const acc = new ContextAccumulator({ maxExpansionsPerIteration: 10 });
		acc.accumulate(makeEntry("phase1", "task1", { content: "p1" }));
		// Reset phase1; phase2 entries have not yet been added
		acc.resetPhase("phase1");
		acc.accumulate(makeEntry("phase2", "task1", { content: "p2" }));
		// phase1 cleared, phase2 intact
		expect(acc.getEntries("phase1", "task1")).toHaveLength(0);
		expect(acc.getEntries("phase2", "task1")).toHaveLength(1);
		// Now reset phase2
		acc.resetPhase("phase2");
		expect(acc.getEntries("phase2", "task1")).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// resetTask()
// ---------------------------------------------------------------------------

describe("ContextAccumulator.resetTask", () => {
	it("removes only entries tagged with the given taskId", () => {
		const acc = new ContextAccumulator({ maxExpansionsPerIteration: 10 });
		acc.accumulate(makeEntry("phase1", "task1", { content: "t1" }));
		acc.accumulate(makeEntry("phase1", "task2", { content: "t2" }));
		acc.resetTask("task1");
		expect(acc.getEntries("phase1", "task1")).toHaveLength(0);
		expect(acc.getEntries("phase1", "task2")).toHaveLength(1);
	});

	it("does not touch entries from other tasks", () => {
		const acc = new ContextAccumulator({ maxExpansionsPerIteration: 10 });
		acc.accumulate(makeEntry("phase1", "task1", { content: "t1a" }));
		acc.accumulate(makeEntry("phase1", "task1", { content: "t1b" }));
		acc.accumulate(makeEntry("phase1", "task2", { content: "t2" }));
		acc.resetTask("task2");
		// task1 should be untouched
		expect(acc.getEntries("phase1", "task1")).toHaveLength(2);
		expect(acc.getEntries("phase1", "task2")).toHaveLength(0);
	});

	it("resets the expansion counter", () => {
		const acc = new ContextAccumulator({ maxExpansionsPerIteration: 1 });
		acc.recordExpansion(makeExpansionEvent("r1"));
		acc.resetTask("task1");
		expect(acc.recordExpansion(makeExpansionEvent("r2")).ok).toBe(true);
	});
});
