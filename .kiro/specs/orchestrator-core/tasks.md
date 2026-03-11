# Implementation Plan

## Dependency Order Summary

```text
Task 1 (setup + config)
  └─> Task 2 (workflow foundation: state model, persistence, events)
        ├─> Task 3 (P) (LLM provider abstraction + Claude)
        ├─> Task 4 (P) (cc-sdd adapter)
        └─> Task 5 (P) (approval gate)
              [Tasks 3, 4, and 5 must ALL complete before Task 6]
Task 6 (phase execution engine)
  └─> Task 7 (workflow orchestration engine)
        └─> Task 8 (application use case + CLI)
              └─> Task 9 (integration + E2E tests)
```

---

- [x] 1. Set up project infrastructure and build configuration loading

- [x] 1.1 (P) Initialize the Bun project with TypeScript strict mode and install all runtime dependencies
  - Configure Bun as the runtime and package manager with TypeScript strict mode enabled
  - Install the CLI framework, Anthropic SDK, and their required peer dependencies
  - Set up the source directory structure matching the Clean + Hexagonal Architecture layers (cli, application, domain, adapters, infra)
  - _Requirements: 2.1_

- [x] 1.2 (P) Build configuration loading with environment variable merging and validation
  - Load `aes.config.json` from the project root at startup
  - Merge environment variables over file-based values, with env vars taking precedence
  - Validate required fields (LLM provider, model name, API key) and report all missing values by name before starting any workflow operation
  - Support configuring LLM provider, model name, API key, spec directory path, and SDD framework selection
  - Default `sddFramework` to `cc-sdd` when not specified
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

---

- [ ] 2. Establish the workflow state model, crash-safe persistence, and event bus

- [x] 2.1 Define the 7-phase workflow lifecycle data model
  - Define the ordered 7-phase sequence: SPEC_INIT → REQUIREMENTS → DESIGN → VALIDATE_DESIGN → TASK_GENERATION → IMPLEMENTATION → PULL_REQUEST
  - Define workflow status variants: running, paused_for_approval, completed, failed
  - Define the workflow state structure capturing current phase, completed phases, status, failure detail, and timestamps
  - Establish the invariant: when status is `paused_for_approval`, the current phase holds the phase that triggered the pause; the engine re-checks the approval gate before advancing on the next run
  - Define the port contracts for state persistence and event emission that isolate the workflow engine from infrastructure
  - _Requirements: 3.1, 3.4, 3.5, 4.3_

- [x] 2.2 (P) Build crash-safe workflow state persistence
  - Implement atomic JSON state writes using the write-then-rename pattern (write to temp file, sync to disk, rename over destination) to survive process crashes
  - Store state at `.aes/state/<specName>.json`; create the directory if it does not exist
  - Implement state restoration that reads the last persisted state and returns null when no state file exists
  - Implement state initialization for new workflow runs
  - _Requirements: 3.2, 3.3, 3.6_

- [x] 2.3 (P) Build typed workflow event bus
  - Implement a typed event bus backed by Node.js `EventEmitter` with a unified subscribe/unsubscribe interface
  - Define the full event shape: phase-start (with timestamp), phase-complete (with duration and artifact list), phase-error (with operation name and error), approval-required (with artifact path and human instruction), workflow-complete, and workflow-failed
  - Guarantee synchronous delivery in phase execution order with no buffering
  - _Requirements: 8.1, 8.2, 8.3_

---

- [ ] 3. (P) Build LLM provider abstraction and Claude implementation

- [x] 3.1 Define the LLM provider port contract
  - Define the unified provider interface with a prompt completion operation and a context reset operation
  - Define result types: a successful response carrying the content string and token usage, and a structured error carrying the failure category (`network`, `rate_limit`, or `api_error`) with the original error detail
  - Establish the contract invariant: after context reset, the next completion call must not include prior conversation history; the interface never throws — errors are always returned in the result value
  - _Requirements: 7.1, 7.2, 7.4, 7.5_

- [x] 3.2 Build the Claude provider adapter
  - Implement the LLM provider contract using `@anthropic-ai/sdk`, accepting model name and API key from configuration
  - Maintain internal message history; `clearContext()` discards that history so the next call starts from a clean context
  - Map SDK-specific error types to the three structured failure categories: connection errors to `network`, rate limit errors to `rate_limit`, all others to `api_error`
  - Accept model name from configuration so the Claude model version can be changed without code changes
  - _Requirements: 7.3, 7.4, 7.5, 7.6, 7.7_

---

- [ ] 4. (P) Build SDD framework adapter for cc-sdd

- [ ] 4.1 Define the SDD framework port contract
  - Define the adapter interface with four operations mapping to workflow phases: generate requirements, generate design, validate design, and generate tasks
  - Define the context input (spec name, spec directory path, language) and result type (success with artifact path, or failure with exit code and stderr)
  - Establish invariants: each operation writes only to the spec directory; side effects must not modify workflow state
  - _Requirements: 6.5, 6.6, 6.7_

- [ ] 4.2 Build the cc-sdd subprocess adapter
  - Implement the SDD framework contract by shelling out to the `cc-sdd` CLI binary using subprocess execution (not shell interpolation) to prevent command injection
  - Pass spec name, language, and spec directory path as separate argument array entries to each invocation
  - Capture stdout and stderr; map non-zero exit codes to a structured failure result carrying exit code and stderr
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

---

