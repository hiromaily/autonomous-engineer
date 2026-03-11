# Implementation Plan

## Tasks

- [ ] 1. Define memory port contracts
- [x] 1.1 Define short-term memory types and interface
  - Define the state shape that holds the active spec name, current workflow phase, task progress detail, and a list of recently accessed files
  - Define the task progress structure that captures current and completed step identifiers
  - Define the synchronous port interface with read, write (partial-merge), and clear operations — no async methods
  - Ensure `currentPhase` references the `WorkflowPhase` union type from the domain layer via an import that respects Clean Architecture direction
  - _Requirements: 1.1, 1.2, 1.3, 7.5_

- [x] 1.2 Define persistent memory port types and MemoryPort interface
  - Define discriminated union types for the two memory layer targets (project files and knowledge files) with their allowed file name values
  - Define the entry format type with mandatory title, context, description, and date fields
  - Define the write trigger union covering the four allowed trigger sources
  - Define the query input and output types: query text, type filter, topN limit, ranked results with source file and relevance score
  - Define the failure record type and the optional filter type for retrieval
  - Define the error category union (`io_error`, `invalid_entry`, `not_found`) and the write result discriminated union
  - Define the unified `MemoryPort` interface composing short-term access and all persistent operations (append, update, writeFailure, getFailures, query)
  - Confirm no imports from the application use-case layer or CLI layer
  - _Requirements: 2.1, 2.5, 3.1, 4.1, 4.2, 5.1, 5.6, 6.3, 6.5, 7.1, 7.5_

- [x] 2. (P) Implement in-process short-term memory store
  - Implement the class in the infrastructure memory directory, satisfying the `ShortTermMemoryPort` interface
  - Initialize state to an empty value (no spec, no phase, no task progress, empty recent-files list) on construction
  - Implement write with partial-merge semantics: replace only the provided keys, leave others unchanged
  - Implement clear to reset all fields to the empty initial value
  - All methods must be synchronous with no file I/O
  - Verify that two separate instances do not share state
  - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [ ] 3. Implement the file-based memory store
- [x] 3.1 Build path resolution, directory initialization, and Markdown entry formatting
  - Implement the class constructor accepting an optional base directory (defaulting to `process.cwd()`) and initialize the composed short-term store instance
  - Map each project memory file name to its path under `.memory/` and each knowledge memory file name to its path under `rules/`, both resolved from base directory
  - Implement directory creation with recursive flag so neither `.memory/` nor `rules/` need to exist in advance
  - Define the internal Markdown formatting for a single entry: level-2 heading as title, date and context as bold list items, description as body paragraph, with `---` separating entries
  - Implement the internal parser that splits file content on level-2 headings into structured entry objects
  - Return an empty entry list (not an error) when a file is missing
  - _Requirements: 2.1, 2.5, 2.6, 3.1, 6.3, 7.2, 7.4_

- [x] 3.2 Implement append with entry validation, deduplication, and atomic write
  - Validate that the incoming entry title is non-empty before any I/O; return `invalid_entry` error immediately if blank
  - Read the target file (or treat missing file as empty) and parse existing entries
  - Perform case-insensitive title comparison against all existing entries; return `skipped_duplicate` result without writing if a match is found
  - Format the new entry using the Markdown template from 3.1 and append it to the file content
  - Write the updated content to a `.tmp` sibling file using a file descriptor with `datasync`, then rename atomically to the target path
  - Ensure `mkdir({ recursive: true })` is called before the temp-file write so the parent directory always exists
  - Return `appended` on success
  - _Requirements: 2.2, 2.3, 2.4, 3.2, 3.3, 3.4, 6.1, 6.2, 6.4_

- [x] 3.3 Implement in-place entry update for the self-healing rule path
  - Parse the full target file into its entry list using the parser from 3.1
  - Find the entry whose title matches the provided title (case-insensitive); return `not_found` error if absent
  - Replace the matched entry with the new entry content, preserving all other entries and their order
  - Serialize the updated entry list back to Markdown content and write it atomically (same temp-file + rename pattern as 3.2)
  - Restrict this operation to knowledge memory targets only (per design constraint)
  - _Requirements: 3.5, 6.5_

