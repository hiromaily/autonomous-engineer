# Requirements Document

## Introduction

The **orchestrator-core** is the foundational subsystem of the Autonomous Engineer System (AES). It provides the runnable skeleton upon which all other subsystems depend: the CLI entry point, the phase-based workflow state machine, the SDD framework adapter, and the LLM provider abstraction. No other component in the system can execute without orchestrator-core in place.

This specification covers the five sub-components defined in spec1:

- **CLI** — user-facing command interface (`aes run <spec-name>`)
- **Workflow Engine** — state machine driving the 7-phase development lifecycle
- **Phase Transitions** — validation, lifecycle hooks, state persistence, and context reset at phase boundaries
- **cc-sdd Adapter** — invokes cc-sdd commands to generate spec artifacts (requirements, design, tasks)
- **LLM Abstraction** — unified provider interface with a Claude implementation

**Architecture references**: `docs/system-overview.md`, `docs/architecture/architecture.md`

---

## Requirements

### Requirement 1: CLI Entry Point

**Objective:** As a developer, I want to start a full spec-driven development pipeline with a single command, so that I can automate the development lifecycle without manual orchestration.

#### Acceptance Criteria

1. When the user runs `aes run <spec-name>`, the Autonomous Engineer System shall load the configuration, initialize the Workflow Engine, and begin the 7-phase development lifecycle for the specified spec.
2. When `aes run` is invoked with an invalid or non-existent spec name, the aes CLI shall display a descriptive error message and exit with a non-zero status code without starting the workflow.
3. When the workflow completes successfully, the aes CLI shall display a completion summary including the phases completed and the artifacts generated.
4. If the configuration file is missing or malformed, the aes CLI shall report the specific configuration error and exit without starting the workflow.
5. The aes CLI shall accept an optional `--provider` flag to override the LLM provider specified in configuration.
6. The aes CLI shall accept an optional `--dry-run` flag that validates the spec and configuration without executing the workflow.
7. The aes CLI shall accept an optional `--resume` flag that instructs the Workflow Engine to restore the last persisted state and continue from the last incomplete phase.
8. The aes CLI shall accept an optional `--log-json <file>` flag that writes all workflow events as newline-delimited JSON to the specified file path, suitable for CI/CD environments.

---

### Requirement 2: Configuration Loading

**Objective:** As a developer, I want the system to load configuration from a file and environment variables, so that I can customize provider selection, spec directories, and execution parameters without modifying source code.

#### Acceptance Criteria

1. When the Autonomous Engineer System starts, it shall load configuration from a project-level configuration file (`aes.config.json`) located in the project root before initializing the Workflow Engine.
2. When environment variables are present alongside a configuration file, the Autonomous Engineer System shall merge them, with environment variables taking precedence over file-based values.
3. If required configuration values (e.g., LLM provider API key) are absent, the Autonomous Engineer System shall report each missing value by name and halt initialization before any workflow operation begins.
4. The Autonomous Engineer System shall support configuration of the following fields: LLM provider name, model name, API key, spec directory path, and SDD framework selection.
5. Where multiple SDD frameworks are supported, the Autonomous Engineer System shall select the framework specified in configuration and default to `cc-sdd` when no framework is specified.

---

### Requirement 3: Workflow State Machine

**Objective:** As a developer, I want the system to manage the development lifecycle as a deterministic state machine, so that each phase executes in the correct order with no steps skipped or duplicated.

#### Acceptance Criteria

1. The Workflow Engine shall execute the 7-phase development lifecycle in the following fixed sequence: `SPEC_INIT → REQUIREMENTS → DESIGN → VALIDATE_DESIGN → TASK_GENERATION → IMPLEMENTATION → PULL_REQUEST`.
2. When a phase completes successfully, the Workflow Engine shall persist the updated workflow state to disk before invoking any operations in the next phase.
3. If a phase fails, the Workflow Engine shall persist the failure state, report the failed phase name and error detail, and halt the lifecycle without advancing to the next phase.
4. While a phase is executing, the Workflow Engine shall prevent any concurrent transition to another phase.
5. The Workflow Engine shall expose the current workflow state — including current phase, completed phases, and overall status — as a queryable data structure accessible to the CLI and other sub-components.
6. When a workflow is interrupted (e.g., by process termination) and subsequently restarted with `--resume`, the Workflow Engine shall restore the last persisted state and continue from the interrupted phase without re-executing completed phases.

---

### Requirement 4: Phase Transitions

**Objective:** As a developer, I want phase boundaries to be validated and context-isolated, so that each phase begins with a clean LLM context and receives only the artifacts relevant to its work.

#### Acceptance Criteria

1. When transitioning out of a phase, the Workflow Engine shall invoke the pre-exit lifecycle hook of the current phase before entering the successor phase.
2. When entering a new phase, the Workflow Engine shall invoke the post-enter lifecycle hook of the new phase before executing any phase operations.
3. When a phase transition occurs, the Workflow Engine shall reset the active LLM context to prevent accumulated conversation state from carrying over into the next phase.
4. The Workflow Engine shall validate that all required artifacts from the previous phase exist on disk before allowing transition to the next phase (for example, `requirements.md` must exist before entering `DESIGN`).
5. If required phase artifacts are missing at a transition boundary, the Workflow Engine shall reject the transition, report the specific missing artifacts, and remain in the current phase.
6. When transitioning to the `IMPLEMENTATION` phase, the Workflow Engine shall verify that `ready_for_implementation` is `true` in `spec.json` before proceeding, and reject the transition if it is not.

