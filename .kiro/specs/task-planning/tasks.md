# Implementation Plan

- [x] 1. Define planning domain types
  - Define status union types for steps and tasks, supporting the four lifecycle states: pending, in-progress, completed, and failed.
  - Define entity types for the full four-level planning hierarchy (plan → task → step) with readonly fields, including a step status history array that records ISO 8601 timestamps for each transition.
  - Define a discriminated event union covering all observable planning lifecycle events: plan creation, validation, revision, step start/complete/fail/escalate, human review activation, and plan completion/escalation.
  - Define the human review reason type for approval gate trigger classification.
  - Keep all types isolated in the domain layer with no dependencies on application or infrastructure layers.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 10.1_

- [x] 2. (P) Implement plan structure validator
- [x] 2.1 Implement validation logic
  - Build a stateless validator in the domain layer with no I/O side effects.
  - Phase 1: collect all step and task IDs across the plan and detect duplicates.
  - Phase 2: verify every dependency reference in steps points to an existing step within the same plan.
  - Phase 3: apply Kahn's topological sort to detect circular dependencies and produce a valid execution order when no cycles are present.
  - Accumulate all validation errors in a single pass and return them together in the result.
  - _Requirements: 1.5, 5.3, 6.1, 6.2, 6.3, 6.4, 6.5_

- [x] 2.2 Write unit tests for the validator
  - Verify duplicate ID detection covers both task and step IDs.
  - Verify that a dependency reference to a non-existent step produces a missing-dependency error.
  - Verify circular dependency detection for two-node (A→B→A) and longer multi-node cycles.
  - Verify that a valid directed acyclic graph produces a correct topological execution order.
  - Verify that steps with empty or omitted dependency arrays are treated as immediately eligible with no errors.
  - _Requirements: 1.5, 5.3, 6.1, 6.2, 6.3_

- [x] 3. Define application ports and option types
  - Define the public planner interface for callers to run and resume plans, list resumable plans, and signal a graceful stop.
  - Define the persistence port with save, load, and list-resumable operations.
  - Define a narrow context-assembly port for plan generation and revision prompt building, decoupled from the full context engine interface that requires agent state.
  - Define the human review gateway port and the event bus port.
  - Define all supporting option, outcome, result, and logger types, including the configurable step threshold, retry count, and skip-review flag.
  - _Requirements: 2.1, 2.3, 2.5, 7.1, 8.1, 8.3, 9.1, 9.5, 10.1, 10.2, 11.1, 11.3, 11.4, 11.5_

- [x] 4. (P) Implement plan file persistence
- [x] 4.1 Implement the file store adapter
  - Write the plan file store that saves plan state as JSON at `.memory/tasks/task_{id}.json`.
  - Use the atomic write pattern (write to a temp sibling file, datasync, then rename) to ensure no partial state is ever visible to readers.
  - Create the parent directory with recursive mkdir on first write; return null on a not-found error and throw for all other filesystem errors.
  - Run plan validation on every load result and throw a structured error when validation fails, preventing corrupted plans from reaching callers.
  - Implement list-resumable by scanning all JSON files in the directory and returning IDs of plans that still have tasks not yet completed or failed.
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

- [x] 4.2 Write tests for the file store
  - Verify a saved plan is fully readable and matches the original after a round-trip.
  - Verify that load returns null when the plan file does not exist.
  - Verify that a filesystem write error halts rather than continuing without persistence.
  - Verify that list-resumable returns only plans with incomplete tasks and excludes fully completed plans.
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

- [x] 5. (P) Implement the task planning service
- [x] 5.1 Build the plan generation pipeline
  - Assemble the LLM prompt for initial plan generation using the context builder with the goal and optional repository context.
  - Parse the LLM response as a plan with a newly assigned UUID plan ID; retry up to the configured parse-retry limit on responses that cannot be parsed.
  - Run structural validation on the generated plan and return a validation-error outcome immediately if validation fails.
  - Persist the initial plan to disk before any further processing.
  - Construct a minimal fallback prompt directly from the goal string when the context builder is unavailable, consistent with the existing agent loop service fallback pattern.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 6.4, 6.5, 8.1, 11.4_

- [x] 5.2 Implement the human review gate
  - Classify a plan as large when its total step count exceeds the configured threshold (default 10) and as high-risk when any step description matches the configured keyword list.
  - Pause execution and present the full plan to the human review gateway when either trigger is met.
  - If the reviewer times out, emit a plan-awaiting-review event, persist current state, and return a waiting-for-input outcome so the caller can resume later.
  - If the reviewer rejects the plan with feedback, incorporate the feedback, regenerate the affected plan sections, and re-present the revised plan for one additional pass; return human-rejected if the second pass also fails.
  - Skip the gate entirely when the skip-review flag is set.
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

