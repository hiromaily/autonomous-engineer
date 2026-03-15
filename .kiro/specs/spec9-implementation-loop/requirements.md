# Requirements Document

## Project Description (Input)

implementation-loop

See section `spec9: implementation-loop` at @docs/agent/dev-agent-v1-specs.md.

## Introduction

The Implementation Loop (spec9) is the orchestration layer that drives autonomous code production for each task section in the development plan. It coordinates the agent loop, context engine, and git integration to execute a structured **Implement → Review → Improve → Commit** cycle per task section. Quality gates enforce that no section proceeds to commit until it meets defined review criteria. When a section exhausts its retry budget, the loop escalates to the self-healing-loop (spec10).

This spec depends on: spec4 (agent-loop), spec6 (context-engine), spec7 (task-planning), spec8 (git-integration).

---

## Requirements

### Requirement 1: Task Section Execution

**Objective:** As an autonomous engineering system, I want to iterate through every task section from the task plan and drive each one through implementation, so that all planned work is executed without manual intervention.

#### Acceptance Criteria

1. When the implementation loop is started with a valid task plan, the Implementation Loop shall iterate through all task sections in the order defined by the plan.
2. When beginning a task section, the Implementation Loop shall initialize a fresh context using the context-engine, loading only the artifacts relevant to that section (task description, referenced design docs, related source files).
3. When a task section completes successfully, the Implementation Loop shall update the task plan to mark that section as `completed` before proceeding to the next section.
4. If a task section has unresolved `dependsOn` sections, the Implementation Loop shall defer execution of that section until all dependencies are marked `completed`.
5. The Implementation Loop shall record the outcome of each section (succeeded, failed, escalated) in the execution log.
6. When all task sections in the plan are marked `completed`, the Implementation Loop shall emit a `plan-completed` event to the workflow engine signaling that the implementation phase is finished.

---

### Requirement 2: Agent Loop Invocation

**Objective:** As an autonomous engineering system, I want to invoke the agent loop for each task section with the correct context, so that the agent loop can produce implementation output without requiring additional orchestration logic.

#### Acceptance Criteria

1. When executing a task section, the Implementation Loop shall invoke the agent loop (spec4) with the section description, the prepared context, and the tool permissions required for that section.
2. While the agent loop is executing a task section, the Implementation Loop shall not modify the active context or interfere with tool execution.
3. When the agent loop returns a result, the Implementation Loop shall capture the full result — including all tool call records and observations — for use in the review step.
4. If the agent loop terminates due to a safety limit or iteration limit, the Implementation Loop shall treat this as a section failure and increment the retry counter for that section.

---

### Requirement 3: Review Engine

**Objective:** As an autonomous engineering system, I want an automated review engine to evaluate each implementation output against defined quality criteria, so that code quality issues are caught before committing.

#### Acceptance Criteria

1. When the agent loop completes an implementation step, the Implementation Loop shall invoke the review engine to evaluate the output.
2. The review engine shall check requirement alignment: the implemented output satisfies the acceptance criteria defined in the relevant task section and spec.
3. The review engine shall check design consistency: the implemented output follows the architectural patterns and interfaces defined in the design document.
4. The review engine shall check code quality: the output passes linting, includes adequate test coverage, and follows project naming conventions.
5. When the review engine produces feedback, the Implementation Loop shall structure the feedback as a list of actionable items that can be passed to the agent loop for improvement.
6. If all review checks pass, the review engine shall emit a `review-passed` signal; if any check fails, it shall emit a `review-failed` signal with the list of failing criteria.

---

### Requirement 4: Implement-Review-Improve-Commit Cycle

**Objective:** As an autonomous engineering system, I want each task section to go through an iterative implement → review → improve → commit cycle, so that suboptimal initial implementations are refined before being committed.

#### Acceptance Criteria

1. When the review engine emits `review-passed` for a task section, the Implementation Loop shall invoke the git integration (spec8) to commit the changes for that section.
2. When the review engine emits `review-failed` for a task section, the Implementation Loop shall invoke the agent loop again with the review feedback injected into the context as an improvement directive.
3. While the improve step is executing, the Implementation Loop shall preserve all observations and tool results from the previous implement step so the agent loop has full context of what was already attempted.
4. When a commit is made, the Implementation Loop shall provide a descriptive commit message that references the task section and summarizes the changes made.
5. The Implementation Loop shall not commit partial output; a commit is only permitted after a `review-passed` signal is received.

---

### Requirement 5: Iteration Control

**Objective:** As an autonomous engineering system, I want a configurable retry threshold per task section, so that runaway retry loops are prevented and persistently failing sections are identified for escalation.

#### Acceptance Criteria

