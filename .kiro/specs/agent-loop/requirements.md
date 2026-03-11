# Requirements Document

## Project Description (Input)

agent-loop

See section `spec4: agent-loop` at @docs/agent/dev-agent-v1-specs.md.

## Introduction

The Agent Loop is the cognitive core of the AI Dev Agent. It implements an iterative PLAN→ACT→OBSERVE→REFLECT→UPDATE cycle that drives autonomous task execution by coordinating LLM reasoning with deterministic tool invocations. This component operates above the tool system and below task planning, transforming a task description into completed, validated work through iterative self-correcting execution.

The agent-loop depends on spec1 (orchestrator-core) and spec2 (tool-system), and is itself a prerequisite for spec7 (task-planning).

## Requirements

### Requirement 1: Agent State Management

**Objective:** As an AI Dev Agent, I want persistent state tracked across iterations so that progress is not lost between reasoning steps and the loop can resume correctly after interruption.

#### Acceptance Criteria

1. The Agent Loop shall maintain an `AgentState` structure containing: `task` (string), `plan` (string[]), `completedSteps` (string[]), `currentStep` (string | null), `iterationCount` (number), and `observations` (Observation[]).
2. When a new task is received, the Agent Loop shall initialize a fresh `AgentState` with the task description and an empty plan, completedSteps, currentStep, and observations.
3. While a loop iteration is executing, the Agent Loop shall preserve the full `AgentState` across the PLAN→ACT→OBSERVE→REFLECT→UPDATE sequence without data loss.
4. If the agent loop is interrupted (process termination, error escalation), the Agent Loop shall allow the `AgentState` to be serialized and restored for resumption.
5. The Agent Loop shall support storing structured `Observation` entries that capture tool name, input parameters, raw output, and a human-readable summary.

---

### Requirement 2: PLAN Step — Action Planning

**Objective:** As an AI Dev Agent, I want to reason over current state and produce a concrete next action so that each iteration makes purposeful progress toward the task goal.

#### Acceptance Criteria

1. When the PLAN step executes, the Agent Loop shall pass to the LLM the current `AgentState` (task, plan, completedSteps, currentStep, observations) plus repository state, memory retrievals, and available tool schemas.
2. When the LLM produces a planning response, the Agent Loop shall parse it into an `ActionPlan` containing: the selected action type, the target tool name, and the structured tool input parameters.
3. The Agent Loop shall support four action categories in `ActionPlan`: Exploration (read/search), Modification (write/edit), Validation (test/build/lint), and Documentation (update docs/comments).
4. If the LLM response cannot be parsed into a valid `ActionPlan`, the Agent Loop shall retry the PLAN step up to a configurable number of times before escalating as a loop error.
5. The Agent Loop shall record the reasoning rationale from the LLM response alongside the `ActionPlan` for use in observability logging.

---

### Requirement 3: ACT Step — Tool Execution

**Objective:** As an AI Dev Agent, I want to execute planned actions through the tool system so that real changes are made to the development environment with deterministic, validated results.

#### Acceptance Criteria

1. When the ACT step executes, the Agent Loop shall invoke the tool specified in the `ActionPlan` via the Tool System's `ToolExecutor` interface, passing the validated input parameters.
2. The Agent Loop shall route all tool invocations exclusively through the Tool System's `ToolExecutor` interface, ensuring permission checks, schema validation, and timeout enforcement are applied on every call.
3. When the tool execution succeeds, the Agent Loop shall capture the full tool output as a raw result and pass it to the OBSERVE step.
4. If the tool execution fails with a `ToolError`, the Agent Loop shall capture the error type (`"validation" | "runtime" | "permission"`), message, and context and pass them to the OBSERVE step as a failed observation.
5. The Agent Loop shall enforce a per-tool-call timeout consistent with the Tool System's configured limits, treating timeout as a `runtime` error.

---

### Requirement 4: OBSERVE Step — Observation Recording

**Objective:** As an AI Dev Agent, I want to record structured observations from tool results so that subsequent reasoning steps have accurate, context-rich input.

#### Acceptance Criteria

