# Implementation Plan

- [ ] 1. Self-healing domain types
  - Add `RootCauseAnalysis` value object capturing what was attempted, what failed, and the recurring pattern across retries
  - Add `GapReport` value object with `targetFile` (`KnowledgeMemoryFile`), `proposedChange`, and `rationale`
  - Add the `SelfHealingLogEntry` discriminated union covering all seven entry shapes (`escalation-intake`, `analysis-complete`, `gap-identified`, `rule-updated`, `retry-initiated`, `self-healing-resolved`, `unresolved`), each extending a common base of `type`, `sectionId`, `planId`, and ISO 8601 `timestamp`
  - Add `SelfHealingFailureRecord` internal record that maps to `MemoryPort.FailureRecord` before persistence
  - Place all types in `orchestrator-ts/src/domain/self-healing/types.ts`; no external dependencies allowed in the domain layer
  - _Requirements: 2.2, 3.2, 5.1, 8.1, 8.2_

- [ ] 2. Logger port and NDJSON adapter
- [ ] 2.1 (P) Declare the `ISelfHealingLoopLogger` application port
  - Define the `log(entry: SelfHealingLogEntry): void` interface in `orchestrator-ts/src/application/ports/`
  - The interface must be safe to call when undefined; `SelfHealingLoopService` treats the logger as optional
  - Document that concrete adapters must never throw and must use async fire-and-forget writes
  - _Requirements: 8.1, 8.3_

- [ ] 2.2 Implement `NdjsonSelfHealingLoopLogger` concrete adapter
  - Write NDJSON entries to `.aes/logs/self-healing-<planId>.ndjson` using async `appendFile` (never `appendFileSync`)
  - Capture write errors to an internal `writeErrorCount` counter rather than re-throwing or emitting to callers
  - Never include LLM API keys, credentials, or workspace-external paths in serialized entries
  - Follow the same pattern as the existing `NdjsonImplementationLoopLogger` in the infra layer
  - _Requirements: 8.1, 8.3, 8.5_

- [ ] 3. Service skeleton and escalation intake guards
- [ ] 3.1 (P) Create `SelfHealingLoopService` with constructor injection and config
  - Accept `LlmProviderPort`, `MemoryPort`, `SelfHealingLoopConfig`, and optional `ISelfHealingLoopLogger` as constructor arguments
  - Define `SelfHealingLoopConfig` with `workspaceRoot`, `selfHealingTimeoutMs` (default 120 000), `analysisTimeoutMs` (default 60 000), `maxAnalysisRetries` (default 2), and `maxRecordSizeBytes` (default 65 536)
  - Implement `ISelfHealingLoop.escalate()` as the sole public method; it must never throw on any code path
  - Wrap the internal `#runHealingWorkflow()` call with `Promise.race` using `selfHealingTimeoutMs`; ensure the failure record is written before returning on a timeout
  - _Requirements: 1.1, 1.5_

- [ ] 3.2 Implement escalation intake validation and concurrency guard
  - On entry, emit an `escalation-intake` log entry with `retryHistoryCount`
  - If `escalation.retryHistory` is empty, return `outcome: "unresolved"` with a descriptive summary immediately, before entering the workflow
  - Maintain `#inFlightSections: Set<string>`; if `sectionId` is already present, return `outcome: "unresolved"` with "concurrent escalation in progress"
  - Add `sectionId` to the set at the start and remove it in a `finally` block to guarantee consistent state on every code path
  - Record the full escalation (`sectionId`, `planId`, `retryHistory`, `reviewFeedback`, `agentObservations`) as working context for all downstream steps
  - _Requirements: 1.2, 1.3, 1.4_

