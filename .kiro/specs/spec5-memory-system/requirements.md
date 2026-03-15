# Requirements Document

## Project Description (Input)

memory-system

See `spec5: memory-system` section at `docs/agent/dev-agent-v1-specs.md` and `docs/memory/memory-architecture.md`.

## Introduction

The Memory System enables the Autonomous Engineer agent to accumulate, persist, and retrieve knowledge across workflow sessions. It transforms the agent from a stateless assistant into a learning system that reuses past solutions, avoids repeated failures, and reduces prompt token usage through targeted knowledge injection. The system implements three persistent memory layers (project memory, knowledge memory, and failure memory) plus in-session short-term memory, all backed by Git-versioned Markdown files in the `orchestrator-ts/` codebase.

## Requirements

### Requirement 1: Short-Term Memory

**Objective:** As an AI Dev Agent, I want an in-session store for the active workflow state, so that each phase and iteration can access current context without re-loading from disk on every step.

#### Acceptance Criteria

1. The Memory System shall provide an in-process short-term memory store that holds the current spec name, current workflow phase, active task progress, and a list of recently accessed files for the duration of one workflow execution.
2. When a workflow execution ends, the Memory System shall discard all short-term memory without persisting it to disk.
3. While a workflow is executing, the Memory System shall allow any workflow component (workflow engine, agent loop, context engine) to read and write short-term memory entries without file I/O.
4. When short-term memory is initialized at the start of a workflow run, the Memory System shall clear any residual state from a previous in-process run to prevent cross-run contamination.

---

### Requirement 2: Project Memory

**Objective:** As an AI Dev Agent, I want a file-based store for repository-specific knowledge, so that coding conventions, architecture decisions, and review feedback persist across workflow sessions and inform future development.

#### Acceptance Criteria

1. The Memory System shall initialize project memory under a `.memory/` directory at the repository root, creating it if it does not exist, with the following files: `project_rules.md`, `coding_patterns.md`, `review_feedback.md`, and `architecture_notes.md`.
2. When a new architectural decision or coding convention is identified during a workflow run, the Memory System shall append a structured entry to the appropriate project memory file (`project_rules.md` or `architecture_notes.md`).
3. When review feedback recurs across multiple review cycles, the Memory System shall update `review_feedback.md` with the recurring pattern and the suggested correction.
4. When implementation patterns prove effective across multiple tasks, the Memory System shall record them as named entries in `coding_patterns.md`.
5. The Memory System shall store project memory files as human-readable Markdown so that they are version-controlled by Git and inspectable by humans without tooling.
6. If a `.memory/` directory or file does not exist when the agent attempts a read, the Memory System shall return an empty result without raising an error.

---

### Requirement 3: Knowledge Memory

**Objective:** As an AI Dev Agent, I want a store of reusable engineering patterns extracted from successful runs, so that the same solutions are available across workflow sessions and do not need to be rediscovered each time.

#### Acceptance Criteria

1. The Memory System shall maintain knowledge memory under a `rules/` directory with the following files: `coding_rules.md`, `review_rules.md`, `implementation_patterns.md`, and `debugging_patterns.md`.
2. When a solution strategy is confirmed to be effective across multiple tasks, the Memory System shall extract it as a named pattern and write it to `rules/implementation_patterns.md`.
3. When a debugging strategy resolves a difficult failure, the Memory System shall write the strategy as a structured entry in `rules/debugging_patterns.md`.
4. The Memory System shall treat knowledge memory files as append-only during normal operation, adding new entries without deleting existing ones (except via the self-healing rule update path).
5. Where the self-healing loop triggers a rule update, the Memory System shall allow targeted in-place edits to existing entries in `rules/coding_rules.md` and `rules/review_rules.md`.

---

### Requirement 4: Failure Memory

**Objective:** As an AI Dev Agent, I want structured records of failures persisted across restarts, so that the self-healing loop can analyze past failures and the agent does not repeat the same mistakes in future sessions.