1. When the OBSERVE step executes, the Agent Loop shall create a structured `Observation` from the tool result containing: tool name, input parameters, raw output or error, and a summary of what was learned (populated during the REFLECT step).
2. The Agent Loop shall append the new `Observation` to `AgentState.observations` so it is available in all subsequent PLAN steps of the current task.
3. The Agent Loop shall support observations representing: file contents, command output, test results, error messages, git diff output, and code analysis results.
4. While observations accumulate, the Agent Loop shall provide the most recent N observations to the PLAN step context, where N is determined by the context token budget.

---

### Requirement 5: REFLECT Step — Evaluation and Adaptation

**Objective:** As an AI Dev Agent, I want to evaluate whether the last action produced the expected result so that the plan is adjusted when new information changes the approach.

#### Acceptance Criteria

1. When the REFLECT step executes, the Agent Loop shall provide the LLM with the current `AgentState`, the latest `Observation`, and the original `ActionPlan` rationale, and request an evaluation response.
2. The Agent Loop shall parse the reflection response into: a result assessment (expected / unexpected / failure), a list of new learnings, and a plan adjustment recommendation (continue / revise / stop).
3. When the reflection assessment is `"unexpected"` or plan adjustment is `"revise"`, the Agent Loop shall update `AgentState.plan` with the revised steps before proceeding to UPDATE STATE.
4. When the reflection assessment is `"failure"` and the error recovery policy applies, the Agent Loop shall transition to the error recovery sub-loop rather than continuing normal iteration.
5. The Agent Loop shall store reflection outputs as metadata on the associated `Observation` for observability.

---

### Requirement 6: UPDATE STATE Step — Progress Tracking

**Objective:** As an AI Dev Agent, I want to update the agent state after each iteration so that the loop maintains accurate progress records and subsequent planning uses current information.

#### Acceptance Criteria

1. When the UPDATE STATE step executes, the Agent Loop shall move `AgentState.currentStep` to `AgentState.completedSteps` if the reflection assessment is `"expected"` or `"unexpected"` (non-failure).
2. When a plan revision was produced in REFLECT, the Agent Loop shall replace `AgentState.plan` with the revised plan and set the new `AgentState.currentStep` to the first incomplete step.
3. The Agent Loop shall update `AgentState.currentStep` to the next pending step from `AgentState.plan` after a successful step completion.
4. The Agent Loop shall increment the iteration counter in agent state after each complete PLAN→ACT→OBSERVE→REFLECT→UPDATE cycle.

---

### Requirement 7: Iteration Control and Stopping Conditions

**Objective:** As an AI Dev Agent, I want enforced limits and clear stopping conditions so that the loop terminates gracefully and predictably without running indefinitely.

#### Acceptance Criteria

1. The Agent Loop shall accept a `maxIterations` configuration parameter (default: 50) and enforce it across all iterations of a single task execution.
2. When the iteration count reaches `maxIterations`, the Agent Loop shall stop execution, emit a `MAX_ITERATIONS_REACHED` termination event, log a summary of progress made, and propose next steps.
3. When the REFLECT step produces a plan adjustment of `"stop"` with task-complete status, the Agent Loop shall emit a `TASK_COMPLETED` termination event and return the final `AgentState`.
4. When the Agent Loop requires human clarification (ambiguous requirement detected, approval needed), the Agent Loop shall pause execution, emit a `HUMAN_INTERVENTION_REQUIRED` event with context, and await external input before resuming.
5. If the agent-safety layer signals an emergency stop, the Agent Loop shall halt immediately, finalize in-progress tool calls, and emit a `SAFETY_STOP` termination event.
6. The Agent Loop shall expose a `stop()` method that triggers graceful termination from external callers (e.g., orchestrator-core phase transitions).

---

### Requirement 8: Error Recovery Sub-Loop

**Objective:** As an AI Dev Agent, I want intra-loop error recovery so that transient failures (failing tests, compilation errors, runtime exceptions) are resolved autonomously before escalating to the outer system.

#### Acceptance Criteria

