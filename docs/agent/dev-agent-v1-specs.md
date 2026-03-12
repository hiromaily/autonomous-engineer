# Spec Plan

This document defines the specification breakdown for implementing AI Dev Agent v1, as described in [dev-agent-v1.md](dev-agent-v1.md).

Each spec maps to one or more architecture documents under `docs/` and is designed to be independently implementable and deliverable via sdd framework like [cc-sdd](https://github.com/gotalab/cc-sdd) and [OpenSpec](https://openspec.dev/), [spec-kit](https://github.com/github/spec-kit).

---

## Design Principles

- **Dependency order**: specs are listed in implementation order; each spec depends only on those listed before it
- **Single responsibility**: each spec owns one architectural concern with a clearly defined interface boundary
- **Independently testable**: each spec can be verified in isolation before integration
- **v1 scope**: specs 1–10 cover the complete AI Dev Agent v1 feature set; spec 11 is a stretch goal (v1.x)

---

## Architecture Reference

| Spec | Architecture Document(s) |
|---|---|
| spec1: orchestrator-core | system-overview.md, architecture/architecture.md |
| spec2: tool-system | architecture/tool-system-architecture.md |
| spec3: agent-safety | architecture/agent-safety-architecture.md |
| spec4: agent-loop | architecture/agent-loop-architecture.md |
| spec5: memory-system | memory/memory-architecture.md |
| spec6: context-engine | architecture/context-engineering-architecture.md |
| spec7: task-planning | architecture/task-planning-architecture.md |
| spec8: git-integration | architecture/architecture.md (Git Controller section) |
| spec9: implementation-loop | agent/dev-agent-v1.md |
| spec10: self-healing-loop | agent/dev-agent-v1.md |
| spec11: codebase-intelligence | architecture/codebase-intelligence-architecture.md |

---

## Dependency Map

```
spec1: orchestrator-core
├── spec2: tool-system
│   └── spec3: agent-safety
├── spec4: agent-loop
│   └── spec7: task-planning
│       └── spec9: implementation-loop
│           └── spec10: self-healing-loop
├── spec5: memory-system
│   └── spec10: self-healing-loop
└── spec6: context-engine
    ├── spec7: task-planning
    └── spec9: implementation-loop

spec8: git-integration  (depends on spec2: tool-system)
spec11: codebase-intelligence  (v1.x — depends on spec2, spec6)
```

> **Note:** The tree above shows the full transitive hierarchy, not just direct `spec1` children.
> Specs that appear as branches of `spec1` may still require intermediate specs before they can start.
> Always refer to each spec's `Dependencies` field for the exact prerequisites.

The following table summarizes which specs can be implemented in parallel:

| Wave | Specs | Prerequisite |
|---|---|---|
| 1 | spec1 | — |
| 2 | spec2, spec5 | spec1 |
| 3 | spec3, spec4, spec6 | spec2 (for spec3, spec4); spec2 + spec5 (for spec6) |
| 4 | spec7, spec8 | spec4 + spec6 (for spec7); spec2 + spec3 (for spec8) |
| 5 | spec9 | spec4 + spec6 + spec7 + spec8 |
| 6 | spec10 | spec5 + spec9 |
| 7 | spec11 _(v1.x)_ | spec2 + spec6 |

---

## v1 Specs

### spec1: orchestrator-core

**Architecture**: `docs/system-overview.md`, `docs/architecture/architecture.md`

**Scope**: The runnable skeleton of the system. Nothing else can execute without this. Establishes the entry point, the phase-based workflow state machine, the primary SDD adapter, and the LLM provider abstraction.

**Sub-components**:
- `cli` — Entry point: `aes run <spec-name>`, configuration loading, execution trigger, progress reporting
- `workflow-engine` — State machine managing the 7-phase development lifecycle:
  `SPEC_INIT → REQUIREMENTS → DESIGN → VALIDATE_DESIGN → TASK_GENERATION → IMPLEMENTATION → PULL_REQUEST`
- `phase-transitions` — Phase validation, lifecycle hooks, state persistence, phase-boundary context reset
- `cc-sdd-adapter` — Adapter that invokes cc-sdd commands to generate requirements, design docs, and task definitions from a spec
- `llm-abstraction` — LLM provider interface + Claude provider implementation; all LLM calls flow through this abstraction, never directly to provider APIs

**Dependencies**: none

**Success criteria**: `aes run <spec>` triggers the full 7-phase sequence, invokes cc-sdd at each spec phase, uses Claude via the abstraction, and resets context at each phase boundary.

---

### spec2: tool-system

**Architecture**: `docs/architecture/tool-system-architecture.md`

**Scope**: The structured execution interface between the LLM and the development environment. All filesystem, shell, git, code analysis, and knowledge operations go through this system. Provides the deterministic tool interface that the agent loop depends on.

**Sub-components**:
- `tool-interface` — Common `Tool<Input, Output>` interface: name, description, JSON schema, execute function
- `tool-context` — Execution context injected into every tool: workspaceRoot, workingDirectory, permissions, memory client, logger
- `tool-registry` — Central registry for tool registration, discovery, and schema retrieval
- `tool-executor` — Validates input against schema, invokes tool, validates output, enforces timeouts, handles errors
- `permission-system` — `PermissionSet` capability flags (filesystemRead, filesystemWrite, shellExecution, gitWrite, networkAccess); execution modes (ReadOnly, Dev, CI, Full)
- `tool-categories` — Implementations for all five tool categories:
  - **Filesystem tools**: `read_file`, `write_file`, `list_directory`, `search_files`
  - **Git tools**: `git_status`, `git_diff`, `git_commit`, `git_branch`
  - **Shell tools**: `run_command`, `run_test_suite`, `install_dependencies`
  - **Code analysis tools**: `parse_typescript_ast`, `find_symbol_definition`, `find_references`, `dependency_graph`
  - **Knowledge tools**: `search_memory`, `retrieve_spec`, `retrieve_design_doc`
- `error-handling` — Structured `ToolError` type with `"validation" | "runtime" | "permission"` categories

**Dependencies**: spec1 (orchestrator-core)

**Success criteria**: Tools can be registered and invoked with schema-validated inputs/outputs; permission checks block unauthorized operations; all 5 tool categories are available and functional.

---

### spec3: agent-safety

**Architecture**: `docs/architecture/agent-safety-architecture.md`

**Scope**: The operational safety layer that wraps tool execution. Defines policies and guardrails that prevent the agent from causing unintended or destructive changes to the environment.

**Sub-components**:
- `workspace-isolation` — Enforces that all file operations stay within the configured workspace root; rejects any path traversal outside the boundary
- `filesystem-guardrails` — Path normalization, protected file detection (`.env`, `secrets.json`, `.git/config`), write validation
- `git-safety` — Protected branch enforcement (no direct push to `main`/`production`); feature branch naming conventions; change size limits (max files per commit)
- `shell-restrictions` — Allowlist/blocklist for shell commands; pattern matching to block destructive commands (`rm -rf /`, `shutdown`, etc.)
- `sandboxing` — Containerized or restricted-shell execution environment for untrusted code and test runners
- `iteration-limits` — Configurable `maxIterations` and `maxRuntime` per agent session; triggers graceful stop on breach
- `failure-detection` — Detects repeated identical failures (threshold: 3 occurrences); pauses execution and requests human review
- `destructive-action-detection` — Flags high-impact operations (mass file deletion, force-push) and routes to human approval workflow
- `rate-limiting` — Per-operation frequency limits for tool execution, repository modifications, and external API requests
- `audit-logging` — Immutable log of every tool invocation: timestamp, tool, parameters, result, errors
- `human-approval-workflow` — Approval gate for flagged high-risk operations; agent pauses and proposes change; resumes on approval
- `emergency-stop` — Signal handler for immediate termination of agent loop, tool execution, and background processes

**Dependencies**: spec2 (tool-system)

**Success criteria**: Agent cannot write outside the workspace; protected branches and sensitive files are untouched; shell blocklist is enforced; repeated failures pause execution and request human review; all tool invocations are logged.

---

### spec4: agent-loop

**Architecture**: `docs/architecture/agent-loop-architecture.md`

**Scope**: The cognitive core of the AI Dev Agent — the iterative reasoning and execution cycle that turns a task description into completed work. Operates at the level of individual LLM iterations, below task planning and above raw tool execution.

**Sub-components**:
- `agent-state` — Persistent state across iterations: `{ task, plan, completedSteps, currentStep, observations }`
- `plan-step` — LLM reasons over current state to produce the next `ActionPlan`: what to do next and why
- `act-step` — Executes the planned action via the tool system; produces a raw result
- `observe-step` — Records the tool result as a structured `Observation`; adds to context for next iteration
- `reflect-step` — LLM evaluates whether the result was expected, what was learned, and whether the plan needs adjustment
- `update-state-step` — Updates `AgentState`: marks completed steps, logs discoveries, updates the working plan
- `iteration-control` — Enforces `maxIterations` limit; handles loop termination (task complete / human intervention required / safety limit)
- `action-types` — Supports four action categories: Exploration (read/search), Modification (write/edit), Validation (test/build/lint), Documentation (update docs/comments)
- `error-recovery` — Intra-loop recovery: analyze error → identify root cause → attempt fix → re-run validation
- `observability` — Per-iteration structured logs: iteration number, action, tools invoked, execution time, result status

**Dependencies**: spec2 (tool-system), spec1 (orchestrator-core)

**Success criteria**: Given a task, the agent iteratively executes PLAN→ACT→OBSERVE→REFLECT→UPDATE until the task is complete or a stopping condition is reached; iteration logs are produced; errors trigger recovery attempts before escalation.

---

### spec5: memory-system

**Architecture**: `docs/memory/memory-architecture.md`

**Scope**: Persistent knowledge storage that enables the agent to accumulate and reuse information across workflow sessions.

**Sub-components**:
- `short-term-memory` — In-process store for active workflow state: current spec, current phase, task progress, working context
- `project-memory` — File-based store at `.memory/` for repository-specific knowledge:
  - `project_rules.md` — Coding conventions and architectural decisions
  - `coding_patterns.md` — Recurring implementation approaches
  - `review_feedback.md` — Feedback from previous review cycles
- `knowledge-memory` — Reusable implementation patterns and strategies extracted from successful past runs and stored as structured entries
- `failure-memory` — Structured records of failures: what was attempted, what failed, root cause, and resolution; feeds directly into self-healing-loop
- `memory-reader` — Retrieves relevant memory entries given a query; supports keyword search and metadata filtering; returns ranked results for context injection

**Dependencies**: spec1 (orchestrator-core)

**Success criteria**: Knowledge from previous sessions (patterns, rules, review feedback) is automatically retrievable in new sessions; failure records persist across restarts; memory reader returns relevant results for context injection.

---

### spec6: context-engine

**Architecture**: `docs/architecture/context-engineering-architecture.md`

**Scope**: Constructs the information provided to the LLM at each reasoning step. Determines what goes into every prompt — no more, no less. Critical for reasoning quality and token efficiency across all other specs.

**Sub-components**:
- `context-layers` — 7-layer context model assembled per prompt:
  1. System instructions (agent role, tool rules, coding standards, safety constraints)
  2. Task description
  3. Active specification (relevant sections of design/requirements docs)
  4. Relevant code context (retrieved by symbol, dependency, or file proximity)
  5. Repository state (git status, modified files, current branch)
  6. Memory retrieval (injected knowledge from memory-system)
  7. Tool results (outputs from current session's tool calls)
- `context-planner` — Decides which files, memories, and spec sections to retrieve, based on current task and step
- `token-budget-manager` — Allocates tokens per layer (e.g., system:1000, task:500, spec:2000, code:4000, memory:1500, tools:2000); adapts budget to model limits
- `context-compression` — Reduces oversized layers: document summarization, function-level code extraction, memory priority filtering
- `iterative-expansion` — Supports agent-driven context growth mid-iteration (agent discovers it needs an additional file → retrieves and adds to context)
- `context-cache` — Caches stable layers (system instructions, architecture docs, coding standards) to avoid redundant retrieval
- `phase-isolation` — Resets accumulated context when the workflow transitions between phases; prevents cross-phase context pollution
- `task-isolation` — Ensures each task section starts with a fresh minimal context derived only from its own artifacts

**Dependencies**: spec1 (orchestrator-core), spec2 (tool-system), spec5 (memory-system)

**Success criteria**: Prompts contain only the relevant layers for each step; token usage stays within configured budget; context does not leak between phases or task sections; compression activates automatically when limits are approached.

---

### spec7: task-planning

**Architecture**: `docs/architecture/task-planning-architecture.md`

**Scope**: The hierarchical planning layer that sits above the agent loop. Transforms a high-level goal into a structured, executable plan. Guides the sequence of work the agent loop operates on.

**Sub-components**:
- `planning-hierarchy` — Four-level structure: Goal → Tasks → Steps → Actions; each level has distinct granularity and lifecycle
- `plan-types` — TypeScript types: `TaskPlan { goal, tasks }`, `Task { id, title, status, steps }`, `Step { id, description, status, dependsOn[] }`
- `initial-plan-generation` — LLM generates an initial plan from task description, architecture docs, and repository context
- `dynamic-plan-adjustment` — Updates plan mid-execution when new information (existing modules, architectural constraints, test failures) changes the approach
- `step-execution-model` — Each step is handed off to the agent loop; step status is updated (pending → in_progress → completed) based on agent loop outcome
- `dependency-tracking` — Respects `dependsOn` relationships between steps; prevents out-of-order execution
- `failure-recovery` — On step failure: retry → refine implementation → revise plan; escalates to self-healing-loop when retries are exhausted
- `plan-validation` — Pre-execution check for architectural compatibility, coding standards, and dependency constraints
- `plan-persistence` — Plans stored at `.memory/tasks/task_{id}.json`; enables resume after interruption or crash
- `human-interaction` — Exposes plan for human review before execution of large or high-risk changes; waits for approval before proceeding

**Dependencies**: spec4 (agent-loop), spec6 (context-engine)

**Success criteria**: Given a cc-sdd task list, the system generates an executable plan, respects step dependencies, persists plan state, and resumes correctly after interruption; human review gate works for flagged plans.

---

### spec8: git-integration

**Architecture**: `docs/architecture/architecture.md` (Git Controller section), `docs/agent/dev-agent-v1.md`

**Scope**: All repository operations required for an automated development pipeline. Fully encapsulated behind a Git controller interface; all other components call this via tools from the tool-system.

**Sub-components**:
- `branch-manager` — Creates feature branches from the configured base branch; names branches from spec and task metadata (e.g., `agent/cache-implementation`)
- `commit-automation` — Detects staged changes, generates descriptive commit messages using the LLM, validates against safety limits (change size), and commits
- `push` — Pushes the feature branch to the configured remote after safety checks (not a protected branch, not a force push)
- `pull-request-creator` — Creates pull requests via repository API with LLM-generated title and body; includes spec reference and implementation summary

**Dependencies**: spec2 (tool-system), spec3 (agent-safety)

**Success criteria**: After implementation completes, the system creates a feature branch, commits all changes with meaningful messages, pushes, and opens a pull request — with no manual intervention and no writes to protected branches.

---

### spec9: implementation-loop

**Architecture**: `docs/agent/dev-agent-v1.md`

**Scope**: Orchestrates the execution of each task section from the task plan. Drives the agent loop through an implement → review → improve → commit cycle per task section, and coordinates with the review engine to enforce quality gates.

**Sub-components**:
- `task-section-executor` — Iterates through task sections from the plan; for each section: initializes context, invokes agent loop, evaluates outcome
- `review-engine` — Automated review of generated output against:
  - Requirement alignment (does the implementation satisfy the spec?)
  - Design consistency (does it follow the architecture?)
  - Code quality (linting, test coverage, naming conventions)
- `implement-review-improve-commit` — Per-section cycle:
  1. `implement` — Agent loop writes code for the section
  2. `review` — Review engine evaluates output and generates feedback
  3. `improve` — Agent loop applies review feedback to fix issues
  4. `commit` — Git integration commits the approved changes
- `iteration-control` — Tracks retry count per section; configurable threshold (e.g., 3 cycles); escalates to self-healing-loop on threshold breach
- `quality-gate` — Defines review pass/fail criteria; a section cannot proceed to commit until the gate is satisfied

**Dependencies**: spec4 (agent-loop), spec7 (task-planning), spec6 (context-engine), spec8 (git-integration)

**Success criteria**: Each task section is implemented, passes automated review, and is committed; the cycle retries up to the configured threshold; sections that exceed the threshold escalate correctly to self-healing.

---

### spec10: self-healing-loop

**Architecture**: `docs/agent/dev-agent-v1.md`, `docs/architecture/agent-loop-architecture.md` (Error Recovery section)

**Scope**: Activates when the implementation-loop exceeds its retry threshold or when the agent enters a stuck state. Analyzes the failure, identifies missing knowledge, updates rules, and resumes with improved context.

**Sub-components**:
- `failure-detection` — Triggered by: retry threshold breach from implementation-loop; repeated identical errors in agent-loop; agent reporting inability to proceed
- `root-cause-analysis` — LLM-driven analysis of full failure context: what was attempted across all retries, what failed each time, patterns in the errors
- `gap-identification` — Determines which rule, pattern, or knowledge is absent from the current rule set that would have prevented the failure
- `rule-update` — Writes targeted updates to rule files:
  - `rules/coding_rules.md`
  - `rules/review_rules.md`
  - `rules/implementation_patterns.md`
- `failure-record` — Writes a structured failure record to failure-memory (memory-system): task context, root cause, gap identified, rule changes made
- `self-healing-retry` — Resumes the failed task section with updated rules injected into context; logs outcome (resolved / escalated to human)

**Dependencies**: spec9 (implementation-loop), spec5 (memory-system)

**Success criteria**: Repeated failures trigger automatic rule file updates; the agent successfully completes tasks it previously failed after self-healing; failure records persist and are retrievable; tasks that cannot be resolved after self-healing escalate cleanly to human review.

---

## v1.x Spec (Stretch Goal)

### spec11: codebase-intelligence

**Architecture**: `docs/architecture/codebase-intelligence-architecture.md`

**Scope**: Enables the agent to understand and reason about large existing software repositories. Provides scalable code retrieval that feeds into the context-engine. The architecture is fully documented but this spec is excluded from the initial v1 delivery.

**Sub-components**:
- `file-scanner` — Discovers source files, detects changes, filters irrelevant directories (`node_modules/`, `dist/`, `.git/`)
- `parser-layer` — Converts source files to structured representations (AST, symbol definitions, imports, function signatures) using TypeScript compiler API, Tree-sitter, or Rust parsers
- `symbol-index` — Stores symbol definitions (functions, classes, interfaces, types) with file location and metadata
- `dependency-graph` — Represents inter-module relationships: imports, type references, module dependencies; supports impact analysis
- `semantic-index` — Embeds code fragments (functions, classes, documentation) for meaning-based retrieval; supports queries like `"user authentication logic"`
- `query-engine` — Unified retrieval API: symbol lookup, reference search, dependency traversal, semantic search; combines and ranks results from all indices
- `incremental-indexer` — Re-parses only modified files; updates symbol index and dependency graph incrementally
- `code-chunker` — Splits large files into independently retrievable chunks (per function, class, module) for semantic indexing

**Dependencies**: spec2 (tool-system), spec6 (context-engine)

**Success criteria**: The agent can find relevant source files and symbols by name and meaning; dependency paths are traversable; context-engine retrieves code snippets from the query engine rather than loading entire files.

---

## Implementation Order

```
1.  spec1:  orchestrator-core        — CLI, workflow state machine, cc-sdd adapter, LLM abstraction
2.  spec2:  tool-system              — tool interface, registry, executor, 5 tool categories
3.  spec3:  agent-safety             — workspace isolation, guardrails, sandboxing, human approval
4.  spec4:  agent-loop               — PLAN→ACT→OBSERVE→REFLECT→UPDATE, agent state, iteration control
5.  spec5:  memory-system            — project memory, knowledge memory, failure memory, retrieval
6.  spec6:  context-engine           — 7-layer context, planner, token budget, compression, isolation
7.  spec7:  task-planning            — goal→task→steps→actions, dynamic revision, persistence
8.  spec8:  git-integration          — branch, commit, push, pull request
9.  spec9:  implementation-loop      — implement→review→improve→commit, quality gate
10. spec10: self-healing-loop        — failure analysis, rule updates, retry
--- v1 complete ---
11. spec11: codebase-intelligence    — file scanner, parser, symbol index, dependency graph, semantic search
--- v1.x complete ---
```
