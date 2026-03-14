# Implementation Plan

## Task Overview

- **Total**: 7 major tasks, 27 sub-tasks
- **Requirements covered**: All 10 requirements (1–10), all 48 acceptance criteria
- **Parallelism**: (P) markers applied where tasks have no data, file, or approval dependencies

---

- [ ] 1. Define domain types and port contracts
- [x] 1.1 Define domain types for implementation-loop execution state
  - Implement `SectionExecutionStatus` discriminated union (`"pending"`, `"in_progress"`, `"completed"`, `"failed"`, `"escalated-to-human"`)
  - Implement `SectionExecutionRecord` as a fully readonly type capturing section ID, plan ID, title, status, retry count, iteration history, timestamps, commit SHA, and escalation summary
  - Implement `SectionIterationRecord` as a readonly log of a single implement-review-improve attempt (iteration number, agent loop result, review result, improve prompt, duration, timestamp)
  - Implement `ImplementationLoopState` for cross-section persistent state (plan ID, feature branch name, completed section summaries, start time)
  - Implement `SectionSummary`, `SectionEscalation`, `SelfHealingOutcome`, and `SelfHealingResult` value types
  - Implement `ImplementationLoopEvent` as a discriminated union covering all 8 lifecycle event variants (`section:start`, `section:completed`, `section:review-passed`, `section:review-failed`, `section:improve-start`, `section:escalated`, `plan:completed`, `plan:halted`)
  - No imports from `domain/planning/` — use `string` sectionId references to avoid coupling
  - All types must be `Readonly<>` or `ReadonlyArray<>`; no `any`
  - _Requirements: 5.1, 8.2, 10.1_

- [x] 1.2 (P) Define the `IImplementationLoop` port and supporting option/result types
  - Define `IImplementationLoop` service interface with `run(planId, options?)`, `resume(planId, options?)`, and `stop()` methods
  - Define `ImplementationLoopOptions` with `maxRetriesPerSection` (default 3), `qualityGateConfig`, optional `selfHealingLoop`, optional `eventBus`, and optional `logger`
  - Define `ImplementationLoopOutcome` discriminated string union (`"completed"`, `"section-failed"`, `"human-intervention-required"`, `"stopped"`, `"plan-not-found"`)
  - Define `ImplementationLoopResult` with outcome, planId, sections array, durationMs, and optional haltReason
  - Postcondition: `outcome = "completed"` only when all sections reach `"completed"` status
  - _Requirements: 1.1, 1.4, 1.6, 2.1, 2.2, 2.3, 2.4, 4.1, 4.5, 5.1, 5.2, 5.3, 8.1, 8.4, 9.1, 9.2, 9.3, 9.4_

- [x] 1.3 (P) Define the `IReviewEngine` and `IQualityGate` port interfaces
  - Define `IReviewEngine` interface: `review(result, section, config)` returning `Promise<ReviewResult>`
  - Define `ReviewOutcome` (`"passed"` | `"failed"`), `ReviewCheckResult`, `ReviewFeedbackItem` (with `category` and `severity`), and `ReviewResult` types
  - Define `IQualityGate` interface: `run(config)` returning `Promise<ReadonlyArray<ReviewCheckResult>>`
  - Define `QualityGateCheck` (name, command, required, optional workingDirectory) and `QualityGateConfig` (array of checks)
  - Invariant: `ReviewResult.outcome = "passed"` only when all required checks pass; advisory failures do not affect outcome
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 6.1, 6.2, 6.3_

- [x] 1.4 (P) Define the `IPlanStore` port interface
  - Define `IPlanStore` with `loadPlan(planId)` returning `Promise<TaskPlan | null>` and `updateSectionStatus(planId, sectionId, status)` returning `Promise<void>`
  - Define `SectionPersistenceStatus` union covering all five status values including `"escalated-to-human"`
  - Document the write-ownership protocol: `PlanFileStore` is the single physical writer; `TaskPlanningService` writes during `"planning"` phase and `ImplementationLoopService` writes during `"implementation"` phase — never concurrent
  - Add a tolerance note: `PlanFileStore` deserialization must preserve unknown status values rather than coercing them
  - _Requirements: 1.3, 7.3, 9.1, 9.4_

