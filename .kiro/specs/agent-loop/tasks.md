# Implementation Plan

- [ ] 1. Domain layer types
- [x] 1.1 Define action planning and reflection value types
  - Define the action category union representing the four kinds of actions the agent can take: Exploration, Modification, Validation, and Documentation
  - Define the action plan type that captures what action the agent intends to take — which category, which tool, what inputs to pass, and the LLM's reasoning rationale
  - Define the reflection output type that captures how the agent evaluated the last action — the assessment result, new learnings, whether the plan should continue or be revised, and whether the task is complete or human intervention is needed
  - Define the supporting union types for assessment results (`expected / unexpected / failure`), plan adjustments (`continue / revise / stop`), and loop step names (`PLAN / ACT / OBSERVE / REFLECT / UPDATE_STATE`)
  - All types must be plain serializable records — no class instances, functions, or Symbols; all fields immutable
  - _Requirements: 2.2, 2.3, 2.5, 5.2, 5.3_

- [x] 1.2 Define agent state and observation types
  - Define the termination condition union for all five ways the loop can end: task completed, max iterations reached, human intervention required, safety stop, and recovery exhausted
  - Define the observation type that records a single tool invocation — tool identity, inputs given, raw output received (typed as unknown to be agnostic to content), whether it succeeded or failed (with the structured error if failed), when it was recorded, and optionally the reflection metadata added after evaluation
  - Define the agent state type as the root aggregate for a single loop execution, holding the task description, current plan steps, completed steps, active step, iteration count, all observations accumulated so far, and recovery attempt count — all fields immutable; the state is replaced rather than mutated after each step
  - The agent state must be serializable to JSON so that external consumers can persist and restore it; the loop itself does not persist state
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 4.1, 6.1, 6.2, 6.3, 6.4, 7.2, 7.3, 7.4, 7.5, 8.4_

- [x] 1.3 Define the agent loop event discriminated union
  - Define the event union covering all observable points in the loop lifecycle: iteration start, iteration complete, step start, step complete, recovery attempt, and termination
  - Each event variant must carry the minimal contextual fields needed for downstream analysis — iteration number, step identity, duration in milliseconds, reflection assessment, termination condition, and final state as appropriate per variant
  - All event fields must be immutable; the union discriminates on the `type` field to allow exhaustive narrowing by consumers
  - _Requirements: 9.1, 9.2, 9.3, 7.2, 8.4_

- [ ] 2. Application ports
- [x] 2.1 Define the primary service contract
  - Define the options type that callers use to configure a loop run — maximum iterations (default 50), maximum recovery attempts (default 3), maximum plan parse retries (default 2), an optional context provider for spec6 delegation, an optional event bus for observability, an optional logger, and an optional safety-stop callback
  - Define the result type that the loop returns on every termination path — the specific termination condition, the final agent state, the total iteration count consumed, and a boolean indicating whether the task was completed successfully
  - Define the public loop interface with three methods: execute a task and return when done (never throws), signal a graceful stop from outside, and query the current state snapshot without interrupting execution
  - _Requirements: 7.1, 7.2, 7.3, 7.6, 9.4, 11.1, 11.2, 11.3, 11.4_

- [x] 2.2 Define integration and observability port interfaces
  - Define the optional context provider interface that the loop delegates to when spec6 is available — given the current state and available tool schemas, assemble the LLM prompt context for the PLAN step
  - Define the event bus interface for emitting and subscribing to agent loop events — matching the emit/on/off shape used by the existing workflow event bus
  - Define the logger interface for injecting structured logging — info and error methods accepting a message and optional metadata record
  - _Requirements: 11.5, 9.1, 9.2, 9.3_

- [ ] 3. AgentLoopService foundation
- [x] 3.1 Establish class structure and dependency injection
  - Create the agent loop service class implementing the public loop interface, accepting the tool executor, tool registry, LLM provider, and tool context via constructor injection — all required at construction time; optional ports come in through the run call
  - Declare a private stop-requested flag as the only mutable class-level state, and a private current-state field for answering status queries during execution
  - Define a private defaults constant inside the service that fills in iteration limits and retry counts when the caller omits them; merge caller-supplied options with defaults at the start of each run
  - Enforce the dependency boundary: the service must not import tool implementations directly or any LLM provider SDK — all tool calls go through the executor interface and all LLM calls go through the provider port
  - _Requirements: 10.1, 10.2, 11.1, 11.6_