---

### Requirement 5: Human Approval Gates

**Objective:** As a developer, I want the workflow to pause at designated phase boundaries for human review, so that spec artifacts are approved before the next phase begins.

#### Acceptance Criteria

1. After the `REQUIREMENTS` phase completes, the Workflow Engine shall check `approvals.requirements.approved` in `spec.json` and halt with a prompt for human review if it is `false`.
2. After the `DESIGN` phase completes, the Workflow Engine shall check `approvals.design.approved` in `spec.json` and halt with a prompt for human review if it is `false`.
3. After the `TASK_GENERATION` phase completes, the Workflow Engine shall check `approvals.tasks.approved` in `spec.json` and halt with a prompt for human review if it is `false`.
4. When halted at an approval gate, the aes CLI shall display the path to the artifact requiring review and instructions for approving it before re-running the workflow.
5. When re-run after an approval field is set to `true`, the Workflow Engine shall resume from the next phase without re-executing the already-approved phase.
6. The Workflow Engine shall never advance past an approval gate automatically; approval always requires explicit human action on `spec.json`.

---

### Requirement 6: SDD Framework Adapter (cc-sdd)

**Objective:** As a developer, I want the system to invoke cc-sdd commands at each spec phase, so that spec artifacts are generated through the configured SDD framework rather than directly by the core engine.

#### Acceptance Criteria

1. When the workflow enters the `REQUIREMENTS` phase, the cc-sdd Adapter shall invoke the cc-sdd requirements generation command for the active spec and write the output artifact to the spec directory.
2. When the workflow enters the `DESIGN` phase, the cc-sdd Adapter shall invoke the cc-sdd design generation command, using the approved `requirements.md` as input context.
3. When the workflow enters the `VALIDATE_DESIGN` phase, the cc-sdd Adapter shall invoke the cc-sdd design validation command and write the validation report to the spec directory.
4. When the workflow enters the `TASK_GENERATION` phase, the cc-sdd Adapter shall invoke the cc-sdd task generation command, using the approved `design.md` as input context.
5. If a cc-sdd command exits with a non-zero status, the cc-sdd Adapter shall capture the error output, wrap it in a structured error value, and propagate it to the Workflow Engine without advancing the phase.
6. The cc-sdd Adapter shall implement the `SddFrameworkPort` interface so that it can be replaced by adapters for alternative SDD frameworks (e.g., OpenSpec, SpecKit) without modifying Workflow Engine logic.
7. The cc-sdd Adapter shall pass the spec name, language setting, and spec directory path as parameters to each command invocation.

---

### Requirement 7: LLM Provider Abstraction

**Objective:** As a developer, I want all LLM calls to flow through a unified provider interface, so that the system can switch between AI providers without changing core workflow logic.

#### Acceptance Criteria

1. The Autonomous Engineer System shall define an `LlmProvider` interface that exposes a prompt completion operation and a context reset operation.
2. When any system component requires LLM interaction, it shall invoke the `LlmProvider` interface and never call a provider SDK directly.
3. The Autonomous Engineer System shall include a `ClaudeProvider` implementation of the `LlmProvider` interface that communicates with the Anthropic Claude API using the configured model name and API key.
4. When the context reset operation is called on the `LlmProvider`, the provider implementation shall discard any accumulated conversation or session state so that the next completion call begins from a clean context.
5. If an LLM API call fails due to a network error, rate limit, or API error, the `LlmProvider` shall return a structured error value containing the failure category (`network` | `rate_limit` | `api_error`) and the original provider error detail.
6. The `LlmProvider` shall accept a model name configuration parameter, allowing the Claude model version to be changed via configuration without code changes.
7. Where a provider-specific capability (e.g., streaming responses) is not universally supported across all provider implementations, the `LlmProvider` interface shall define it as optional so that implementations without the capability remain valid.

---

### Requirement 8: Progress Reporting

**Objective:** As a developer, I want the system to emit workflow progress events in real time, so that I can monitor execution status and identify issues without inspecting internal workflow state directly.

#### Acceptance Criteria

1. When each workflow phase begins, the Autonomous Engineer System shall emit a phase-start event containing the phase name and timestamp.
2. When each workflow phase completes, the Autonomous Engineer System shall emit a phase-complete event containing the phase name, duration in milliseconds, and the list of artifacts produced.
3. When an operation within a phase encounters an error, the Autonomous Engineer System shall emit an error event containing the phase name, operation name, and error detail.
4. The aes CLI shall subscribe to workflow events and render them as structured terminal output, including phase headers, progress indicators, and error messages.
5. While the workflow is running, the aes CLI shall display the elapsed time for the currently active phase.
6. When `--log-json <file>` is specified, the Autonomous Engineer System shall write every workflow event to the specified file as newline-delimited JSON in addition to terminal output.
