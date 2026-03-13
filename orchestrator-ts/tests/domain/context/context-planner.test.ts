/**
 * Unit tests for domain/context/context-planner.ts (Task 3, Task 10.1)
 * TDD: tests written before implementation.
 */
import { describe, expect, it } from "bun:test";
import type { LayerId, ToolResultEntry } from "../../../application/ports/context";
import { ContextPlanner } from "../../../domain/context/context-planner";

const noTools: ReadonlyArray<ToolResultEntry> = [];

describe("ContextPlanner", () => {
	const planner = new ContextPlanner();

	describe("always-present layers", () => {
		it("includes systemInstructions in all step types", () => {
			for (const stepType of ["Exploration", "Modification", "Validation"] as const) {
				const decision = planner.plan(stepType, "some task", noTools);
				expect(decision.layersToRetrieve).toContain("systemInstructions" satisfies LayerId);
			}
		});

		it("includes taskDescription in all step types", () => {
			for (const stepType of ["Exploration", "Modification", "Validation"] as const) {
				const decision = planner.plan(stepType, "some task", noTools);
				expect(decision.layersToRetrieve).toContain("taskDescription" satisfies LayerId);
			}
		});

		it("includes memoryRetrieval in all step types", () => {
			for (const stepType of ["Exploration", "Modification", "Validation"] as const) {
				const decision = planner.plan(stepType, "some task", noTools);
				expect(decision.layersToRetrieve).toContain("memoryRetrieval" satisfies LayerId);
			}
		});
	});

	describe("Exploration step", () => {
		it("includes codeContext in layersToRetrieve", () => {
			const decision = planner.plan("Exploration", "Explore the codebase", noTools);
			expect(decision.layersToRetrieve).toContain("codeContext" satisfies LayerId);
		});

		it("includes repositoryState in layersToRetrieve", () => {
			const decision = planner.plan("Exploration", "Explore the codebase", noTools);
			expect(decision.layersToRetrieve).toContain("repositoryState" satisfies LayerId);
		});

		it("does not include activeSpecification", () => {
			const decision = planner.plan("Exploration", "Explore the codebase", noTools);
			expect(decision.layersToRetrieve).not.toContain("activeSpecification" satisfies LayerId);
		});

		it("does not include toolResults", () => {
			const decision = planner.plan("Exploration", "Explore the codebase", noTools);
			expect(decision.layersToRetrieve).not.toContain("toolResults" satisfies LayerId);
		});
	});

	describe("Modification step", () => {
		it("includes codeContext in layersToRetrieve", () => {
			const decision = planner.plan("Modification", "Modify the service", noTools);
			expect(decision.layersToRetrieve).toContain("codeContext" satisfies LayerId);
		});

		it("includes activeSpecification in layersToRetrieve", () => {
			const decision = planner.plan("Modification", "Modify the service", noTools);
			expect(decision.layersToRetrieve).toContain("activeSpecification" satisfies LayerId);
		});

		it("does not include repositoryState", () => {
			const decision = planner.plan("Modification", "Modify the service", noTools);
			expect(decision.layersToRetrieve).not.toContain("repositoryState" satisfies LayerId);
		});

		it("does not include toolResults", () => {
			const decision = planner.plan("Modification", "Modify the service", noTools);
			expect(decision.layersToRetrieve).not.toContain("toolResults" satisfies LayerId);
		});
	});

	describe("Validation step", () => {
		it("includes toolResults in layersToRetrieve", () => {
			const decision = planner.plan("Validation", "Validate the output", noTools);
			expect(decision.layersToRetrieve).toContain("toolResults" satisfies LayerId);
		});

		it("includes activeSpecification in layersToRetrieve", () => {
			const decision = planner.plan("Validation", "Validate the output", noTools);
			expect(decision.layersToRetrieve).toContain("activeSpecification" satisfies LayerId);
		});

		it("does not include codeContext", () => {
			const decision = planner.plan("Validation", "Validate the output", noTools);
			expect(decision.layersToRetrieve).not.toContain("codeContext" satisfies LayerId);
		});

		it("does not include repositoryState", () => {
			const decision = planner.plan("Validation", "Validate the output", noTools);
			expect(decision.layersToRetrieve).not.toContain("repositoryState" satisfies LayerId);
		});
	});

	describe("rationale", () => {
		it("contains the stepType in rationale", () => {
			const decision = planner.plan("Exploration", "task description here", noTools);
			expect(decision.rationale).toContain("stepType:Exploration");
		});

		it("contains a task description excerpt in rationale", () => {
			const task = "Fix the authentication service to handle expired tokens correctly";
			const decision = planner.plan("Modification", task, noTools);
			expect(decision.rationale).toContain("taskExcerpt:");
			expect(decision.rationale).toContain(task.slice(0, 100));
		});

		it("uses only the first 100 characters of taskDescription in rationale", () => {
			const longTask = "A".repeat(200);
			const decision = planner.plan("Validation", longTask, noTools);
			const expected = `stepType:Validation taskExcerpt:${"A".repeat(100)}`;
			expect(decision.rationale).toBe(expected);
		});
	});

	describe("return type shape", () => {
		it("returns a PlannerDecision with required fields", () => {
			const decision = planner.plan("Exploration", "task", noTools);
			expect(Array.isArray(decision.layersToRetrieve)).toBe(true);
			expect(typeof decision.rationale).toBe("string");
		});
	});
});