- [x] 5.3 Build the step execution loop
  - Iterate through steps in the topological execution order computed by the validator.
  - Before executing each step, block on any unmet dependency steps and cascade-fail the step when a prerequisite is in failed status.
  - Set the step status to in-progress and persist the plan before invoking the agent loop; set it to completed and persist after the agent loop reports success.
  - Enforce at most one step in in-progress state at a time within a plan.
  - Expose the current step description, completed steps, goal, and remaining steps to the context builder for agent loop context injection.
  - Halt after the current step completes when a stop signal has been received.
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2, 5.4, 5.5, 11.1, 11.2, 11.3_

- [x] 5.4 Implement the failure recovery chain
  - On the first step failure, retry the step up to the configured maximum retry count (default 3).
  - On the second attempt, include the prior failure context (error message, failed action, agent observation) in the agent loop invocation to guide an improved approach.
  - After all retries are exhausted, generate a revised step plan using LLM-driven analysis of the failure context and attempt execution one final time.
  - If the revised step also fails, mark it as failed, cascade-fail all dependent steps, and return an escalated outcome with the full failure context.
  - Record each failure event with step ID, attempt number, error summary, and recovery action taken.
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

- [x] 5.5 Implement dynamic plan adjustment and observability
  - Detect plan-revision signals in agent loop results, extract the revised step list from the reflection output, validate the revision, and persist a revision event with both original and revised step content plus the reason.
  - Pause execution for human review before applying any revision that alters more than 50% of remaining steps.
  - Continue execution from the revised step only after the revision is committed to disk.
  - Emit structured plan events to the event bus and write each event to the logger as JSON when both are injected.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 10.1, 10.2, 10.3, 10.4, 10.5_

- [x] 5.6 Implement resume, stop, and dependency-availability checks
  - Implement resume to load the persisted plan, run validation on it, and continue execution from the first incomplete step without regenerating the plan.
  - Implement list-resumable by delegating to the plan store and returning IDs of all plans not yet completed or failed.
  - At service construction, verify that the agent loop, context builder, and LLM provider are all non-null; return a dependency-unavailable outcome immediately if any is missing rather than failing silently later.
  - _Requirements: 8.3, 11.5_

- [x] 6. Write unit tests for the task planning service
- [x] 6.1 (P) Test the plan generation and validation flow
  - Verify successful plan generation and execution using a mock agent loop that always returns task-completed.
  - Verify that an LLM parse failure triggers the parse-retry logic and returns an escalated outcome after exhaustion.
  - Verify that plan validation failure returns the validation-error outcome.
  - Verify that a stop signal halts execution after the current step completes without aborting mid-step.
  - _Requirements: 2.1, 2.2, 2.4, 2.5, 6.4_

- [x] 6.2 (P) Test the human review gate behavior
  - Verify the gate activates when step count exceeds the configured threshold.
  - Verify the gate is bypassed when the skip-review flag is true.
  - Verify rejection with feedback triggers one plan revision and re-presentation.
  - Verify double rejection returns the human-rejected outcome.
  - Verify review timeout returns the waiting-for-input outcome with the plan persisted and resumable.
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

- [x] 6.3 (P) Test failure recovery scenarios
  - Verify the first retry passes when the step succeeds on the second attempt.
  - Verify that failure context (error message and observation) is included in the agent loop invocation on the second attempt.
  - Verify all retries exhausted triggers LLM-driven plan revision before the final attempt.
  - Verify that a failed revised step returns the escalated outcome with the failed step ID.
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

- [x] 6.4 (P) Test dynamic plan adjustment and observability
  - Verify that a revision signal in an agent loop result triggers plan validation, revision event persistence with before/after content, and continued execution from the revised step.
  - Verify that the event bus receives the correct event types at each lifecycle milestone.
  - Verify that execution does not advance while a revision is in progress.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 10.1, 10.2, 10.3, 10.4, 10.5_

- [x] 7. Write integration tests for the full task-planning lifecycle
- [x] 7.1 Test the full plan generation and execution cycle
  - Run the full pipeline (generation → validation → human auto-approve → step execution → completion) using a stub agent loop that returns task-completed.
  - Verify the persisted plan JSON is readable and matches the expected structure after each step completion.
  - Verify the final outcome is completed and all steps are in completed status.
  - _Requirements: 2.1, 4.1, 4.2, 6.1, 8.1, 8.2, 8.5_

- [x] 7.2 Test crash recovery and resumption
  - Persist a plan in in-progress state, instantiate a fresh service instance, call resume with the plan ID, and verify execution continues from the last incomplete step rather than restarting.
  - Verify list-resumable returns the plan ID before resumption and excludes it after completion.
  - _Requirements: 8.3, 8.5_

- [x] 7.3 Test dependency failure cascade
  - Create a plan where step B depends on step A; configure the stub agent loop to exhaust all retries for step A.
  - Verify that step B is automatically set to failed status after step A escalates.
  - Verify the plan outcome is escalated with the correct failed step ID.
  - _Requirements: 5.1, 5.2, 5.4, 7.4_