- [ ] 4. Root-cause analysis
- [ ] 4.1 Implement `#analyzeRootCause()` with LLM retry loop and per-call timeout
  - Build a structured system prompt from `RootCauseAnalysis` JSON schema and a user message from serialized `retryHistory`, `reviewFeedback`, and `agentObservations`
  - Wrap each `LlmProviderPort.complete()` call with `Promise.race` using `analysisTimeoutMs`; count both timeout and call failure as LLM failures that trigger the retry
  - Before launching each retry attempt, check whether the elapsed time since `escalate()` started would exceed `selfHealingTimeoutMs`; skip the call and return `unresolved` immediately if so, capping background LLM calls to at most one dangling promise per invocation
  - Retry up to `maxAnalysisRetries` times on failure or non-parseable JSON; after exhausting retries, return `outcome: "unresolved"` with the last error captured in `summary`
  - Parse a successful LLM response into `RootCauseAnalysis` (`attemptsNarrative`, `failureNarrative`, `recurringPattern`)
  - _Requirements: 2.1, 2.3, 2.5_

- [ ] 4.2 Emit the analysis log entry and hand off to gap identification
  - After a successful parse, emit an `analysis-complete` log entry carrying `recurringPattern`; do not log raw LLM output
  - Pass the parsed `RootCauseAnalysis` to `#identifyGap()` as the sole input for the next step
  - _Requirements: 2.2, 2.4_

- [ ] 5. Gap identification
- [ ] 5.1 Implement `#identifyGap()` with rule file content and structured LLM call
  - Read current contents of all three knowledge rule files via `MemoryPort.query()` before calling the LLM
  - Build a system prompt with `GapReport` JSON schema and the valid `KnowledgeMemoryFile` values; include rule file contents and the root-cause output in the user message
  - Parse the LLM response into a `GapReport`; apply the same retry and timeout logic as root-cause analysis
  - If the LLM reports no actionable gap or the `targetFile` is not in the supported `KnowledgeMemoryFile` set, return `outcome: "unresolved"` with an explanatory `summary`
  - Emit a `gap-identified` log entry with `targetFile` after successful parse
  - _Requirements: 3.1, 3.2, 3.3, 3.5_

- [ ] 5.2 Detect duplicate gaps via failure memory before proceeding
  - Call `MemoryPort.getFailures(sectionId)` after the gap report is produced and before writing any rule file
  - Compare the proposed gap's (`targetFile` + `proposedChange`) combination against all previously persisted failure records for the same `sectionId`
  - If an identical gap is already recorded, return `outcome: "unresolved"` with "duplicate gap detected" in `summary` to prevent infinite self-healing cycles
  - _Requirements: 3.4_

- [ ] 6. Rule file update and workspace boundary enforcement
- [ ] 6.1 Validate resolved rule file paths against workspace boundary
  - Resolve the absolute path for the target rule file using `workspaceRoot` from config
  - If the resolved path falls outside `workspaceRoot`, return `outcome: "unresolved"` with "workspace safety violation" in `summary` without touching `MemoryPort`
  - Never pass workspace-external paths to `MemoryPort` write methods or include them in log entries
  - _Requirements: 4.5, 8.5_

- [ ] 6.2 Write the proposed change to the target rule file with machine-readable marker
  - Call `MemoryPort.append()` or `MemoryPort.update()` to add the proposed change as a clearly delimited section; never overwrite or delete existing content
  - Include the machine-readable marker `<!-- self-healing: <sectionId> <timestamp> -->` in each appended section
  - Map `GapReport` fields to the `MemoryEntry` structure: `proposedChange` as `description`, `planId` + `sectionId` as `context`, and a title prefixed with the proposed change and `sectionId` for uniqueness
  - If the write fails, return `outcome: "unresolved"` with the filesystem error in `summary`; do not proceed to retry with unwritten rules
  - Emit a `rule-updated` log entry with `targetFile` and `memoryWriteAction` after a successful write
  - Collect the workspace-relative path of the updated file into `updatedRules`
  - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [ ] 7. Failure record persistence
- [ ] 7.1 Map internal record to `MemoryPort.FailureRecord` and enforce size limit
  - Build a `SelfHealingFailureRecord` from the escalation context: `sectionId` → `taskId`, `planId` → `specName`, fixed phase `"IMPLEMENTATION"`, serialized `retryHistory` → `attempted`, root-cause strings → `errors`, `rootCause` → `rootCause`, and gap report's `proposedChange` → `ruleUpdate` (null if no gap identified)
  - Serialize the record and measure its byte length; if it exceeds `maxRecordSizeBytes`, truncate `agentObservations` to bring it within the limit and set `truncated: true` in the record
  - _Requirements: 5.1, 5.5_

