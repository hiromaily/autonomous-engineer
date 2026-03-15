# Requirements Document

## Introduction

The Task Planning system is the hierarchical planning layer of the Autonomous Engineer that sits above the Agent Loop. It transforms a high-level engineering goal (typically sourced from a cc-sdd task list) into a structured, executable plan composed of Goals, Tasks, Steps, and Actions. The system guides the sequence of work the Agent Loop operates on, provides dynamic plan adjustment as execution reveals new information, persists plan state to enable resumable execution after interruption, and exposes human review gates for large or high-risk changes.

This specification covers `spec7: task-planning` as defined in `docs/agent/dev-agent-v1-specs.md`. It depends on `spec4: agent-loop` and `spec6: context-engine`.

## Requirements

### Requirement 1: Planning Hierarchy

**Objective:** As an autonomous engineer operator, I want the system to decompose any engineering goal into a structured four-level hierarchy (Goal → Tasks → Steps → Actions), so that complex work is organized at appropriate granularity and the agent loop receives well-scoped units of work.

#### Acceptance Criteria

1. The Task Planning System shall represent every plan as a `TaskPlan` with a `goal` string and an ordered list of `Task` objects.
2. The Task Planning System shall represent each `Task` with a unique `id`, a `title`, a `status` of `"pending" | "in_progress" | "completed" | "failed"`, and an ordered list of `Step` objects.
3. The Task Planning System shall represent each `Step` with a unique `id`, a `description`, a `status` of `"pending" | "in_progress" | "completed" | "failed"`, and an optional `dependsOn` array of step IDs.
4. The Task Planning System shall ensure that Steps are granular enough to be completed within a bounded Agent Loop iteration — describing concrete operations rather than open-ended goals.
5. The Task Planning System shall validate that every `Task` and `Step` ID is unique within a given plan and report a validation error if duplicates are detected.

---

### Requirement 2: Initial Plan Generation

**Objective:** As an autonomous engineer operator, I want the system to automatically generate an initial plan from a task description and available context, so that the agent can begin structured execution without manual plan authoring.

#### Acceptance Criteria

1. When a new task is received, the Task Planning System shall generate an initial `TaskPlan` using the task description, relevant architecture documents, repository context, and prior knowledge retrieved from the memory system.
2. When generating an initial plan, the Task Planning System shall produce at least one `Task` with at least one `Step` to ensure the plan is actionable.
3. The Task Planning System shall use the Context Engine to construct the LLM prompt for plan generation, respecting configured token budgets.
4. The Task Planning System shall treat the initial plan as a starting point — not a rigid script — and allow revision during execution.
5. If the task description is empty or cannot be parsed, the Task Planning System shall reject plan generation and return a structured error identifying the missing input.

---

### Requirement 3: Dynamic Plan Adjustment

**Objective:** As an autonomous engineer operator, I want the plan to be revisable mid-execution when the agent discovers new information, so that the agent adapts to the actual state of the codebase rather than following an outdated plan.

#### Acceptance Criteria

1. When an Agent Loop observation reveals that a planned step is no longer appropriate (e.g., an existing module already satisfies the requirement), the Task Planning System shall allow that step to be revised or replaced.
2. When a Step is revised, the Task Planning System shall update the persisted plan record to reflect the current plan state before continuing execution.
3. While a plan revision is in progress, the Task Planning System shall not advance execution to the next step until the revision is committed.
4. The Task Planning System shall log each plan revision event with the original step description, the revised step description, and the reason for revision.
5. If a plan revision would alter more than 50% of remaining steps, the Task Planning System shall pause execution and present the revised plan for human review before proceeding.

---

### Requirement 4: Step Execution Model

**Objective:** As an autonomous engineer operator, I want each Step to be handed off to the Agent Loop for execution and for its status to be updated based on the outcome, so that the Task Planning System maintains accurate progress tracking throughout execution.

#### Acceptance Criteria

1. When the Task Planning System begins executing a Step, it shall set the Step's `status` to `"in_progress"` and update the persisted plan before invoking the Agent Loop.
2. When the Agent Loop reports successful completion of a Step, the Task Planning System shall set the Step's `status` to `"completed"` and persist the updated plan.
3. When the Agent Loop reports a failure for a Step, the Task Planning System shall set the Step's `status` back to `"pending"` and initiate the failure recovery sequence.
4. The Task Planning System shall expose the current Step context (description, goal, prior completed steps) to the Context Engine for injection into the Agent Loop's prompt.
5. The Task Planning System shall enforce that only one Step is `"in_progress"` at a time per Task during sequential execution.

---

### Requirement 5: Dependency Tracking

**Objective:** As an autonomous engineer operator, I want steps with declared dependencies to execute only after their prerequisites are complete, so that the implementation follows a correct ordering and avoids referencing artifacts that have not yet been created.

#### Acceptance Criteria

1. The Task Planning System shall refuse to begin execution of a Step whose `dependsOn` list contains any step not yet in `"completed"` status.
2. When all prerequisites of a Step are `"completed"`, the Task Planning System shall automatically advance the Step to the execution queue.
3. If a circular dependency is detected within a plan's `dependsOn` references, the Task Planning System shall reject the plan and return a validation error identifying the cycle.
4. The Task Planning System shall support an empty `dependsOn` array (or omitted field) to indicate a step with no prerequisites, which is immediately eligible for execution.
5. Where parallel execution is not enabled, the Task Planning System shall execute all steps sequentially in declaration order, subject to dependency constraints.

---

### Requirement 6: Plan Validation