#### Acceptance Criteria

1. When a task section exceeds the implementation-loop retry threshold, the Memory System shall write a structured failure record containing: task ID, spec name, workflow phase, a description of what was attempted, the error messages encountered, the identified root cause, and the rule update applied (if any).
2. The Memory System shall store failure records at `.memory/failures/failure_{timestamp}_{task_id}.json` in JSON format.
3. When the agent starts a new workflow run, the Memory System shall make all existing failure records available for retrieval without requiring the caller to list files manually.
4. If the Memory System fails to write a failure record due to a filesystem error, it shall log the error and continue execution without crashing the workflow.
5. The Memory System shall support retrieval of failure records filtered by spec name or task ID to allow targeted failure analysis.

---

### Requirement 5: Memory Reader and Retrieval

**Objective:** As an AI Dev Agent, I want a retrieval interface that returns ranked, relevant memory entries for a given query, so that the context engine can inject targeted knowledge into prompts without loading entire memory files.

#### Acceptance Criteria

1. The Memory System shall expose a `MemoryReader` interface that accepts a natural-language or keyword query and returns a ranked list of matching memory entries from project memory and knowledge memory.
2. When a query is submitted, the Memory System shall support keyword-based matching against entry titles and content across all memory files, returning the top N results (configurable, default: 5).
3. When implementing a new module, the Memory System shall retrieve entries from `coding_patterns.md` and `coding_rules.md` relevant to the module's domain.
4. When the agent encounters a failing implementation, the Memory System shall retrieve entries from `debugging_patterns.md` relevant to the error type.
5. When performing a review step, the Memory System shall retrieve entries from `review_rules.md` relevant to the artifact being reviewed.
6. The Memory System shall return results with metadata including: source file, entry title, and relevance score, so that callers can decide how much to include given token budget constraints.
7. If no relevant entries are found for a query, the Memory System shall return an empty list without raising an error.

---

### Requirement 6: Memory Write Strategy and Lifecycle

**Objective:** As an AI Dev Agent, I want memory to be updated only when genuinely useful knowledge is discovered, so that memory files remain concise and do not accumulate noise or redundant entries.

#### Acceptance Criteria

1. The Memory System shall only write to persistent memory (project memory or knowledge memory) when an explicit write trigger occurs: a successful implementation pattern, recurring review feedback, a debugging discovery, or a self-healing rule update.
2. When a write trigger occurs, the Memory System shall deduplicate new entries against existing content before appending, skipping the write if an equivalent entry already exists.
3. The Memory System shall define a structured entry format for each memory file type (pattern, rule, feedback, failure) with mandatory fields: title, context, description, and date.
4. When updating project memory, the Memory System shall append entries atomically (write to a temp file and rename) to prevent corruption from concurrent writes or crashes.
5. The Memory System shall expose a `MemoryWriter` interface that accepts a memory type, entry content, and target file, and returns success or a structured error.
6. If the Memory System is in read-only mode (e.g., dry-run execution), it shall skip all write operations and log the skipped writes without raising an error.

---

### Requirement 7: Integration with Orchestrator Core

**Objective:** As an Orchestrator Core component, I want the memory system accessible through a clean port interface, so that the workflow engine and use case layer can interact with memory without depending on file system details.

#### Acceptance Criteria

1. The Memory System shall expose its capabilities through a `MemoryPort` interface defined in the application ports layer (`orchestrator-ts/application/ports/`), with methods for read, write, and query operations.
2. The file-based memory implementation shall reside in the infrastructure layer (`orchestrator-ts/infra/memory/`) and implement the `MemoryPort` interface through dependency injection.
3. When the `RunSpecUseCase` initializes, it shall receive a `MemoryPort` instance via constructor injection, not by importing the file-based implementation directly.
4. The Memory System shall be initializable with a configurable base directory so that tests can use temporary directories without affecting real project memory.
5. The Memory System shall not import from the domain or use-case layers; all dependencies shall flow inward per Clean Architecture rules.