1. When an error is detected (tool failure, test failure, build failure), the Agent Loop shall enter an error recovery sub-loop: analyze error → identify root cause → attempt fix → re-run validation.
2. The Agent Loop shall track recovery attempts per error occurrence and apply a configurable `maxRecoveryAttempts` limit (default: 3) before escalating.
3. When the error recovery sub-loop resolves the error (validation passes), the Agent Loop shall resume normal iteration from the step that originally failed.
4. When recovery attempts are exhausted without resolution, the Agent Loop shall emit a `RECOVERY_EXHAUSTED` event, record the failure context in `AgentState`, and stop with the `HUMAN_INTERVENTION_REQUIRED` termination condition.
5. If the same error occurs at or above the `maxRecoveryAttempts` threshold in a single task execution without recovery, the Agent Loop shall detect this as a repeated failure pattern and immediately escalate rather than retrying further.

---

### Requirement 9: Observability and Structured Logging

**Objective:** As a system operator and developer, I want per-iteration structured logs so that agent behavior can be analyzed, debugged, and audited after execution.

#### Acceptance Criteria

1. The Agent Loop shall emit a structured log entry at the completion of each iteration containing: iteration number, action type, tool(s) invoked, input parameters (redacted where sensitive), result status (success/failure), execution time in milliseconds, and reflection assessment.
2. The Agent Loop shall emit structured events for all termination conditions: `TASK_COMPLETED`, `MAX_ITERATIONS_REACHED`, `HUMAN_INTERVENTION_REQUIRED`, `SAFETY_STOP`, `RECOVERY_EXHAUSTED`.
3. The Agent Loop shall log the start and end of each sub-step (PLAN, ACT, OBSERVE, REFLECT, UPDATE STATE) with timestamps to support performance analysis.
4. While the loop is executing, the Agent Loop shall make the current `AgentState` (iteration count, currentStep, completedSteps count) available via a status query interface without interrupting execution.
5. The Agent Loop shall produce a final execution summary on termination that includes: total iterations, steps completed, tools invoked (by type), errors encountered, and terminal condition.

---

### Requirement 10: Integration with Tool System

**Objective:** As an AI Dev Agent, I want clean integration with the Tool System (spec2) so that all tool invocations are mediated through the registered tool executor with full permission enforcement.

#### Acceptance Criteria

1. The Agent Loop shall depend only on the Tool System's `ToolExecutor` interface and `ToolRegistry`, with no direct imports of tool implementations.
2. When the Agent Loop is initialized, it shall receive an injected `ToolExecutor` and `ToolRegistry` instance via constructor dependency injection.
3. The Agent Loop shall retrieve available tool schemas from `ToolRegistry` at initialization time and include them in every PLAN step context so the LLM knows what actions are possible.
4. When a tool invocation is denied by the permission system, the Agent Loop shall treat it as a `permission` ToolError and apply error recovery logic.
5. The Agent Loop shall validate each tool invocation against the current schema retrieved from `ToolRegistry` on every call, including consecutive iterations that invoke the same tool.

---

### Requirement 11: Integration with Orchestrator Core

**Objective:** As the orchestrator-core, I want a well-defined Agent Loop interface so that it can be started, stopped, and observed as part of the broader workflow lifecycle.

#### Acceptance Criteria

1. The Agent Loop shall expose a `run(task: string, options: AgentLoopOptions): Promise<AgentLoopResult>` method as its primary public interface.
2. The `AgentLoopResult` shall include: termination condition, final `AgentState`, total iterations consumed, and a boolean indicating whether the task was completed successfully.
3. When the orchestrator-core requests a stop via the `stop()` method during execution, the Agent Loop shall complete the current sub-step, then halt at the next PLAN step boundary.
4. The Agent Loop shall accept an `AgentLoopOptions` object that configures: `maxIterations`, `maxRecoveryAttempts`, `contextProvider` (for 7-layer context injection), and `logger`.
5. Where the context engineering system (spec6) is available, the Agent Loop shall delegate context assembly to the injected `contextProvider` rather than assembling context directly.
6. The Agent Loop shall invoke all LLM calls exclusively through the LLM provider abstraction from spec1, with no direct imports of provider-specific SDKs (e.g., Anthropic SDK) in the agent-loop module.