- [x] 3.4 Implement failure record persistence and filtered retrieval
  - Build the failure file path from base directory, `.memory/failures/` subdirectory, and a filename combining ISO timestamp and task ID
  - Ensure the failures subdirectory is created before writing using `mkdir({ recursive: true })`
  - Write the failure record as formatted JSON to a temp file and rename atomically
  - If a filesystem error occurs during write, log the error to stderr and return a failure result without throwing — the workflow must not crash
  - Implement `getFailures`: read the `.memory/failures/` directory; if absent, return an empty list; otherwise parse each JSON file into a failure record
  - Apply spec name and task ID filters in-memory after loading all records
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [x] 3.5 Implement keyword-based query with relevance scoring and type filtering
  - Determine which memory files to scan based on the optional `memoryTypes` filter (project files, knowledge files, or both when omitted)
  - Read each applicable file; treat missing files as empty without error
  - Parse all files into their constituent entry lists using the shared parser from 3.1
  - Tokenize the query text and compute a relevance score per entry: count of query token occurrences in title plus body, normalized to a 0.0–1.0 range across all candidates
  - Sort entries by score descending and return up to `topN` results (default 5) each annotated with the source file name and relevance score
  - Return an empty list (not an error) when no entries match
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

- [ ] 4. Wire memory system into the orchestrator
- [x] 4.1 (P) Add memory port to the workflow use case and manage short-term lifecycle
  - Extend the `RunSpecUseCase` dependency injection object with a `memory` field of type `MemoryPort`
  - At the start of each non-dry-run workflow execution, call `memory.shortTerm.clear()` to reset any leftover state from a prior in-process run before the workflow begins
  - Verify that the existing dry-run early-return path already prevents all memory write calls from being reached — no new guard code is needed
  - _Requirements: 1.4, 6.6, 7.3_

- [x] 4.2 Wire memory implementations into the CLI entry point
  - Depends on 4.1: `RunSpecUseCase.deps` must include the `memory` field before this wiring can compile
  - Construct a `FileMemoryStore` instance in the CLI wiring with base directory derived from the runtime working directory
  - Pass the instance as the `memory` dependency when constructing `RunSpecUseCase`
  - Confirm the flow: CLI constructs store → store constructs its own short-term instance → both reach the use case through the single `MemoryPort` injection point
  - _Requirements: 7.2, 7.3, 7.4_

- [ ] 5. Unit tests for memory components
- [x] 5.1 (P) Unit tests for the in-process short-term store
  - Test that read immediately after construction returns the empty initial state
  - Test that write with a partial object merges only the provided keys, leaving others at their previous values
  - Test that clear resets all fields to the empty initial state regardless of previous writes
  - Test that two separate instances are fully isolated (writing to one does not affect the other)
  - _Requirements: 1.1, 1.2, 1.3_

- [x] 5.2 (P) Unit tests for the file-based memory store
  - Use a temporary directory as base dir for all tests to avoid touching real project files
  - Test append: new entry is written; subsequent append with the same title (different case) returns `skipped_duplicate` without modifying the file; missing directory is created automatically
  - Test append validation: blank title returns `invalid_entry` before any I/O
  - Test atomic write: temp file is replaced by the final file; file content is valid after a write
  - Test update: entry content is replaced in-place; non-existent title returns `not_found`; other entries remain unchanged
  - Test writeFailure: JSON file appears at the expected path; IO error during write returns failure result without throwing
  - Test getFailures: records are returned for matching specName and taskId filters; missing directory returns empty list
  - Test query: returns empty list when all files are absent; keyword match returns ranked results with correct metadata; topN limit is respected; type filter restricts scanned files to the requested layer
  - _Requirements: 2.6, 3.4, 3.5, 4.4, 5.2, 5.6, 5.7, 6.2, 6.4_

- [ ] 6. Integration tests for memory lifecycle
- [x] 6.1 (P) Integration test for end-to-end memory operations with a real temp directory
  - Execute the full append → query → retrieve cycle: append an entry, query with a matching keyword, confirm the result contains the entry with a non-zero relevance score and correct source file
  - Simulate a restart by constructing a new `FileMemoryStore` instance against the same temp directory and confirm that previously appended entries and failure records are still retrievable
  - Test the update → query cycle: update an entry's description, query again, confirm the updated content is returned and no duplicate entry exists
  - Test that a `getFailures` call after `writeFailure` returns the written record with correct field values and passes the specName filter
  - _Requirements: 2.1, 4.3, 4.5, 5.1, 6.4_

- [x] 6.2 (P) Integration test for RunSpecUseCase with MemoryPort injected
  - Construct a `RunSpecUseCase` with a real `FileMemoryStore` pointing to a temp directory
  - Execute a dry-run: confirm no files are written to the temp directory after the run completes
  - Verify that short-term memory is cleared at the start of each run by checking that state from a previous run does not appear in a subsequent run's initial read
  - _Requirements: 1.4, 6.6, 7.3_
