# Requirements Document

## Project Description (Input)
context-engine

See section `spec6: context-engine` at @docs/agent/dev-agent-v1-specs.md.

## Introduction

The Context Engine is the subsystem responsible for constructing the information provided to the LLM at each reasoning step of the AI Dev Agent. It determines what content is included in every prompt — assembling, prioritizing, compressing, and isolating context from seven distinct layers (system instructions, task description, active specification, relevant code, repository state, memory retrieval, and tool results). The Context Engine is critical to both reasoning quality and token efficiency across all other specs that interact with the LLM.

The Context Engine operates within a three-level lifecycle hierarchy: **session** (one `aes run` invocation) > **phase** (one of the 7 SDD workflow phases) > **task section** (one discrete unit of work within the implementation phase). Context isolation rules operate at both the phase and task-section boundaries.

## Requirements

### Requirement 1: 7-Layer Context Assembly

**Objective:** As an agent loop, I want a structured multi-layer context assembled for each LLM invocation, so that the model receives precisely the information it needs to reason effectively at every step.

#### Acceptance Criteria

1. The Context Engine shall assemble context from exactly seven ordered layers: (1) system instructions, (2) task description, (3) active specification, (4) relevant code context, (5) repository state, (6) memory retrieval, and (7) tool results.
2. When assembling a prompt, the Context Engine shall include the system instructions layer unconditionally in every context build.
3. When the agent loop requests context for a given task and step, the Context Engine shall populate each layer with content appropriate to that task and step.
4. The Context Engine shall preserve layer ordering so that system instructions always precede task description, and tool results always appear last.
5. If a layer contains no content for a given step, the Context Engine shall omit that layer from the assembled context without error.

---

### Requirement 2: Context Planning

**Objective:** As an agent loop, I want a context planner to decide which files, memories, and spec sections to retrieve before assembly, so that only relevant information enters the prompt and unnecessary retrieval is avoided.

#### Acceptance Criteria

1. When the agent loop requests context for a step, the Context Planner shall determine which files to load, which memory entries to retrieve, and which specification sections to include, based on the task description and current step type.
2. The Context Engine shall support step-type-aware planning: for Exploration steps the planner shall include at least the code context and repository state layers; for Modification steps the planner shall include at least the code context and active specification layers; for Validation steps the planner shall include at least the tool results and active specification layers.
3. When the Context Planner evaluates a task, the Context Engine shall use the task description and any previous tool results as inputs to the planning decision.
4. The Context Engine shall not retrieve files or memories that the planner has not selected for inclusion in the current step.
5. The Context Engine shall expose the planner's retrieval decisions as structured metadata so they can be logged and inspected.

---

### Requirement 3: Token Budget Management

**Objective:** As the orchestrator, I want each context layer to be allocated a configurable token budget, so that the total assembled context stays within the LLM's context window limit.

#### Acceptance Criteria

1. The Context Engine shall enforce a configurable per-layer token budget with the following defaults: system instructions 1000 tokens, task description 500 tokens, specification 2000 tokens, code context 4000 tokens, memory 1500 tokens, tool results 2000 tokens.
2. When the total assembled context exceeds the configured model token limit, the Context Engine shall activate compression on the layers that exceed their individual budgets.
3. The Context Engine shall adapt per-layer budgets when the configured LLM model changes, using the model's reported maximum context length as the ceiling.
4. While assembling context, the Context Engine shall track cumulative token usage across all layers; if the configured total limit would be exceeded after all compression has been applied, the Context Engine shall truncate the lowest-priority layer to the remaining budget and emit an error log entry identifying the total overage.
5. The Context Engine shall provide a token usage summary — per-layer actual token count and budget — as part of context assembly output.

---

### Requirement 4: Context Compression

**Objective:** As the orchestrator, I want oversized context layers to be automatically compressed, so that the total context fits within the token budget without losing critical information.

#### Acceptance Criteria

1. When a context layer exceeds its token budget, the Context Engine shall apply compression techniques appropriate to that layer type before including it in the assembled context.
2. When compressing the active specification layer, the Context Engine shall apply document summarization that retains section headings, key decisions, and acceptance criteria.
3. When compressing the code context layer, the Context Engine shall extract only the function signatures, class definitions, and directly relevant code blocks rather than including entire file contents.
4. When compressing the memory retrieval layer, the Context Engine shall filter out lower-priority memory entries, retaining those with the highest relevance score for the current task.
5. If compression of a layer cannot reduce its size to within budget, the Context Engine shall truncate to the budget limit and emit a warning log entry identifying the layer and the number of tokens dropped.
6. The Context Engine shall not apply compression to the system instructions layer or the task description layer.

---

### Requirement 5: Iterative Context Expansion

**Objective:** As the agent loop, I want to request additional context mid-iteration when I discover a dependency or need more information, so that context grows incrementally rather than loading everything upfront.

#### Acceptance Criteria

1. When the agent loop signals that it needs an additional file or resource during an active iteration, the Context Engine shall retrieve and append the requested content to the relevant context layer.
2. When iterative expansion is triggered, the Context Engine shall re-evaluate the token budget and apply compression to the affected layer if the expansion would exceed its allocated budget.
3. The Context Engine shall support iterative expansion for the code context, specification, and memory retrieval layers; expansion requests for system instructions or task description layers shall be rejected with an error.
4. When iterative expansion adds content to the context, the Context Engine shall log the expansion event including the resource identifier, the layer it was added to, and the new cumulative token count.
5. The Context Engine shall enforce a configurable maximum number of iterative expansion events per iteration to prevent unbounded context growth.

