# Requirements Document

## Introduction

The self-healing loop is the autonomous recovery subsystem of AI Dev Agent v1. It activates when the implementation loop exhausts its per-section retry budget or when the agent enters a stuck state it cannot resolve on its own. The system analyzes the accumulated failure context, identifies the rule or knowledge gap that caused the failure, updates the relevant rule files, records the failure in persistent memory, and returns updated rules to the caller so the failed task section can be retried with improved context. If self-healing cannot resolve the issue, the system escalates cleanly to human review. This subsystem closes the feedback loop between runtime failures and the agent's internal knowledge base, allowing the agent to improve its behavior over time.

**Dependencies**: spec9 (implementation-loop), spec5 (memory-system)

---

## Requirements

### Requirement 1: Failure Detection and Escalation Intake

**Objective:** As the implementation-loop service, I want to hand off an exhausted section to the self-healing loop via a well-defined interface, so that the escalation path is decoupled from the retry logic.

#### Acceptance Criteria

1. When the implementation loop calls `ISelfHealingLoop.escalate(escalation)` with a `SectionEscalation` value, the Self-Healing Loop shall accept the call without throwing and begin the analysis workflow.
2. The Self-Healing Loop shall accept escalations containing at least one `SectionIterationRecord` in `escalation.retryHistory`; if `retryHistory` is empty, the Self-Healing Loop shall immediately return `outcome: "unresolved"` with a descriptive summary.
3. The Self-Healing Loop shall record the incoming escalation—including `sectionId`, `planId`, `retryHistory`, `reviewFeedback`, and `agentObservations`—as the working context for all subsequent analysis steps.
4. While an escalation is being processed, the Self-Healing Loop shall not accept a second concurrent escalation for the same `sectionId`; if a duplicate call arrives, the Self-Healing Loop shall return `outcome: "unresolved"` with a summary indicating a concurrent escalation is already in progress.
5. The Self-Healing Loop shall complete the `escalate` call within the configured `selfHealingTimeoutMs` limit (default: 120 000 ms); if the timeout elapses, the Self-Healing Loop shall return `outcome: "unresolved"` with `summary` describing the timeout.

---

### Requirement 2: Root Cause Analysis

**Objective:** As the self-healing loop, I want to perform an LLM-driven analysis of the full failure context accumulated across all retry attempts, so that I can identify the specific failure pattern causing the section to stall.

#### Acceptance Criteria

1. When a `SectionEscalation` is received, the Self-Healing Loop shall invoke the LLM provider with a structured prompt containing the complete `retryHistory`, `reviewFeedback` items, and `agentObservations` from the escalation.
2. The Self-Healing Loop shall request the LLM to produce a structured root-cause analysis identifying: (a) what was attempted in each retry, (b) what failed each time, and (c) a concise pattern or recurring theme across failures.
3. If the LLM call fails or returns a malformed or non-parseable response, the Self-Healing Loop shall retry the analysis up to `maxAnalysisRetries` times (default: 2) before returning `outcome: "unresolved"` with the LLM error captured in `summary`.
4. The Self-Healing Loop shall log the root-cause analysis result as a structured NDJSON entry to `.aes/logs/self-healing-<planId>.ndjson` including `sectionId`, `planId`, `analysisResult`, and ISO 8601 `timestamp`.
5. The root-cause analysis shall complete within `analysisTimeoutMs` (default: 60 000 ms); if the timeout elapses the Self-Healing Loop shall treat it as an LLM failure and apply the retry logic described in criterion 3.

---

### Requirement 3: Knowledge Gap Identification

**Objective:** As the self-healing loop, I want to determine which rule, pattern, or piece of knowledge is absent from the current rule set, so that a targeted update can prevent the same failure from recurring.

#### Acceptance Criteria

1. When root-cause analysis completes successfully, the Self-Healing Loop shall invoke the LLM with the root-cause output and the current contents of all rule files to identify which specific rule or pattern is missing or incorrect.
2. The Self-Healing Loop shall produce a structured gap report containing: (a) the target rule file (`coding_rules.md`, `review_rules.md`, or `implementation_patterns.md`), (b) a specific proposed addition or correction, and (c) a rationale linking the gap to the observed failure pattern.
3. If the LLM identifies no actionable gap—or if the gap cannot be mapped to a supported rule file—the Self-Healing Loop shall return `outcome: "unresolved"` with a `summary` that explains why no gap was identified.
4. The Self-Healing Loop shall not produce a gap report that is identical to a gap report already persisted in failure-memory for the same `sectionId`; if a duplicate is detected, the Self-Healing Loop shall return `outcome: "unresolved"` with a `summary` noting the duplicate to prevent infinite self-healing cycles.
5. The Self-Healing Loop shall log the gap report as a structured NDJSON entry including `sectionId`, `planId`, `targetFile`, `proposedChange`, `rationale`, and ISO 8601 `timestamp`.

---

### Requirement 4: Rule File Update

**Objective:** As the self-healing loop, I want to write targeted updates to the appropriate rule files, so that the agent's behavior improves for the current retry and all future sessions.

#### Acceptance Criteria

1. When a gap report is produced, the Self-Healing Loop shall write the proposed addition or correction to the target rule file at the path returned by the memory-system for that file (`rules/coding_rules.md`, `rules/review_rules.md`, or `rules/implementation_patterns.md`).
2. The Self-Healing Loop shall append new rules as clearly delimited sections and shall not overwrite or delete existing content in the rule file; each appended section shall include a machine-readable marker `<!-- self-healing: <sectionId> <timestamp> -->`.
3. If writing the rule file fails due to a filesystem error, the Self-Healing Loop shall log the error and return `outcome: "unresolved"` with the filesystem error captured in `summary`; it shall not attempt to proceed to retry with unwritten rules.
4. The Self-Healing Loop shall return the paths of all updated rule files as `updatedRules` in the `SelfHealingResult` so that the implementation loop can inject them into the section's retry context.
5. The Self-Healing Loop shall not write to any path outside the configured workspace root; if the resolved rule file path falls outside the workspace boundary, the Self-Healing Loop shall return `outcome: "unresolved"` with a safety violation message in `summary`.