- [x] 1.5 (P) Define `IImplementationLoopLogger` and `IImplementationLoopEventBus` port interfaces
  - Define `IImplementationLoopLogger` with `logIteration(entry)`, `logSectionComplete(record)`, and `logHaltSummary(summary)` methods
  - Define `SectionIterationLogEntry` (planId, sectionId, iterationNumber, reviewOutcome, gateCheckResults, optional commitSha, durationMs, timestamp)
  - Define `ExecutionHaltSummary` (planId, completedSections, committedSections, haltingSectionId, reason, timestamp)
  - Define `IImplementationLoopEventBus` with a single `emit(event: ImplementationLoopEvent): void` method
  - Invariant: all logger entry types must be JSON-serializable (no functions, no circular refs)
  - _Requirements: 1.5, 1.6, 5.4, 5.5, 7.5, 10.1, 10.2, 10.3, 10.4_

- [x] 1.6 (P) Define the `ISelfHealingLoop` port interface
  - Define `ISelfHealingLoop` with `escalate(escalation: SectionEscalation)` returning `Promise<SelfHealingResult>`
  - `SectionEscalation` carries sectionId, planId, retryHistory, reviewFeedback, and agentObservations — all readonly
  - `SelfHealingResult` carries outcome, optional updatedRules array, and a human-readable summary string
  - Document that this port is optional: `ImplementationLoopService` receives `ISelfHealingLoop | undefined` and falls back gracefully when absent
  - _Requirements: 7.1, 7.2, 7.3, 7.4_

---

- [ ] 2. Implement Quality Gate Runner
- [x] 2.1 Implement the Quality Gate Runner service
  - Implement `QualityGateRunner` as a stateless service that accepts `QualityGateConfig` and invokes each check via the tool executor
  - For each `QualityGateCheck`, invoke the configured shell command (e.g., `bun run lint`, `bun test`) using `IToolExecutor`
  - Parse tool exit code to determine pass/fail; treat non-zero exit as `"failed"`; capture stdout/stderr in the `details` field
  - Distinguish required from advisory checks: advisory failures produce a `ReviewCheckResult` with `outcome: "failed"` but do not cause the overall gate to fail
  - Return a `ReadonlyArray<ReviewCheckResult>` with one entry per check; never throw
  - Include a no-op/stub implementation for use in unit tests
  - _Requirements: 6.1, 6.3, 6.4_

- [x] 2.2* Unit test the Quality Gate Runner
  - Test: required check with exit code 0 → `outcome: "passed"`
  - Test: required check with exit code 1 → `outcome: "failed"`, details populated
  - Test: advisory check failure does not flip gate outcome
  - Test: config-driven check selection (only configured checks are run)
  - Test: tool executor failure (process crash) → check marked `"failed"`, exception not propagated
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

---

- [ ] 3. Implement Review Engine
- [ ] 3.1 Implement the LLM Review Engine Service
  - Implement `LlmReviewEngineService` as a stateless service that satisfies `IReviewEngine`
  - Run three check categories: requirement alignment (LLM call), design consistency (LLM call), and code quality (delegate to `QualityGateRunner`)
  - Run alignment and consistency LLM checks concurrently where possible; await both before aggregating results
  - Construct `ReviewFeedbackItem[]` from LLM responses — categorize each item as `"requirement-alignment"`, `"design-consistency"`, or `"code-quality"` and assign `"blocking"` or `"advisory"` severity
  - Set `ReviewResult.outcome = "passed"` only when all required checks pass (all LLM checks + all required quality gate checks); advisory failures produce feedback items but do not flip outcome
  - On LLM call failure, return a failed `ReviewResult` with an error feedback item rather than throwing
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 6.1, 6.2, 6.5_

