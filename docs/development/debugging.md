# Debugging and Logging

## Overview

Autonomous Engineer produces structured logs at multiple levels to support debugging during development.
Three layers of logging cover workflow-level events, agent operation history, and the raw instruction/response history sent to the LLM.

---

## Log Layers

| Layer | What it captures | Where it goes |
|---|---|---|
| Workflow events | Phase transitions, approval gates, completion/failure | CLI stdout + optional `--log-json` file |
| Implementation loop | Section iterations, review cycles, escalations | `.aes/logs/implementation-loop-<planId>.ndjson` |
| Agent state | Full PLAN→ACT→OBSERVE→REFLECT→UPDATE trace | Embedded in implementation loop log entries |
| LLM call history | Messages sent to and received from the LLM | Captured by `ClaudeProvider`, surfaced in agent state |

---

## Workflow Event Log (`--log-json`)

To capture all workflow-level events as NDJSON:

```sh
aes run <spec-name> --log-json ./logs/run.ndjson
```

Each line is a JSON object with an `event` field identifying the event type.

**Event types:**

| Event | Description |
|---|---|
| `phase:start` | A workflow phase has begun |
| `phase:complete` | A workflow phase completed successfully |
| `phase:failed` | A workflow phase failed |
| `approval:required` | Workflow paused, waiting for human approval |
| `approval:granted` | Human approval received, workflow resumed |
| `workflow:complete` | Full workflow finished |
| `workflow:failed` | Workflow terminated with an error |

**Example output:**

```ndjson
{"event":"phase:start","phase":"REQUIREMENTS","specName":"tool-system","timestamp":"2026-03-15T05:00:00.000Z"}
{"event":"approval:required","phase":"REQUIREMENTS","artifactPath":".kiro/specs/tool-system/requirements.md","timestamp":"2026-03-15T05:01:23.000Z"}
{"event":"approval:granted","phase":"REQUIREMENTS","timestamp":"2026-03-15T05:01:45.000Z"}
{"event":"phase:complete","phase":"REQUIREMENTS","specName":"tool-system","timestamp":"2026-03-15T05:01:45.000Z"}
```

---

## Implementation Loop Log

During the IMPLEMENTATION phase, detailed logs are written automatically to:

```
.aes/logs/implementation-loop-<planId>.ndjson
```

This file captures each section's full execution history.

**Record types:**

| Type | Description |
|---|---|
| `iteration:start` | An agent loop iteration started for a section |
| `iteration:complete` | An iteration finished with result |
| `step:start` | A single PLAN/ACT/OBSERVE/REFLECT/UPDATE step started |
| `step:complete` | A step finished |
| `section:complete` | A task section passed review and was committed |
| `section:halted` | A section was escalated (retries exhausted) |
| `loop:halt` | The implementation loop was stopped early |

**Example iteration record:**

```json
{
  "type": "iteration:complete",
  "sectionId": "task-1.1",
  "iterationCount": 2,
  "durationMs": 4200,
  "result": "completed",
  "toolsUsed": ["read_file", "write_file", "run_test_suite"],
  "timestamp": "2026-03-15T05:10:00.000Z"
}
```

---

## Agent State and LLM History

Each agent loop iteration produces an `AgentState` object containing:

- `task` — the current task description
- `plan` — the current working plan
- `completedSteps` — array of completed step summaries
- `observations` — tool result observations from the current session
- `iterationCount` — number of iterations executed

The `finalState` is emitted in the `iteration:complete` log entry after each section completes or is halted, giving a full trace of what the agent did and why.

**LLM instruction history** is maintained by `ClaudeProvider` across all prompts within a phase. Each phase starts with a cleared history (`clearContext()` is called at phase boundaries). The history includes:

- system prompt (agent role, rules, coding standards, safety constraints)
- task description
- all PLAN prompts sent to Claude
- all Claude responses (planned actions, reflections)
- tool results fed back as user-turn messages

This full message history is visible in the agent state's observations and is logged per-iteration.

---

## Workflow State File

The workflow state is persisted to `.aes/state/<spec-name>.json` after each phase.
This file is used for crash recovery and can be inspected to see the current phase and history.

```sh
cat .aes/state/tool-system.json
```

**Structure:**

```json
{
  "specName": "tool-system",
  "currentPhase": "IMPLEMENTATION",
  "completedPhases": ["SPEC_INIT", "REQUIREMENTS", "DESIGN", "VALIDATE_DESIGN", "TASK_GENERATION"],
  "startedAt": "2026-03-15T05:00:00.000Z",
  "updatedAt": "2026-03-15T05:09:00.000Z"
}
```

---

## Memory Files

The agent accumulates knowledge in `.memory/`:

| File | Description |
|---|---|
| `.memory/project_rules.md` | Coding conventions and architectural decisions |
| `.memory/coding_patterns.md` | Recurring implementation approaches |
| `.memory/review_feedback.md` | Feedback from previous review cycles |
| `.memory/failure_records/` | Structured failure records from self-healing loop |

These files are human-readable and can be inspected or manually edited to correct agent behavior.

---

## Debugging Tips

### Run in dry-run mode first

```sh
aes run <spec-name> --dry-run
```

Validates configuration and spec artifacts without executing the workflow. Catches missing config or missing spec files before a full run.

### Capture full event log

```sh
aes run <spec-name> --log-json /tmp/debug-$(date +%s).ndjson
```

Then inspect with `jq`:

```sh
cat /tmp/debug-*.ndjson | jq 'select(.event == "phase:failed")'
```

### Inspect implementation loop log

```sh
ls .aes/logs/
cat .aes/logs/implementation-loop-<planId>.ndjson | jq 'select(.type == "section:halted")'
```

### Check workflow state after a crash

```sh
cat .aes/state/<spec-name>.json
```

Then resume:

```sh
aes run <spec-name> --resume
```

### Check agent memory

```sh
cat .memory/project_rules.md
cat .memory/failure_records/*.json
```

Self-healing failures are written here. If the agent is stuck in a loop, inspect these records first.

---

## Sensitive Data Redaction

Tool inputs longer than 256 characters are redacted in logs before being written.
This prevents large file contents or API responses from bloating log files and reduces the risk of leaking sensitive content.

Full tool inputs and outputs are available in the agent's in-memory `observations` array during a live run, but are not persisted to disk verbatim.