---

### Requirement 6: Context Caching

**Objective:** As the orchestrator, I want stable context layers to be cached across iterations, so that redundant retrieval of static content is avoided and assembly latency is reduced.

#### Acceptance Criteria

1. The Context Engine shall cache the system instructions layer and reuse it across all iterations within a session without re-fetching.
2. Where architecture documents and coding standards are included in the context, the Context Engine shall cache their content for the duration of the session and serve from cache on subsequent assembly requests within the same session.
3. When a cached layer's source content changes (e.g., a steering file is updated), the Context Engine shall invalidate the cache entry and re-fetch on the next assembly.
4. The Context Engine shall not cache the tool results layer, the repository state layer, or the memory retrieval layer, as these change between iterations.
5. The Context Engine shall expose cache hit/miss statistics as part of its observability output.

---

### Requirement 7: Phase Isolation

**Objective:** As the workflow engine, I want context to be fully reset when the workflow transitions between phases, so that context from a prior phase does not pollute reasoning in the next phase.

#### Acceptance Criteria

1. When the workflow engine triggers a phase transition, the Context Engine shall discard all non-cached accumulated context from the previous phase.
2. When a new phase begins, the Context Engine shall initialize a fresh context state containing only the system instructions cache and the new phase's task description.
3. The Context Engine shall not carry over tool results, memory retrievals, code context, or repository state from one phase to another phase.
4. The Context Engine shall tag all accumulated context entries with the phase identifier under which they were created, and shall reject any tagged entry from a different phase during context assembly.
5. The Context Engine shall emit a phase-reset event in its structured log each time a phase transition is processed.

---

### Requirement 8: Task Isolation

**Objective:** As the implementation loop, I want each task section to begin with a fresh minimal context derived only from its own artifacts, so that context from a prior task section does not interfere with the current task's reasoning.

#### Acceptance Criteria

1. When a new task section begins execution, the Context Engine shall initialize a task-scoped context state independent of any previous task section's accumulated context.
2. The Context Engine shall derive the initial task-scoped context from only the task section's description, the relevant specification sections identified by the context planner, and the system instructions.
3. The Context Engine shall not inherit tool results, code retrievals, or memory entries from a prior task section into the new task section's initial context.
4. While a task section is executing, the Context Engine shall accumulate context expansions and tool results within that task section's isolated scope.
5. When a task section completes, the Context Engine shall discard the task-scoped accumulated context and release associated token budget allocations.

---

### Requirement 9: Observability

**Objective:** As a developer or operator, I want context construction to emit structured logs at each step, so that I can understand what information the agent received and diagnose reasoning failures.

#### Acceptance Criteria

1. The Context Engine shall emit a structured log entry for each context assembly request, including: step type, list of layers assembled, per-layer token counts, cache hit/miss per layer, and total token count.
2. When the Context Planner makes retrieval decisions, the Context Engine shall log the selected files, memory query, and spec sections with the rationale field set to the step type and task description excerpt.
3. When context compression is applied, the Context Engine shall log the layer name, original token count, compressed token count, and compression technique used.
4. When iterative expansion is applied, the Context Engine shall log the requested resource, the layer it was added to, and the updated token total.
5. The Context Engine shall not include raw context content in observability logs; only metadata (layer names, token counts, resource identifiers) shall be logged to prevent sensitive data leakage.

---

### Requirement 10: Integration with Upstream Systems

**Objective:** As the agent loop and task planning system, I want the Context Engine to integrate with the memory-system, tool-system, and orchestrator-core, so that each layer can be populated from its authoritative source.

#### Acceptance Criteria

1. When populating the memory retrieval layer, the Context Engine shall query the memory-system's memory reader using the current task description as the query input and inject the returned ranked results.
2. When populating the repository state layer, the Context Engine shall invoke the tool-system's `git_status` tool and include the returned modified files, current branch, and pending changes.
3. When populating the active specification layer, the Context Engine shall retrieve spec artifacts from the path configured in the orchestrator's workflow state for the current phase.
4. When populating the code context layer, the Context Engine shall use the tool-system's `read_file`, `search_files`, or `find_symbol_definition` tools as directed by the context planner.
5. The Context Engine shall interact with the tool-system through the tool executor interface, respecting all permission constraints configured for the current execution mode.

---

### Requirement 11: Graceful Degradation

**Objective:** As the agent loop, I want the Context Engine to assemble the best possible context even when an upstream system is partially unavailable, so that the agent can continue operating rather than failing hard on a retrieval error.

#### Acceptance Criteria

1. If the memory-system is unavailable when the memory retrieval layer is being populated, the Context Engine shall omit the memory retrieval layer from the assembled context, log a warning identifying the failure, and continue assembly with the remaining layers.
2. If a tool-system call fails when populating the code context or repository state layer, the Context Engine shall omit the affected layer, log an error including the tool name and failure reason, and continue assembly.
3. If the active specification layer cannot be retrieved (e.g., spec file not found), the Context Engine shall omit that layer and emit a warning log; it shall not omit the task description layer as a fallback substitute.
4. When one or more layers are omitted due to upstream failure, the Context Engine shall include a `degraded: true` flag and a list of omitted layer names in the context assembly output metadata.
5. The Context Engine shall not silently degrade; every omitted layer due to a retrieval failure shall produce a log entry at warning level or above.