1. The Implementation Loop shall maintain a per-section retry counter that is incremented each time the implement-review cycle fails for that section.
2. The Implementation Loop shall accept a configurable `maxRetriesPerSection` parameter with a default value of 3.
3. If a task section's retry counter reaches `maxRetriesPerSection` without passing the quality gate, the Implementation Loop shall stop retrying that section.
4. When a task section exceeds `maxRetriesPerSection`, the Implementation Loop shall emit an escalation event containing the section ID, all retry history, and the accumulated review feedback.
5. While a retry is in progress, the Implementation Loop shall log each iteration number, the review feedback provided, and the outcome of the improvement attempt.

---

### Requirement 6: Quality Gate

**Objective:** As an autonomous engineering system, I want a quality gate that enforces review pass criteria before any commit occurs, so that only output that meets the defined standard is persisted to the repository.

#### Acceptance Criteria

1. The Implementation Loop shall define a quality gate as a set of named review checks that must all emit `passed` before a section may proceed to commit.
2. When any quality gate check emits `failed`, the Implementation Loop shall block the commit step and route the section back to the improve step.
3. The Implementation Loop shall expose configuration for which quality gate checks are required versus advisory, so that non-blocking checks produce warnings without blocking commits.
4. Where linting or test execution is configured as a required gate check, the Implementation Loop shall run the relevant tool (via spec2) and parse its exit code or output to determine pass/fail.
5. The Implementation Loop shall record each gate check result (check name, result, details) in the structured log entry for the affected section.

---

### Requirement 7: Escalation to Self-Healing Loop

**Objective:** As an autonomous engineering system, I want persistently failing sections to be escalated to the self-healing loop, so that the system can attempt to recover through rule analysis rather than simply reporting failure.

#### Acceptance Criteria

1. When a task section escalation event is emitted, the Implementation Loop shall transfer the section ID, retry history, review feedback, and agent loop observations to the self-healing loop (spec10).
2. When the self-healing loop returns a `resolved` outcome for an escalated section, the Implementation Loop shall resume execution of that section with the updated rules injected into context, resetting the retry counter.
3. When the self-healing loop returns an `unresolved` outcome, the Implementation Loop shall mark the section as `escalated-to-human` and pause execution of the entire plan.
4. If the self-healing loop is not available or not configured, the Implementation Loop shall fall back to marking the section as `failed` and halting plan execution after notifying the operator.
5. The Implementation Loop shall emit a human-readable summary when halting, listing which sections completed, which were committed, and which section triggered the halt.

---

### Requirement 8: Context Isolation Per Section

**Objective:** As an autonomous engineering system, I want each task section to start with an isolated context, so that observations and tool results from one section do not pollute the reasoning of subsequent sections.

#### Acceptance Criteria

1. When the Implementation Loop begins a new task section, the Implementation Loop shall request a fresh context snapshot from the context-engine, discarding accumulated tool results from the previous section.
2. The Implementation Loop shall retain the following across sections: the task plan, completed-section summaries, and the active feature branch name.
3. If the context-engine detects that the token budget for a section would be exceeded, the Implementation Loop shall accept the compressed context from the context-engine rather than attempting to expand it manually.
4. While an improve step is executing within the same section, the Implementation Loop shall allow context to accumulate (observations from the implement step are preserved for the improve step).

---

### Requirement 9: Plan Resumption After Interruption

**Objective:** As an autonomous engineering system, I want the implementation loop to resume from the last incomplete task section after a crash or restart, so that completed work is not duplicated and execution can continue without starting over.

#### Acceptance Criteria

1. When the Implementation Loop is started and a persisted plan exists with sections in `in_progress` or `pending` state, the Implementation Loop shall resume from the first non-`completed` section rather than restarting from the beginning.
2. When resuming, the Implementation Loop shall re-initialize context for the resumed section as if it were starting fresh, discarding any transient in-memory state from the prior interrupted run.
3. If a section was `in_progress` at the time of interruption, the Implementation Loop shall treat it as incomplete and restart the implement-review-improve-commit cycle for that section (not continue mid-cycle).
4. The Implementation Loop shall read plan state exclusively from the persisted plan store (spec7) at startup; it shall not depend on in-memory state surviving across process restarts.

---

### Requirement 10: Observability and Structured Logging

**Objective:** As an autonomous engineering system, I want structured, per-iteration logs for every section execution, so that failures can be diagnosed and the execution trace can be used by the self-healing loop or human reviewers.

#### Acceptance Criteria

1. The Implementation Loop shall emit a structured log entry for each iteration of the implement-review-improve-commit cycle, including: section ID, iteration number, review result, gate check outcomes, and commit SHA (if committed).
2. When an escalation or halt occurs, the Implementation Loop shall produce a consolidated execution report summarizing all sections and their final statuses.
3. The Implementation Loop shall write execution logs in a machine-parseable format (JSON or structured text) to a path accessible by the memory system (spec5).
4. The Implementation Loop shall measure and log elapsed time per section so that slow sections can be identified for plan optimization.