- [x] 3.2 Implement public interface and state initialization
  - Implement the stop signal method so external callers (e.g., orchestrator-core phase transitions) can request graceful termination; the loop will complete the in-progress sub-step before halting
  - Implement the state query method to return a consistent snapshot of the current agent state (iteration count, active step, completed step count) without blocking ongoing execution; return null when no run is active
  - Implement a private state initialization helper that produces a fresh agent state for a new task — empty plan, no completed steps, no observations, zero counts, and a start timestamp
  - Implement the outer run loop skeleton: initialize state, retrieve all available tool schemas from the tool registry once at startup, enter the iteration loop, and return a complete result on every termination path — the run method must never throw
  - _Requirements: 1.2, 1.3, 7.6, 10.3, 11.1, 11.2, 11.3_

- [ ] 4. PLAN and ACT steps
- [x] 4.1 Implement the PLAN step
  - When the context provider is available, delegate context assembly for the PLAN prompt to it; otherwise fall back to an inline builder that uses a sliding window of the most recent observations bounded by a fixed token budget
  - Send the assembled context to the LLM and parse the response into a structured action plan — verify the action category is one of the four supported values and the tool name is present
  - On a parse failure, retry the LLM call with a clarification prompt up to the configured maximum; if all retries are exhausted without a valid plan, halt the loop with the human-intervention-required termination condition
  - Preserve the reasoning rationale from the parsed plan for use in REFLECT step prompts and observability logs
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 4.4, 11.5, 11.6_

- [x] 4.2 Implement the ACT step
  - Execute the action from the plan by invoking the tool executor with the planned tool name and input parameters — all tool calls must be routed through the executor so that permission checks, schema validation, and timeout enforcement are applied
  - On a successful tool result, capture the raw output and construct a partial observation (without reflection metadata yet) indicating success
  - On a failed tool result, capture the structured error — its type (validation, runtime, or permission), message, and context — and construct a partial observation indicating failure; permission errors must bypass the recovery sub-loop and immediately trigger human-intervention-required termination
  - Treat tool timeouts as runtime errors; the executor's configured timeout mechanism enforces this limit
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 10.4, 10.5_

- [ ] 5. OBSERVE, REFLECT, and UPDATE STATE steps
- [x] 5.1 Implement the OBSERVE step
  - Assemble a complete observation from the tool result, adding the tool identity, inputs, raw output or error, success flag, and a timestamp for when the result was recorded
  - Produce a new agent state with the observation appended to the accumulated list — never mutate the existing state; all updates produce a replacement state object
  - The observation content type is intentionally generic: file contents, command output, test results, error messages, git diff output, and code analysis results all flow through as raw output typed as unknown
  - _Requirements: 4.1, 4.2, 4.3_

- [x] 5.2 Implement the REFLECT step
  - Build a reflection prompt that combines the current state, the latest observation, and the rationale from the action plan, then send it to the LLM and parse the response into a structured reflection containing the assessment, new learnings, and plan adjustment recommendation
  - When the LLM response cannot be parsed, treat it as a failure assessment rather than crashing — this routes into the error recovery sub-loop
  - When the assessment is unexpected or the plan needs revision, the reflection carries a revised plan to replace the current one
  - Embed the parsed reflection into the latest observation in the agent state, so it becomes part of the permanent record of that iteration
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [x] 5.3 Implement the UPDATE STATE step
  - When the reflection assessment is non-failure (expected or unexpected), move the active step into completed steps and advance the active step pointer to the next pending step
  - When the reflection recommends a plan revision, replace the plan with the revised version and set the active step to the first incomplete step in the new plan
  - Increment the iteration counter after every complete PLAN→ACT→OBSERVE→REFLECT→UPDATE cycle, regardless of whether the assessment was expected, unexpected, or a failure leading to recovery
  - _Requirements: 6.1, 6.2, 6.3, 6.4_