---

### Requirement 5: Failure Record Persistence

**Objective:** As the memory system, I want the self-healing loop to write a structured failure record for every escalation it processes, so that historical failure data is available for analysis and future self-healing runs.

#### Acceptance Criteria

1. When an escalation is processed—regardless of whether self-healing resolves the issue—the Self-Healing Loop shall write a failure record to failure-memory containing: `sectionId`, `planId`, `rootCause`, `gapIdentified` (or `null` if none), `ruleFilesUpdated`, `outcome` (`"resolved"` or `"unresolved"`), and ISO 8601 `timestamp`.
2. Failure records shall be persisted as NDJSON entries in `.memory/failures/failure-records.ndjson`; each run shall append a new entry and shall not modify existing entries.
3. The Self-Healing Loop shall complete the failure-record write before returning `SelfHealingResult` to the caller; if the write fails, the Self-Healing Loop shall log the persistence error but shall not change the `outcome` already determined by the analysis.
4. The Self-Healing Loop shall write the failure record using the memory-system's `IFailureMemory` port; it shall not write failure records directly to the filesystem, so that memory-system retrieval guarantees apply.
5. The Self-Healing Loop shall not write failure records that exceed `maxRecordSizeBytes` (default: 64 KB per record); if a record would exceed the limit, the Self-Healing Loop shall truncate `agentObservations` to fit within the limit and include a `truncated: true` flag in the record.

---

### Requirement 6: Self-Healing Retry

**Objective:** As the implementation loop, I want the self-healing loop to resume the failed section with updated rules injected into context, so that the section has a genuine chance of succeeding on the retry.

#### Acceptance Criteria

1. When rule files are updated successfully, the Self-Healing Loop shall return `outcome: "resolved"` with `updatedRules` populated with the workspace-relative file paths of all updated rule files.
2. When the Self-Healing Loop returns `outcome: "resolved"`, the implementation loop shall reset the retry counter for the affected section to zero and restart the implement-review-improve cycle for the same `planId` and `sectionId`.
3. When the context engine (`IContextEngine`) is available and the Self-Healing Loop returns `outcome: "resolved"`, the implementation loop shall call `contextEngine.resetTask(sectionId)` before the retry and pass the `updatedRules` file paths as additional context sources for the PLAN step.
4. If the retried section fails again after a self-healing `"resolved"` outcome, the implementation loop shall not call `ISelfHealingLoop.escalate()` again for the same section; instead, it shall mark the section as `"escalated-to-human"` and halt the loop.
5. The Self-Healing Loop shall emit a structured log entry of type `"self-healing-resolved"` including `sectionId`, `planId`, `updatedRules`, and ISO 8601 `timestamp` before returning `outcome: "resolved"` to the caller.

---

### Requirement 7: Human Escalation on Unresolved Failures

**Objective:** As an operator, I want the self-healing loop to produce a clear, actionable human-escalation record when it cannot resolve a failure, so that a human reviewer has all the information needed to diagnose and fix the issue manually.

#### Acceptance Criteria

1. When `outcome: "unresolved"` is determined, the Self-Healing Loop shall return a `SelfHealingResult` with `outcome: "unresolved"` and a `summary` that includes: the root-cause analysis (or the reason analysis was skipped), the gap report (or why no gap was identified), and the specific step at which self-healing stopped.
2. Before returning `outcome: "unresolved"` to the caller, the Self-Healing Loop shall ensure the failure record has been written to failure-memory; the write must complete before the `escalate` promise resolves.
3. The implementation loop shall mark the section status as `"escalated-to-human"` in the plan store, emit a `section:escalated` event on the event bus, and include the `summary` from `SelfHealingResult` as the `reason` field of the event.
4. If the human-approval workflow (spec3) is available, the implementation loop shall invoke it with the escalation summary; if the workflow is unavailable, the loop shall halt immediately with `outcome: "human-intervention-required"`.
5. The Self-Healing Loop shall never silently swallow errors: every failure path that leads to `outcome: "unresolved"` must produce a non-empty, human-readable `summary` that includes the step name and a description of the error or condition.

---

### Requirement 8: Observability and Structured Logging

**Objective:** As a developer or operator, I want every self-healing run to produce structured, queryable logs, so that I can audit the system's self-healing decisions and diagnose issues in production.

#### Acceptance Criteria

1. The Self-Healing Loop shall write all log entries as NDJSON to `.aes/logs/self-healing-<planId>.ndjson`; each entry shall include a `type` discriminator field (e.g., `"escalation-intake"`, `"analysis-complete"`, `"gap-identified"`, `"rule-updated"`, `"retry-initiated"`, `"unresolved"`) and an ISO 8601 `timestamp`.
2. The Self-Healing Loop shall emit structured log entries at each major step: escalation intake, root-cause analysis result, gap identification result, rule file update, retry initiation, and final outcome.
3. If a logger is not injected, the Self-Healing Loop shall silently drop log entries without affecting the analysis or outcome; the absence of a logger shall never cause the Self-Healing Loop to throw.
4. The Self-Healing Loop shall record the total elapsed time for the entire `escalate` call as `totalDurationMs` in the final outcome log entry.
5. The Self-Healing Loop shall never include LLM API keys, credentials, or workspace-external file paths in log entries.