- [ ] 7.2 Write failure record via `IFailureMemory` port in a `finally` block
  - Await `MemoryPort.writeFailure()` to persist the record as a new NDJSON entry in `.memory/failures/failure-records.ndjson`; each call appends a new entry and never modifies existing ones
  - Place the write inside the `finally` block of `#runHealingWorkflow()` so that it executes on every code path — resolved and unresolved alike — including timeout paths
  - If the write fails, log the error via `ISelfHealingLoopLogger` but do not alter the `outcome` already determined by the analysis
  - _Requirements: 5.2, 5.3, 5.4_

- [ ] 8. Result assembly and full observability
- [ ] 8.1 Assemble the resolved result and emit final resolved log entries
  - When all steps succeed, emit a `retry-initiated` log entry to mark that the implementation loop will restart the failed section
  - Emit a `self-healing-resolved` log entry including `sectionId`, `planId`, `updatedRules`, and `totalDurationMs` (elapsed since `escalate()` was called)
  - Return `SelfHealingResult { outcome: "resolved", updatedRules }` with workspace-relative paths of all updated rule files
  - _Requirements: 6.1, 6.5, 8.2, 8.4_

- [ ] 8.2 Assemble the unresolved result with a comprehensive, non-empty summary
  - When any step fails (intake guard, analysis, gap identification, rule write, timeout), construct `SelfHealingResult { outcome: "unresolved", summary }` where `summary` names the step that stopped, includes the root-cause analysis or the reason analysis was skipped, the gap report or why no gap was identified, and a description of the specific error or condition
  - Every unresolved return site must produce a non-empty, human-readable `summary`; no error is silently swallowed
  - Emit an `unresolved` log entry including `stopStep` and `totalDurationMs` before returning
  - _Requirements: 7.1, 7.2, 7.5, 8.2, 8.4_

- [ ] 9. Unit tests
- [ ] 9.1 (P) Intake guard and concurrency unit tests
  - Test that `escalate()` returns `unresolved` immediately when `retryHistory` is empty
  - Test that a duplicate concurrent call for the same `sectionId` returns `unresolved` with "concurrent escalation in progress"
  - Test that the outer timeout returns `unresolved` with a timeout description when `selfHealingTimeoutMs` elapses
  - Verify `#inFlightSections` is cleaned up in all terminal paths (success, failure, timeout)
  - _Requirements: 1.2, 1.4, 1.5_

- [ ] 9.2 (P) Root-cause analysis retry and timeout unit tests
  - Test that the LLM is retried up to `maxAnalysisRetries` times on a failing or non-parseable response, then returns `unresolved`
  - Test that a call exceeding `analysisTimeoutMs` is counted as a failure and triggers the retry
  - Test that the elapsed-time guard prevents a new LLM call when the outer timeout window is already consumed
  - Test that a successful parse produces `RootCauseAnalysis` with all three fields populated and an `analysis-complete` log entry is emitted
  - _Requirements: 2.1, 2.3, 2.5_

- [ ] 9.3 (P) Gap identification unit tests
  - Test that an LLM response with no actionable gap returns `unresolved` with an explanatory summary
  - Test that a `targetFile` not in the supported set returns `unresolved` with "unsupported rule file"
  - Test that a gap report matching a previously persisted failure record returns `unresolved` with "duplicate gap detected"
  - Test that a valid gap report triggers the rule-update step with correct `GapReport` → `MemoryEntry` field mapping
  - _Requirements: 3.3, 3.4_

- [ ] 9.4 (P) Rule update, workspace validation, and persistence unit tests
  - Test that a rule file path resolved outside `workspaceRoot` returns `unresolved` with "workspace safety violation" without calling any `MemoryPort` write method
  - Test that a write failure from `MemoryPort` returns `unresolved` with the filesystem error in summary
  - Test that `MemoryPort.writeFailure()` is called exactly once for every `escalate()` invocation regardless of outcome
  - Test that a record exceeding `maxRecordSizeBytes` truncates `agentObservations` and sets `truncated: true`
  - Test that a failure record write error is logged but does not change the already-determined outcome
  - _Requirements: 4.3, 4.5, 5.3, 5.5_