- [ ] 5. (P) Build the approval gate for human review checkpoints
  - Read `spec.json` fresh on every check (no caching) to detect out-of-process approvals
  - Check the `approvals.requirements.approved`, `approvals.design.approved`, and `approvals.tasks.approved` fields for the appropriate phase gate
  - Return a pending result if `spec.json` is missing, malformed, or the approval field is false or absent (fail closed)
  - Include a human-readable instruction in the pending result explaining which file to update and what approval action to take
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

---

- [ ] 6. Build the phase execution engine

- [ ] 6.1 Implement per-phase dispatch routing phases to the appropriate adapter operations
  - Dispatch REQUIREMENTS, DESIGN, VALIDATE_DESIGN, and TASK_GENERATION to the corresponding SDD adapter operations
  - Return a structured result from each phase carrying the list of artifact paths produced on success, or an error description on failure
  - Implement no-op stubs for SPEC_INIT, IMPLEMENTATION, and PULL_REQUEST phases (these are wired in spec4 and spec8); stubs return success with an empty artifact list
  - _Requirements: 4.1, 6.1, 6.2, 6.3, 6.4_

- [ ] 6.2 Implement phase lifecycle hooks with LLM context isolation
  - Invoke the phase pre-exit hook before leaving any phase and the post-enter hook before executing the new phase's operations
  - Reset the active LLM context at every phase transition to prevent accumulated conversation state from carrying over between phases
  - _Requirements: 4.2, 4.3_

---

- [ ] 7. Build the workflow orchestration engine

- [ ] 7.1 Implement the 7-phase sequential state machine with artifact validation and atomic state persistence
  - Drive the fixed phase sequence and advance to the next phase only after the current phase completes successfully
  - Before each phase, validate that all required artifacts from the previous phase exist on disk; reject the transition and halt if any are missing
  - Persist updated workflow state atomically to disk before invoking any operations in the next phase
  - Prevent concurrent phase execution and handle process interruption by restoring the last persisted state on the next run
  - Expose current workflow state (phase, completed phases, status) as a queryable data structure
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.4, 4.5_

- [ ] 7.2 Integrate phase runner and emit progress events throughout execution
  - Invoke the phase runner for each phase and collect phase results
  - Emit phase-start before execution, phase-complete with duration and artifact list on success, and phase-error with operation name on failure
  - Transition to the failed state when a phase fails, persisting failure detail and emitting workflow-failed before returning
  - _Requirements: 4.1, 4.2, 8.1, 8.2, 8.3_

- [ ] 7.3 Integrate approval gates and implement paused-for-approval state handling
  - After each SDD phase that requires approval (REQUIREMENTS, DESIGN, TASK_GENERATION), check the approval gate before advancing
  - When the gate returns pending, persist the `paused_for_approval` state with `currentPhase` set to the just-completed phase, emit approval-required event, and return to the caller
  - On the next run, re-check the approval gate for the stored `currentPhase` before advancing; never re-execute an already-completed phase
  - When transitioning to IMPLEMENTATION, verify `ready_for_implementation` is true in `spec.json`; reject the transition if it is not
  - _Requirements: 4.6, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

---

- [ ] 8. Build the application use case and aes CLI entry point

- [ ] 8.1 Build the RunSpec use case that orchestrates workflow execution
  - Construct the workflow engine with all injected dependencies (adapters, infrastructure, ports) using constructor-based dependency injection
  - On `--resume`, restore the last persisted state before delegating to the workflow engine
  - On `--dry-run`, validate that the spec exists and configuration loads without errors; exit successfully without starting the workflow
  - Support `--provider` flag to override the LLM provider from configuration at runtime
  - _Requirements: 1.1, 1.6, 1.7, 3.6_

- [ ] 8.2 Build the aes CLI command with run subcommand, flag parsing, and progress rendering
  - Define the `aes run <spec-name>` command using the CLI framework with typed flag definitions: `--provider`, `--dry-run`, `--resume`, `--log-json <file>`
  - Exit with a non-zero status code and descriptive error message when spec name is invalid, spec does not exist, or configuration fails to load
  - Subscribe to the workflow event bus before starting the use case; render phase headers, elapsed time for the active phase, and error messages to the terminal
  - Display a completion summary (phases completed, artifacts produced) when the workflow finishes successfully
  - When `--log-json <file>` is provided, write every workflow event as newline-delimited JSON to the specified file path in addition to terminal output
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 8.4, 8.5, 8.6_

---

- [ ] 9. Integration testing and end-to-end verification

- [ ] 9.1 (P) Write integration tests for adapters, state store, and workflow engine sub-sequences
  - Test `CcSddAdapter` against the real cc-sdd binary in a temp directory: verify artifact creation and structured error result for each of the four operations
  - Test `WorkflowStateStore` persist and restore cycle: verify state file contents and restoration of each status variant including `paused_for_approval`
  - Test `WorkflowEngine` through a 3-phase sub-sequence (SPEC_INIT → REQUIREMENTS → paused for approval) with stub adapters: assert state file, events emitted, and approval gate check on resume
  - _Requirements: 3.1, 3.2, 3.3, 3.6, 6.1, 6.4_

- [ ] 9.2 (P) Write end-to-end tests for full workflow execution including dry-run and resume
  - Test `aes run <spec> --dry-run`: assert no file writes occur and exit code is 0
  - Test `aes run <spec>` through all 7 phases against a real spec directory with cc-sdd installed: verify artifacts are produced at each gated boundary
  - Test `--resume` across a simulated interruption after REQUIREMENTS: assert SPEC_INIT is not re-executed and workflow continues from REQUIREMENTS approval gate
  - Test `--log-json <file>`: assert all workflow events appear in the log file as valid newline-delimited JSON
  - _Requirements: 1.1, 1.6, 1.7, 1.8, 3.6, 5.1, 5.5_