- [ ] 3.2* Unit test the Review Engine Service
  - Test: all checks pass → `ReviewResult.outcome = "passed"`, feedback array empty
  - Test: one required LLM check fails → `outcome = "failed"`, correct feedback item present
  - Test: advisory check fails → `outcome = "passed"`, advisory feedback item present
  - Test: LLM call throws → review result captures error, does not propagate exception
  - Test: `ReviewFeedbackItem` category and severity are correctly mapped from LLM output
  - _Requirements: 3.2, 3.3, 3.5, 3.6, 6.2, 6.3_

---

- [ ] 4. Implement the core Implementation Loop Service
- [ ] 4.1 Implement section loading and dependency-ordered iteration
  - Load the task plan from `IPlanStore` at startup; return `outcome: "plan-not-found"` immediately if absent
  - Build a topological execution queue: identify all sections with `status !== "completed"` and sort by `dependsOn` constraints
  - For each section, check that all sections listed in its `dependsOn` array are `"completed"` before starting; defer if any dependency is pending
  - Re-evaluate dependency readiness after each section completes so deferred sections are picked up correctly
  - Before beginning each section, write `status: "in_progress"` to `IPlanStore`
  - After all sections reach a terminal state, emit `plan:completed` event and return `outcome: "completed"`
  - Support graceful stop via a private `#stopRequested` flag checked at each section boundary; return `outcome: "stopped"` when triggered
  - _Requirements: 1.1, 1.3, 1.4, 1.6_

- [ ] 4.2 Implement the implement-review-commit cycle for a single section
  - Invoke `IAgentLoop.run(sectionDescription, options)` with the prepared context snapshot and tool permissions; capture the full `AgentLoopResult` (all tool call records and observations)
  - Treat `AgentLoopResult` termination due to safety stop or iteration limit as a section failure — increment the retry counter and route to the retry/escalation logic
  - After a successful agent loop result, invoke `IReviewEngine.review(agentLoopResult, section, qualityGateConfig)` to evaluate output
  - If `ReviewResult.outcome = "passed"`, invoke git integration to commit the changes with a descriptive message that includes the section title and a brief summary; update `status: "completed"` in `IPlanStore`; emit `section:completed` event with the commit SHA
  - Never commit without a `review-passed` signal — the commit step is gated by the review result
  - Record the gate check results in the structured log entry for the section
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 4.1, 4.4, 4.5, 6.2, 6.5_

- [ ] 4.3 Implement the improve step and per-section retry control
  - If `ReviewResult.outcome = "failed"`, construct an improvement directive from the review feedback items and invoke `IAgentLoop.run(improvePrompt, options)` with the same context (observations from the implement step preserved)
  - After the improve step, invoke the review engine again — loop back until review passes or the retry counter reaches `maxRetriesPerSection`
  - Maintain a per-section retry counter that increments each time the implement-review cycle fails; the counter is monotonically increasing and resets only on self-healing resolution
  - When the retry counter reaches `maxRetriesPerSection`, stop retrying and emit a `section:escalated` event containing the section ID, all retry history, and accumulated review feedback
  - Log each iteration: iteration number, feedback provided, and outcome of the improvement attempt
  - _Requirements: 4.2, 4.3, 5.1, 5.2, 5.3, 5.4, 5.5_

- [ ] 4.4 Implement context isolation and preservation across section boundaries
  - At the start of each section, request a fresh context snapshot from `IContextProvider` scoped to that section's artifacts (task description, referenced design docs, related source files); discard accumulated results from the previous section
  - Retain cross-section state in `ImplementationLoopState`: task plan reference, completed-section summaries (section ID, title, commit SHA), and the active feature branch name
  - If the context engine returns a compressed snapshot (token budget exceeded), accept it without attempting manual expansion
  - During the improve step within the same section, allow context to accumulate — preserve all observations and tool results from the implement step so the agent loop has full context of what was already attempted
  - _Requirements: 1.2, 8.1, 8.2, 8.3, 8.4_

