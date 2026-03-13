import type {
	IContextPlanner,
	LayerId,
	PlannerDecision,
	StepType,
	ToolResultEntry,
} from "../../application/ports/context";

/** Pre-computed, frozen layer lists per step type. */
const STEP_LAYERS: Readonly<Record<StepType, ReadonlyArray<LayerId>>> = Object.freeze({
	Exploration: Object.freeze<LayerId[]>([
		"systemInstructions",
		"taskDescription",
		"memoryRetrieval",
		"codeContext",
		"repositoryState",
	]),
	Modification: Object.freeze<LayerId[]>([
		"systemInstructions",
		"taskDescription",
		"memoryRetrieval",
		"codeContext",
		"activeSpecification",
	]),
	Validation: Object.freeze<LayerId[]>([
		"systemInstructions",
		"taskDescription",
		"memoryRetrieval",
		"toolResults",
		"activeSpecification",
	]),
});

/**
 * Pure domain implementation of IContextPlanner.
 * Maps step type and task context to a structured retrieval plan.
 * No I/O, no imports from application or adapter layers.
 */
export class ContextPlanner implements IContextPlanner {
	plan(
		stepType: StepType,
		taskDescription: string,
		_previousToolResults: ReadonlyArray<ToolResultEntry>,
	): PlannerDecision {
		return {
			layersToRetrieve: STEP_LAYERS[stepType],
			rationale: `stepType:${stepType} taskExcerpt:${taskDescription.slice(0, 100)}`,
		};
	}
}