- [ ] 6. Iteration control and stopping conditions
- [x] 6.1 Implement stop-flag check and maxIterations enforcement
  - At the start of every iteration — before entering the PLAN step — check whether a stop was requested externally or whether the iteration count has reached the configured maximum; halt before the next LLM call if either condition is true
  - When the maximum is reached, log a progress summary (completed steps, tools invoked, pending plan steps) and set the termination condition to max-iterations-reached
  - When the reflection indicates task completion (stop adjustment with task-complete flag), set the termination condition to task-completed
  - When the reflection indicates human clarification is needed, pause execution and set the termination condition to human-intervention-required
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.6_

- [x] 6.2 Implement termination event emission and result assembly
  - Emit a termination event for every exit path, carrying the specific condition and the final agent state — callers and event bus subscribers must see every possible termination, including task-completed, max-iterations-reached, human-intervention-required, safety-stop, and recovery-exhausted
  - Register the safety-stop callback supplied in options so the agent-safety layer can trigger an emergency halt; when invoked, set the stop flag and emit the safety-stop termination event after the current sub-step completes
  - On termination, emit a final summary log entry through the logger containing total iterations, steps completed, tools invoked by category, errors encountered, and the terminal condition
  - Assemble and return the loop result as the sole exit from the run method — every termination path must produce the result rather than throw
  - _Requirements: 7.2, 7.3, 7.4, 7.5, 9.2, 9.5_

- [ ] 7. Error recovery sub-loop
- [x] 7.1 Implement the recovery orchestration cycle
  - When the REFLECT step produces a failure assessment, enter the error recovery sub-loop: emit a recovery-attempt event, send an error-analysis plan prompt to the LLM, execute the resulting fix action through the tool executor, then re-run the validation action (test, build, or lint) to confirm the fix worked
  - If the validation succeeds, exit the recovery sub-loop, reset the recovery attempt counter, and resume normal iteration from the step that originally failed
  - If the validation fails again, record the incremented attempt count and loop back to try the next recovery attempt
  - _Requirements: 8.1, 8.2, 8.3_

- [x] 7.2 Implement attempt tracking and escalation
  - Before each recovery attempt, verify the attempt count is within the configured limit; if the limit is reached, emit the recovery-exhausted termination event, record the failure context in the agent state, and return the human-intervention-required terminal condition
  - Detect repeated failure patterns: if the same error (identified by tool name and error message) has already accumulated at or above the attempt limit across the task execution, escalate immediately rather than retrying further
  - Reset the attempt counter when a distinct new error is encountered so that isolated transient failures do not consume the budget for unrelated steps
  - _Requirements: 8.2, 8.4, 8.5_

- [ ] 8. Observability — event emission and structured logging
- [ ] 8.1 Integrate event bus for per-step and per-iteration events
  - At the start of each iteration, emit an iteration-start event carrying the iteration number, active step, and timestamp
  - At the start and end of each of the five sub-steps, emit step-start and step-complete events with the step name, iteration number, and elapsed time in milliseconds
  - At the end of each iteration, emit an iteration-complete event carrying the action category, tool invoked, total duration, and reflection assessment
  - When no event bus is configured, skip emission silently — the loop must continue normally without one
  - _Requirements: 9.1, 9.2, 9.3_

- [ ] 8.2 Implement structured logging and status query
  - At each sub-step boundary, log an info entry through the injected logger with the step name, iteration number, action type, tool name, result status, and execution time — redact tool input values that exceed a byte limit to avoid logging sensitive data
  - Ensure the state query method returns the current snapshot (iteration count, active step, completed step count) without blocking or delaying the iteration in progress
  - On any error path, log an error entry with the error category, message, and recovery context
  - _Requirements: 9.1, 9.3, 9.4, 9.5_

- [ ] 9. (P) Unit tests — domain types
- [ ] 9.1 Test agent state structure and initialization
  - Verify that a fresh agent state produced by the initialization logic has empty plan, completed steps, and observations arrays, iteration count of zero, recovery attempts of zero, and a valid ISO timestamp
  - Verify that an observation with a failure carries the structured error and has its success flag set to false
  - Verify that an agent state with observations can be serialized to JSON and parsed back without data loss when the raw output is a string value
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [ ] 9.2 Test agent loop event union and termination conditions
  - Verify that each event variant can be narrowed by its type discriminant in an exhaustive switch with no default branch needed
  - Verify that all five termination condition values are present in the union and can be exhaustively checked
  - _Requirements: 9.2, 7.2_

