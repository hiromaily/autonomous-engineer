# cc-sdd

[cc-sdd](https://github.com/gotalab/cc-sdd) is the initial SDD framework integrated into Autonomous Engineer.

It provides a CLI-driven spec workflow that generates structured artifacts (requirements, design, tasks) before implementation begins.

---

## Phase Structure

cc-sdd follows seven sequential phases:

```
SPEC_INIT
    ↓
REQUIREMENTS
    ↓
DESIGN
    ↓
VALIDATE_DESIGN  (optional)
    ↓
TASK_GENERATION
    ↓
IMPLEMENTATION
    ↓
PULL_REQUEST
```

---

## Commands

| Command | Phase | Description |
|---|---|---|
| `spec-init "description"` | Init | Create spec directory and initial metadata |
| `spec-requirements <feature>` | Requirements | Generate `requirements.md` |
| `validate-gap <feature>` | Optional | Check requirements against existing codebase |
| `spec-design <feature>` | Design | Generate `design.md` |
| `validate-design <feature>` | Optional | Validate design quality and consistency |
| `spec-tasks <feature>` | Tasks | Generate `tasks.md` |
| `spec-impl <feature> [task-ids]` | Implementation | Execute implementation loop |
| `validate-impl <feature>` | Optional | Validate implementation against requirements |
| `spec-status <feature>` | Any | Show current phase and task progress |

---

## Artifacts

All artifacts are stored under `.kiro/specs/<feature-name>/`.

| Artifact | Phase | Description |
|---|---|---|
| `spec.json` | Init | Spec metadata (name, language, created date) |
| `requirements.md` | Requirements | EARS-format requirements with checkboxes |
| `design.md` | Design | Technical architecture, data models, diagrams |
| `validation-report.md` | Validate Design (optional) | Design review pass/fail report |
| `tasks.md` | Tasks | Ordered implementation tasks with acceptance criteria |

---

## Human Review Gates

cc-sdd enforces review gates at three points:

| Gate | After Phase | Action Required |
|---|---|---|
| Requirements approval | Requirements | Review `requirements.md`, confirm scope |
| Design approval | Design | Review `design.md`, confirm architecture |
| Task list approval | Tasks | Review `tasks.md`, confirm implementation plan |

Gates can be bypassed with `-y` for fast-track execution, but human review is the recommended default.

---

## Requirements Format

Requirements are written in EARS (Easy Approach to Requirements Syntax) format with checkboxes:

```markdown
- [ ] The system shall...
- [ ] When X occurs, the system shall...
```

---

## Task Format

Tasks include a title, description, dependencies, and acceptance criteria linked to requirements:

```markdown
## Task 1: Implement Tool Interface

**Dependencies**: none

Implement the `Tool<Input, Output>` interface and `ToolContext` type.

**Acceptance criteria**:
- [ ] Tool interface is defined with correct generics
- [ ] ToolContext includes workspaceRoot, permissions, memory, logger
- [ ] Unit tests cover interface contract
```

---

## Parallel Task Analysis

Tasks in `tasks.md` may be marked with `(P)` to indicate they are safe to execute in parallel (or batched into a single `spec-impl` call).

### When to Mark a Task (P)

Only mark a task as parallel-capable when **all** of the following are true:

1. **No data dependency** on pending tasks.
2. **No conflicting files or shared mutable resources** are touched.
3. **No prerequisite review/approval** from another task is required beforehand.
4. **Environment/setup work** needed by this task is already satisfied or covered within the task itself.

### Marking Convention

- Append `(P)` immediately after the numeric identifier: `- [ ] 2.1 (P) Build background worker for emails`
- Apply `(P)` to both major tasks and sub-tasks when appropriate.
- Skip marking container-only major tasks (those without their own actionable detail bullets) — evaluate at the sub-task level instead.

### Grouping Guidelines

- Group parallel tasks under the same parent whenever the work belongs to the same theme.
- When two tasks look similar but are not parallel-safe, call out the blocking dependency explicitly.

### Quality Checklist

Before marking a task with `(P)`, verify:

- Running this task concurrently will not create merge or deployment conflicts.
- Shared state expectations are captured in the detail bullets.
- The implementation can be tested independently.

If any check fails, do not mark with `(P)` and explain the dependency in the task details.

> Source: [tasks-parallel-analysis.md](https://github.com/gotalab/cc-sdd/blob/main/tools/cc-sdd/templates/shared/settings/rules/tasks-parallel-analysis.md)

---

## Configuration

cc-sdd stores spec metadata in `spec.json` at the root of each spec directory:

```json
{
  "name": "feature-name",
  "language": "en",
  "created": "2026-03-10"
}
```

The `language` field controls the language used for generated artifact content.
