# Requirements Document

## Introduction

The `cli-option-debug-workflow` feature adds a `--debug-flow` flag to the `aes run` command. When enabled, this mode replaces real LLM API calls with a deterministic mock provider, allowing developers to verify the full end-to-end workflow execution — including phase transitions, agent loop iterations, tool invocations, and approval gates — without incurring API costs or network dependencies. Alongside the mock LLM, the feature produces structured debug logs capturing agent operation history, LLM prompt/response history, and approval gate history, enabling efficient local troubleshooting.

## Requirements

### Requirement 1: Debug-Flow CLI Flag

**Objective:** As a developer, I want to pass `--debug-flow` to `aes run <spec-name>`, so that I can exercise the full workflow without making real LLM API calls.

#### Acceptance Criteria

1. When the user invokes `aes run <spec-name> --debug-flow`, the CLI shall accept the flag without error and proceed to workflow execution.
2. When `--debug-flow` is active, the CLI shall display a prominent notice (e.g., `[DEBUG-FLOW MODE]`) at startup so the user is aware that LLM calls are mocked.
3. The CLI shall accept `--debug-flow` alongside all other existing flags (`--provider`, `--resume`, `--log-json`) without conflict.

---

### Requirement 2: Mock LLM Provider

**Objective:** As a developer, I want the LLM provider to be replaced by a deterministic mock during debug-flow mode, so that the workflow can run fully offline with predictable, observable responses.

#### Acceptance Criteria

1. When `--debug-flow` is active, the `aes` CLI shall inject a `MockLlmProvider` that implements `LlmProviderPort` instead of the real `ClaudeProvider`.
2. The `MockLlmProvider` shall return a valid phase-completion response for each `complete()` call so that the workflow can advance through all phases without getting stuck; the response shall be clearly marked as a mock (e.g., prefixed with `[MOCK LLM RESPONSE]`).
3. When `--debug-flow` is active, the `aes` CLI shall not require a valid `llm.apiKey` in the configuration; missing or placeholder API keys shall not cause startup errors.
4. The `MockLlmProvider` shall record every `complete()` call — including the full prompt text and the returned response — in an in-memory call log accessible for debug output at the end of the run.
5. The `MockLlmProvider`'s `clearContext()` shall reset its internal conversation history without affecting the recorded call log.

---

### Requirement 3: Agent Operation History Logging

**Objective:** As a developer, I want every agent loop iteration to be logged during debug-flow mode, so that I can trace the full PLAN→ACT→OBSERVE→REFLECT→UPDATE cycle.

#### Acceptance Criteria

1. While `--debug-flow` is active, the `aes` CLI shall emit a structured log entry for each agent loop iteration, containing: iteration number, phase name, step type (plan/act/observe/reflect/update), tool invoked (if any), and result status.
2. When an agent loop iteration completes, the CLI shall emit the log entry to the debug output stream in real time.
3. While `--debug-flow` is active, if a tool invocation fails during an iteration, the CLI shall log the error type, message, and recovery action taken as part of that iteration's entry.
4. The CLI shall not emit agent iteration logs when `--debug-flow` is not set; normal mode log verbosity shall be unaffected.

---

### Requirement 4: LLM Instruction History Logging

**Objective:** As a developer, I want every LLM prompt and response to be logged during debug-flow mode, so that I can inspect what instructions were sent to the model at each step.

#### Acceptance Criteria

1. While `--debug-flow` is active, the CLI shall log each LLM `complete()` call with: a sequential call index, the phase and iteration number at the time of the call, the full prompt text, and the full response text.
2. When a `complete()` call returns an error result (`ok: false`), the CLI shall log the error category and message alongside the prompt that triggered it.
3. The CLI shall write LLM instruction history to the same debug output destination as agent operation history, maintaining chronological order.

---

### Requirement 5: Approval Gate Simulation and Logging

**Objective:** As a developer, I want all approval gate interactions to be auto-simulated and logged during debug-flow mode, so that I can verify gates are triggered at the correct workflow points without manual input.

#### Acceptance Criteria

1. When `--debug-flow` is active and an approval gate is reached, the CLI shall automatically approve the gate (simulate user acceptance) without waiting for interactive input.
2. While `--debug-flow` is active, every approval gate decision — phase, approval type, and outcome — shall be logged as a structured entry in the debug output stream.
3. The CLI shall not auto-approve gates when `--debug-flow` is not set; normal interactive behavior shall be preserved.
4. If the workflow terminates before all phases complete (e.g., error or safety stop), the CLI shall still emit the partial approval history collected up to that point.

---

### Requirement 6: Debug Output Destination

**Objective:** As a developer, I want control over where debug logs are written, so that I can inspect them inline or save them to a file for later analysis.

#### Acceptance Criteria

1. When `--debug-flow` is active and no `--debug-flow-log <path>` option is provided, the CLI shall write debug output to `stderr`, keeping `stdout` clean for normal workflow output.
2. When `--debug-flow-log <path>` is provided, the CLI shall write all debug log entries as NDJSON to the specified file and suppress them from `stderr`.
3. If the `--debug-flow-log` file cannot be opened for writing, the CLI shall emit a warning to `stderr` and fall back to writing debug output to `stderr`.
4. The CLI shall flush and close the debug log file before the process exits, regardless of whether the workflow completed successfully or with an error.
5. When both `--log-json <path>` and `--debug-flow-log <path>` are supplied, the CLI shall write workflow events to `--log-json` and debug entries to `--debug-flow-log` independently, with no overlap in content between the two files.