- [ ] 10. (P) Unit tests — AgentLoopService
- [ ] 10.1 Test PLAN step — parse success and retry behavior
  - Mock the LLM to return valid action plan JSON on the first call; verify the service extracts a correctly structured plan with all required fields and proceeds to the ACT step
  - Mock the LLM to return invalid JSON twice then valid JSON; verify the service retries and succeeds on the last allowed attempt
  - Mock the LLM to always return invalid JSON beyond the retry limit; verify the loop exits with the human-intervention-required termination condition
  - _Requirements: 2.1, 2.2, 2.4, 2.5_

- [ ] 10.2 Test ACT step — success and failure paths
  - Mock the tool executor to succeed; verify the resulting observation records success and captures the raw output
  - Mock the tool executor to return a runtime error; verify the observation records the failure and the loop enters error recovery
  - Mock the tool executor to return a permission error; verify the loop terminates immediately with human-intervention-required without entering recovery
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [ ] 10.3 Test REFLECT and UPDATE STATE — assessment branching and step promotion
  - Mock the LLM reflection response with task-complete status; verify the loop terminates with the task-completed condition and the success flag set to true
  - Mock the reflection response with an unexpected assessment and a revised plan; verify the agent state is updated with the new plan and the active step points to the first step of the revised plan
  - Verify the iteration counter increments after each complete cycle regardless of assessment outcome
  - _Requirements: 5.2, 5.3, 5.5, 6.1, 6.2, 6.3, 6.4_

- [ ] 10.4 Test stop signal and maxIterations termination
  - Call the stop method during an async tool execution; verify the loop completes the in-progress step and halts at the next PLAN boundary rather than mid-step
  - Configure a maximum of three iterations and mock tools and LLM to always succeed without completing the task; verify the loop exits with the max-iterations-reached condition after exactly three iterations
  - _Requirements: 7.1, 7.2, 7.6_

- [ ] 10.5 Test error recovery — resolution and exhaustion
  - Mock the tool to fail on the first call and succeed on the second within the recovery cycle; verify the loop resumes normal iteration after recovery and the attempt counter resets
  - Configure a maximum of three recovery attempts and mock the tool to always fail; verify the loop exits with the recovery-exhausted condition after exactly three attempts
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

- [ ] 11. Integration tests
- [ ] 11.1 Full PLAN→ACT→OBSERVE→REFLECT→UPDATE cycle with real registry
  - Instantiate the agent loop service with a real tool registry populated with a mock tool, a mock LLM provider, and a mock event bus; run a three-iteration task where the mock LLM returns valid plan and reflection responses
  - Verify the final agent state has three completed steps, an iteration count of three, and three observations accumulated
  - Verify the state query method returns the correct iteration number and active step when called between steps during asynchronous execution
  - _Requirements: 1.1, 1.2, 1.3, 4.1, 4.2, 5.1, 5.2, 6.1, 10.3_

- [ ] 11.2 Error recovery integration — full recovery cycle
  - Configure the mock tool executor to fail on the first call and succeed on the second; run a single-step task and verify the loop completes successfully with the task-completed condition and that exactly one recovery-attempt event was emitted
  - Configure the mock tool executor to always fail; verify the loop exits with the recovery-exhausted condition and the termination event carries a final state with a non-zero recovery attempt count
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 9.2_

- [ ] 11.3 Event bus ordering and AgentState serialization
  - Run a two-iteration task with a concrete event bus implementation; collect all emitted events and verify the correct sequence for both iterations — iteration-start, then five step-start/step-complete pairs in PLAN→ACT→OBSERVE→REFLECT→UPDATE order, then iteration-complete — followed by the final termination event
  - Take the final agent state from the loop result, serialize it to JSON, parse it back, and verify that all string fields, array contents, and numeric counts round-trip without data loss
  - _Requirements: 9.1, 9.2, 9.3, 1.4_