**Objective:** As an autonomous engineer operator, I want the system to validate a plan for architectural compatibility and structural correctness before execution begins, so that likely errors are caught early and do not cause wasted agent loop iterations.

#### Acceptance Criteria

1. Before starting execution of a plan, the Task Planning System shall check that all step IDs referenced in `dependsOn` arrays exist within the same plan.
2. Before starting execution, the Task Planning System shall verify that the plan contains no circular step dependencies, as defined in Requirement 5.
3. Where architectural compatibility checks are configured, the Task Planning System shall validate that the planned steps do not contradict declared architecture constraints (e.g., adapter imports in domain layer) before execution.
4. If any validation check fails, the Task Planning System shall halt execution, report all validation errors, and require the plan to be corrected before retrying.
5. The Task Planning System shall complete plan validation within a bounded time and not block indefinitely on external resource unavailability.

---

### Requirement 7: Failure Recovery

**Objective:** As an autonomous engineer operator, I want the system to attempt automatic recovery when a step fails before escalating to the self-healing loop or human review, so that transient failures are resolved without manual intervention.

#### Acceptance Criteria

1. If a Step fails, the Task Planning System shall first retry the step up to a configurable maximum retry count (default: 3) before escalating.
2. If a Step fails on the second attempt, the Task Planning System shall provide the Agent Loop with the prior failure context (error message, failed action, observation) to guide an improved approach.
3. If a Step fails on every retry attempt, the Task Planning System shall revise the affected portion of the plan using LLM-driven analysis of the failure before attempting one final execution.
4. If the revised step also fails, the Task Planning System shall escalate to the self-healing loop (spec10) with the full failure context and mark the step as `"failed"`.
5. The Task Planning System shall record each failure event — including the step ID, attempt number, error summary, and recovery action taken — in the persisted plan record.

---

### Requirement 8: Plan Persistence

**Objective:** As an autonomous engineer operator, I want plans to be persisted to disk throughout execution so that the agent can resume work after an interruption or crash without losing progress.

#### Acceptance Criteria

1. The Task Planning System shall write the full plan state to `.memory/tasks/task_{id}.json` immediately after initial plan generation.
2. When any Step status changes, the Task Planning System shall update the persisted plan file before advancing to the next step.
3. When the Task Planning System starts and detects an existing persisted plan for the current task that is not in `"completed"` status, it shall offer to resume from the last known state rather than regenerating the plan.
4. If a plan file cannot be written due to a filesystem error, the Task Planning System shall log the error and halt execution rather than continuing without persistence.
5. The Task Planning System shall store persisted plans in a human-readable JSON format that includes `goal`, `tasks`, `steps`, statuses, and timestamps for each status change.

---

### Requirement 9: Human Interaction and Approval

**Objective:** As an autonomous engineer operator, I want to review and optionally modify plans for large or high-risk changes before execution begins, so that I maintain oversight over significant automated work.

#### Acceptance Criteria

1. When a generated plan is classified as large (more than a configurable step threshold, default: 10 steps) or high-risk (involves file deletion, protected-branch operations, or schema migrations), the Task Planning System shall pause and present the full plan for human review before execution.
2. While awaiting human approval, the Task Planning System shall display the complete plan in a readable format including goal, tasks, steps, and dependency relationships.
3. When the human approves the plan, the Task Planning System shall proceed with execution from the first pending step.
4. When the human rejects the plan or provides modification instructions, the Task Planning System shall incorporate the feedback, regenerate the affected plan sections, and present the revised plan for re-approval.
5. If no human response is received within a configurable timeout period, the Task Planning System shall pause execution and emit a waiting-for-input event rather than proceeding autonomously.

---

### Requirement 10: Observability and Logging

**Objective:** As an autonomous engineer operator, I want all planning and execution events to be logged in a structured format, so that I can analyze agent performance, diagnose failures, and understand how the plan evolved.

#### Acceptance Criteria

1. The Task Planning System shall emit a structured log event for each of the following occurrences: plan creation, step status change, plan revision, failure recovery attempt, human review gate activation, and plan completion.
2. Each log event shall include at minimum: timestamp, event type, plan ID, task ID (if applicable), step ID (if applicable), and a human-readable summary.
3. The Task Planning System shall log plan revision events with both the original and revised step content to enable before/after comparison.
4. If a step fails, the Task Planning System shall include the error message and recovery action in the failure log event.
5. The Task Planning System shall support a structured log format (JSON) compatible with the audit logging infrastructure established in spec3 (agent-safety).

---

### Requirement 11: Integration with Agent Loop and Context Engine

**Objective:** As an autonomous engineer operator, I want the Task Planning System to integrate cleanly with the Agent Loop (spec4) and Context Engine (spec6) through their defined interfaces, so that planning artifacts flow correctly into the agent's reasoning without tight coupling.

#### Acceptance Criteria

1. The Task Planning System shall invoke the Agent Loop through the `AgentLoopService` interface defined in spec4, passing the current step description and task context.
2. The Task Planning System shall provide the current plan state (goal, completed steps, current step, next steps) to the Context Engine for inclusion in the Agent Loop's context window.
3. When the Task Planning System requests context assembly, it shall specify the relevant spec sections and architecture documents needed for the current step so the Context Engine can populate the appropriate context layers.
4. The Task Planning System shall not directly call LLM providers; all LLM interactions shall be mediated through the Context Engine and Agent Loop.
5. If the Agent Loop or Context Engine is unavailable, the Task Planning System shall halt execution and emit a dependency-unavailable error rather than degrading silently.
