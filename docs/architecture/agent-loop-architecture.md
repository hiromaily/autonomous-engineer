
# Agent Loop Architecture

## Overview

The Agent Loop is the core reasoning and execution cycle of the AI Dev Agent.

It defines how the agent:

- interprets tasks
- plans actions
- executes tools
- observes results
- updates its understanding
- continues progress toward completion

The loop runs continuously until the task is completed or the system reaches a stopping condition.

This architecture enables the agent to iteratively improve its work and adapt to new information.

---

## Core Loop

The AI Dev Agent operates using a structured reasoning loop.

```
PLAN
↓
ACT
↓
OBSERVE
↓
REFLECT
↓
UPDATE STATE
↓
REPEAT
```

Each step has a clearly defined responsibility.

---

## Step 1: Plan

In the planning phase, the agent determines the next action required to progress toward the task goal.

Inputs to planning include:

- task description
- current context
- repository state
- previous actions
- tool results
- retrieved memory

The agent may decide to:

- inspect code
- retrieve additional context
- modify files
- run tests
- update documentation
- commit changes

Example planning output:

```
Next action:
Read src/cache/UserCache.ts to understand the current cache implementation.
```

The output of this stage is an **Action Plan**.

---

## Step 2: Act

In the action phase, the agent executes the planned operation.

Actions are performed using the Tool System.

Examples:

- read_file
- write_file
- run_command
- git_diff
- search_code
- parse_ast

Example tool invocation:

```
tool: read_file
path: src/cache/UserCache.ts
```

The action produces a result that will be observed by the agent.

---

## Step 3: Observe

After executing a tool, the agent observes the result.

Examples of observations:

- file contents
- command output
- test results
- error messages
- git diff output

Example observation:

```
Cache implementation currently uses in-memory Map.
No TTL mechanism exists.
```

Observations are added to the context for the next reasoning step.

---

## Step 4: Reflect

Reflection allows the agent to evaluate the result of its previous action.

The agent may consider:

- Did the action produce the expected result?
- What new information was learned?
- Does the plan need adjustment?

Example reflection:

```
The current cache implementation lacks expiration logic.
The next step should be to introduce TTL support.
```

Reflection helps the agent adapt its strategy.

---

## Step 5: Update State

The agent updates its internal state.

This may include:

- updating task progress
- recording memory
- updating the working plan
- storing important discoveries

Example state update:

```
Task progress:

* analyzed current cache implementation
* next: design TTL support
```

State updates ensure continuity across iterations.

---

## Loop Continuation

After updating state, the loop repeats.

```
PLAN → ACT → OBSERVE → REFLECT → UPDATE
```

The loop continues until:

- the task is completed
- a stopping condition is reached
- human intervention is required

---

## Agent State

The agent maintains a persistent state across iterations.

Example structure:

```ts
type AgentState = {
  task: string
  plan: string[]
  completedSteps: string[]
  currentStep: string | null
  observations: Observation[]
}
```

The state allows the agent to track its progress.

---

## Iteration Limits

To prevent infinite loops, the system may enforce iteration limits.

Example configuration:

```
maxIterations: 50
```

If the limit is reached, the agent may:

* request human input
* summarize progress
* propose next steps

---

## Action Types

Agent actions generally fall into several categories.

### Exploration

The agent gathers information about the codebase.

Examples:

* read files
* search symbols
* inspect dependencies

### Modification

The agent changes the repository.

Examples:

* edit files
* create new modules
* update configuration

### Validation

The agent verifies correctness.

Examples:

* run tests
* build project
* lint code

### Documentation

The agent updates project documentation.

Examples:

* update README
* add design notes
* write comments

---

## Multi-Step Planning

Some tasks require multiple steps.

Example plan:

```
1. Analyze current cache implementation
2. Design TTL mechanism
3. Modify cache module
4. Update tests
5. Run test suite
6. Commit changes
```

The agent may update this plan dynamically as new information is discovered.

---

## Error Recovery

Errors are expected during autonomous development.

Examples include:

* failing tests
* compilation errors
* runtime exceptions

When errors occur, the agent should:

1. analyze the error
2. identify the root cause
3. attempt a fix
4. re-run validation

Example recovery loop:

```
run_tests
↓
test_failure
↓
inspect_error
↓
modify_code
↓
run_tests
```

---

## Stopping Conditions

The loop terminates when one of the following conditions is met.

### Task Completed

All required changes have been implemented and validated.

Example criteria:

* tests pass
* feature implemented
* documentation updated

### Human Intervention

The agent requires clarification or approval.

Example:

```
Ambiguous requirement detected.
Please clarify expected behavior.
```

### Safety Limits

The system stops due to safety constraints.

Examples:

* too many iterations
* repeated failures
* permission violations

---

## Integration with Context Engineering

The Agent Loop depends heavily on the Context Engineering system.

Before each planning step, the system constructs a new context containing:

* task description
* relevant code
* tool results
* retrieved memory
* repository state

This ensures that the agent always reasons with the most relevant information.

---

## Observability

Each iteration of the loop should be logged.

Example log fields:

* iteration number
* action taken
* tools invoked
* execution time
* result status

These logs allow developers to analyze agent behavior.

---

## Example Execution Trace

Example agent execution:

```
Iteration 1
Plan: Inspect UserService
Action: read_file(UserService.ts)

Iteration 2
Plan: Inspect cache usage
Action: search_code("cache")

Iteration 3
Plan: Modify cache implementation
Action: write_file(CacheClient.ts)

Iteration 4
Plan: Validate implementation
Action: run_tests

Iteration 5
Plan: Commit changes
Action: git_commit
```

This iterative process allows the agent to gradually complete complex tasks.

---

## Future Extensions

The Agent Loop may evolve to support additional capabilities.

Possible extensions include:

* hierarchical planning
* parallel tool execution
* multi-agent collaboration
* learning from past tasks

These features can improve efficiency and scalability.

---

## Summary

The Agent Loop defines the reasoning and execution cycle of the AI Dev Agent.

The loop consists of five stages:

* Plan
* Act
* Observe
* Reflect
* Update State

By iteratively executing this loop, the agent can analyze code, modify systems, and validate results until the task is completed.

This architecture forms the cognitive core of the autonomous engineering system.