- [ ] 9.5 (P) Happy path and observability unit tests
  - Test the full resolved path: analysis → gap → rule write → failure record → `outcome: "resolved"` with `updatedRules` populated
  - Test that `MemoryPort.append()` is called with a `description` containing the machine-readable marker `<!-- self-healing: <sectionId> <timestamp> -->`
  - Test that log entries are emitted at all major steps (`escalation-intake`, `analysis-complete`, `gap-identified`, `rule-updated`, `retry-initiated`, `self-healing-resolved`) when a logger is injected
  - Test that the absence of a logger never causes `SelfHealingLoopService` to throw
  - Test that the final log entry (`self-healing-resolved` or `unresolved`) includes a non-zero `totalDurationMs`
  - _Requirements: 1.1, 4.2, 6.1, 8.3, 8.4, 8.5_

- [ ]* 9.6 (P) Performance unit tests
  - Test that `escalate()` completes within `selfHealingTimeoutMs` under normal mock latency with all steps succeeding
  - Test that serializing `agentObservations` with more than 100 entries results in a record at or below `maxRecordSizeBytes` after truncation
  - _Requirements: 1.5, 5.5_

- [ ] 10. Integration tests
- [ ] 10.1 (P) Full happy-path integration with in-memory MemoryPort stub
  - Wire `SelfHealingLoopService` to an in-memory `MemoryPort` stub and a mock `LlmProviderPort`
  - Execute the full analysis → gap → rule update → resolved flow and assert `updatedRules` contains the correct workspace-relative paths
  - Verify the failure record is appended and readable via `MemoryPort.getFailures()` after the call completes
  - Verify the NDJSON log file receives all expected entries via `NdjsonSelfHealingLoopLogger`
  - _Requirements: 2.4, 3.5, 5.2, 6.5_

- [ ] 10.2 (P) Duplicate gap detection integration test
  - Pre-seed the in-memory `MemoryPort` stub with a failure record matching the target `sectionId` and the same `targetFile` + `proposedChange` combination
  - Execute `escalate()` and assert `outcome: "unresolved"` with "duplicate gap detected" in the summary
  - _Requirements: 3.4_

- [ ] 10.3 (P) Workspace boundary and append-only persistence integration tests
  - Verify that a rule file path outside `workspaceRoot` produces `outcome: "unresolved"` without any `MemoryPort` write call
  - Execute two `escalate()` calls with different outcomes and verify that two distinct failure records are appended and no prior entry is modified in the in-memory stub
  - _Requirements: 4.5, 5.2_

- [ ] 11. E2E tests
- [ ] 11.1 End-to-end resolved path: self-healing unblocks a failed section
  - Connect `SelfHealingLoopService` to `ImplementationLoopService` via `ImplementationLoopOptions.selfHealingLoop`
  - Drive the implementation loop to exhaust its retry budget; assert that self-healing is invoked, returns `outcome: "resolved"`, and the section's retry counter resets to zero
  - Verify that the section is restarted with `updatedRules` paths injected as additional context sources for the PLAN step
  - _Requirements: 6.1, 6.2, 6.3_

- [ ] 11.2 End-to-end unresolved path: escalation halts the loop
  - Configure the mock LLM to return no actionable gap so that self-healing returns `outcome: "unresolved"`
  - Assert that the implementation loop marks the section `"escalated-to-human"`, emits a `section:escalated` event with the `SelfHealingResult.summary` as `reason`, and halts
  - Assert that after a resolved self-healing outcome the section is retried once; if that retry also fails, the implementation loop does not call `ISelfHealingLoop.escalate()` again but instead marks the section `"escalated-to-human"` directly
  - _Requirements: 6.4, 7.3_

- [ ] 11.3 End-to-end unexpected-throw regression: spec9 catch path
  - Configure `SelfHealingLoopService` to throw an unhandled exception from `escalate()`
  - Assert that `ImplementationLoopService` catches the exception, marks the section `"failed"`, and does not propagate the throw to the caller
  - _Requirements: 1.1_