- [ ] 4.5 Implement plan resumption after interruption
  - When `run()` or `resume()` is called with a plan that has sections in `"in_progress"` or `"pending"` state, resume from the first non-`"completed"` section rather than restarting
  - Treat any section found in `"in_progress"` state at startup as incomplete — reset it to `"pending"` in `IPlanStore` before re-executing
  - Re-initialize context for the resumed section as if starting fresh; discard any transient in-memory state
  - Read plan state exclusively from `IPlanStore` at startup; do not depend on any in-memory state surviving across process restarts
  - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [ ] 4.6 Implement structured logging and event emission
  - Emit a structured `SectionIterationLogEntry` via `IImplementationLoopLogger` for each implement-review-improve cycle, including section ID, iteration number, review outcome, all gate check results, optional commit SHA, duration, and timestamp
  - Measure elapsed time per section (start to terminal state) and include in the log entry
  - Emit `ImplementationLoopEvent` variants via `IImplementationLoopEventBus` at each major transition: `section:start`, `section:review-passed`, `section:review-failed`, `section:improve-start`, `section:completed`, `section:escalated`, `plan:completed`, `plan:halted`
  - On halt (escalation unresolved, section permanently failed, or git failure), produce a consolidated `ExecutionHaltSummary` via `IImplementationLoopLogger` listing completed sections, committed sections, the halting section, and the reason
  - Write log entries to a path accessible by the memory system (`.aes/logs/implementation-loop-<planId>.ndjson`) in machine-parseable NDJSON format
  - _Requirements: 1.5, 1.6, 5.4, 5.5, 6.5, 7.5, 10.1, 10.2, 10.3, 10.4_

- [ ] 4.7 Implement escalation to the self-healing loop
  - When a section escalation event is emitted, check whether `ISelfHealingLoop` was provided at construction time
  - If available, call `escalate(sectionEscalation)` passing section ID, plan ID, full retry history, accumulated review feedback, and all agent loop observations
  - On `SelfHealingResult.outcome = "resolved"`, reset the section's retry counter to zero, inject the returned updated rules into the context snapshot, and resume execution of that section
  - On `SelfHealingResult.outcome = "unresolved"`, write `status: "escalated-to-human"` to `IPlanStore`, emit a `plan:halted` event with a human-readable summary, and return `outcome: "human-intervention-required"`
  - If `ISelfHealingLoop` is not provided or its call throws, mark the section as `"failed"`, emit a `plan:halted` event with a summary, and return `outcome: "section-failed"`
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

---

- [ ] 5. Wire into the workflow engine
- [ ] 5.1 Extend workflow phase and event types for the implementation phase
  - Add `"implementation"` to the `WorkflowPhase` union in `application/ports/workflow.ts`
  - Add `phase:start`, `phase:complete`, and `phase:error` variants for `phase: "implementation"` to the `WorkflowEvent` discriminated union
  - Ensure existing `WorkflowEngine` phase-runner handles the new phase value without modification to its core logic
  - _Requirements: 1.6_

- [ ] 5.2 Wire `ImplementationLoopService` into the `run-spec.ts` use case
  - Add `IImplementationLoop` as a constructor dependency of `RunSpecUseCase` alongside existing services
  - After `TaskPlanningService.run()` returns a completed plan result, invoke `IImplementationLoop.run(planId)` as the next phase step
  - Emit `phase:start` for `"implementation"` before invoking the loop and `phase:complete` (or `phase:error`) after it returns
  - Pass the `ImplementationLoopResult` to the event bus so the CLI renderer can display section progress
  - Update the infra wiring (constructor composition root) to instantiate and inject `ImplementationLoopService` with all required dependencies
  - _Requirements: 1.6_

---

