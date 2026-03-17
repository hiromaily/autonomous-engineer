---
name: triage-workflow
description: Evaluate a request and recommend the appropriate workflow — GitHub issue only, GitHub issue + SDD spec, or full SDD spec — based on scope, complexity, and architectural impact.
---

# Workflow Triage

Analyze a request and determine whether it warrants a **GitHub issue only** or a **full Spec-Driven Development (SDD) workflow** (with or without a preceding issue).

## When to Use

Invoke this skill before starting any significant piece of work to select the right process and avoid over- or under-engineering the workflow.

```
/triage-workflow "<description of the request>"
```

---

## Scoring Rubric

Evaluate the request on **five dimensions**. Score each 1–3.

| Dimension | 1 — Low | 2 — Medium | 3 — High |
|-----------|---------|------------|----------|
| **Scope** | Single file or function | Multiple files, one subsystem | Cross-layer or multiple subsystems |
| **Complexity** | Solution path is obvious | Some design decisions required | Requires architectural design or research |
| **Architectural impact** | No interface/layer changes | New interface or minor restructure | Changes contracts, layer boundaries, or data models |
| **Risk** | Isolated, easily reversible | Moderate risk to adjacent code | Could break existing features or APIs |
| **Ambiguity** | Requirements are clear | Some clarification needed | Requirements are incomplete or contested |

**Total score range: 5–15**

---

## Decision Table

| Total Score | Recommendation |
|-------------|----------------|
| 5–7 | **GitHub Issue only** — implement directly |
| 8–11 | **GitHub Issue + SDD Spec** — create an issue to track, then run the spec workflow |
| 12–15 | **Full SDD Spec** — spec-driven design first; issue is created as part of spec output |

---

## Execution Steps

### Step 1 — Read the request

If `$ARGUMENTS` is provided, use that as the request description. Otherwise, ask the user to describe the request in 1–3 sentences.

### Step 2 — Score each dimension

Think through each of the five dimensions carefully. Write a 1-sentence rationale for each score. Sum the scores.

### Step 3 — Output the recommendation

Follow the format below. Always include:
- The score breakdown table
- The recommendation label
- Concrete next steps (commands or actions)

### Step 4 — Offer to proceed

Ask the user: "Shall I proceed with the recommended workflow?" If yes, execute the first step of that workflow automatically.

---

## Output Format

```markdown
## Workflow Triage

**Request**: {brief restatement of the request}

### Dimension Scores

| Dimension | Score | Rationale |
|-----------|-------|-----------|
| Scope | {1–3} | {one sentence} |
| Complexity | {1–3} | {one sentence} |
| Architectural impact | {1–3} | {one sentence} |
| Risk | {1–3} | {one sentence} |
| Ambiguity | {1–3} | {one sentence} |
| **Total** | **{5–15}** | |

### Recommendation: {GitHub Issue only | GitHub Issue + SDD Spec | Full SDD Spec}

{2–3 sentence explanation of why this workflow fits.}

### Next Steps

{Bullet list of concrete actions, e.g.:}
- Create GitHub issue: `gh issue create --title "..." --body "..."`
- Run spec init: `/kiro:spec-init "<description>"`
- Or: implement directly with a feature branch and PR
```

---

## Examples

### Example A — Minor fix (score 5–7)

> "Fix the typo in the error message when config file is missing"

- Scope: 1 (single string in one file)
- Complexity: 1 (trivial change)
- Architectural impact: 1 (none)
- Risk: 1 (no logic change)
- Ambiguity: 1 (clear)
- **Total: 5 → GitHub Issue only**

### Example B — Medium feature (score 8–11)

> "Add a `--dry-run` flag to the CLI that skips side effects but logs what would happen"

- Scope: 2 (CLI parsing + service layer)
- Complexity: 2 (needs consistent propagation through services)
- Architectural impact: 2 (new port parameter or flag threading)
- Risk: 2 (touches execution path)
- Ambiguity: 2 (behaviour in edge cases needs definition)
- **Total: 10 → GitHub Issue + SDD Spec**

### Example C — Major redesign (score 12–15)

> "Redesign the memory system to support multiple backends with a pluggable adapter interface"

- Scope: 3 (domain + application + infra + tests)
- Complexity: 3 (multiple design options, trade-offs to evaluate)
- Architectural impact: 3 (new port interface, adapter contracts)
- Risk: 3 (existing memory behaviour must be preserved)
- Ambiguity: 2 (goal is clear, implementation path is not)
- **Total: 14 → Full SDD Spec**

---

## Design Principles

- **Bias toward lightweight**: When on the boundary, prefer the lighter-weight workflow.
- **One recommendation**: Output a single clear recommendation, not a range.
- **Action-oriented**: Always end with runnable commands or instructions.
- **No over-engineering**: A GitHub issue is a valid and often correct answer.