- [ ] 6. Write integration tests
- [ ] 6.1 Integration test: full implement → review → commit cycle
  - Stub `IAgentLoop` to return a successful result, stub `IReviewEngine` to return `outcome: "passed"` on first attempt
  - Assert that `IPlanStore.updateSectionStatus` is called with `"completed"` for each section
  - Assert that git integration commits once per section with a message referencing the section title
  - Assert that `ImplementationLoopResult.outcome = "completed"` and all `SectionExecutionRecord` statuses are `"completed"`
  - Assert `plan:completed` event is emitted after all sections
  - Assert that `SectionIterationLogEntry` records are written for each completed section
  - _Requirements: 1.1, 1.3, 1.5, 1.6, 2.1, 2.3, 4.1, 4.4, 4.5_

- [ ] 6.2 (P) Integration test: retry flow
  - Stub `IReviewEngine` to return `"failed"` for the first two iterations and `"passed"` on the third
  - Assert retry counter increments correctly after each failure
  - Assert the improve prompt carries review feedback from the previous failed attempt
  - Assert observations from the implement step are preserved and available in the improve step
  - Assert the final commit occurs only after the third iteration passes
  - _Requirements: 4.2, 4.3, 5.1, 5.2, 5.5_

- [ ] 6.3 (P) Integration test: escalation and halt
  - Stub `IReviewEngine` to always return `"failed"` so `maxRetriesPerSection` is reached
  - When `ISelfHealingLoop` returns `"unresolved"`, assert section is marked `"escalated-to-human"`, `plan:halted` event is emitted, and result outcome is `"human-intervention-required"`
  - When `ISelfHealingLoop` is absent, assert section is marked `"failed"`, `plan:halted` is emitted, and result outcome is `"section-failed"`
  - Assert `section:escalated` event contains section ID, retry count, and review feedback
  - _Requirements: 5.3, 5.4, 7.1, 7.3, 7.4, 7.5_

- [ ] 6.4 (P) Integration test: plan resumption after interruption
  - Seed `IPlanStore` with a plan that has one `"in_progress"` section and one `"completed"` section
  - Call `resume(planId)` and assert the `"completed"` section is not re-executed
  - Assert the `"in_progress"` section is reset to `"pending"` before execution begins
  - Assert context is re-initialized fresh for the resumed section
  - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [ ] 6.5 (P) Integration test: quality gate checks and commit blocking
  - Configure `QualityGateConfig` with one required lint check (stub exit code 1) and one advisory test check (stub exit code 1)
  - Assert that a required check failure blocks the commit step and routes back to the improve step
  - Assert that an advisory check failure does not block the commit (review passes with advisory feedback)
  - Assert that gate check results (name, outcome, details) appear in the iteration log entry
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

---

- [ ] 7. Write E2E and performance tests
- [ ] 7.1 E2E test: full `aes run` with a minimal one-section plan
  - Run `aes run` against a minimal plan with a single task section and a stub agent loop that writes one file
  - Assert that a git commit is produced with the section title in the commit message
  - Assert that the plan JSON in `.aes/plans/` shows `status: "completed"` for the section after the run
  - Assert that an NDJSON log file is created at `.aes/logs/implementation-loop-<planId>.ndjson` with at least one iteration entry
  - _Requirements: 1.1, 1.3, 1.6, 4.4, 10.3_

- [ ] 7.2 (P) E2E test: resumption after stop signal
  - Run `aes run` against a three-section plan, send a stop signal after section 1 commits
  - Assert that section 2 is in `"in_progress"` or `"pending"` state in the persisted plan
  - Restart with `aes run --resume`; assert that section 1 is not re-executed and sections 2 and 3 complete
  - _Requirements: 9.1, 9.3, 9.4_

- [ ] 7.3 (P) Performance test: elapsed time logging across sections
  - Run the implementation loop against a five-section stub plan; assert all five `SectionIterationRecord.durationMs` fields are positive numbers
  - Assert that context re-initialization per section does not cause observable memory growth (RSS stays bounded) across ten sequential sections using a memory stub
  - _Requirements: 10.4_
