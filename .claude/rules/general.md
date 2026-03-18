# General AI Agent Behavior Rules

## Skill Usage

Always check `.claude/skills/` for relevant skills before starting any task. Skills encode proven workflows and must be preferred over ad-hoc approaches.

### Available Skills

| Skill | Invocation | When to Use |
|-------|-----------|-------------|
| `dev-pipeline` | `/dev-pipeline "<description>"` | Features, fixes, or refactors spanning multiple files or subsystems. Default choice for non-trivial implementation work. |
| `triage-workflow` | `/triage-workflow "<description>"` | Before starting work — determines the right process (GitHub issue, SDD spec, or full pipeline). |
| `ai-friendly-audit` | `/ai-friendly-audit` | Quick AI-readiness check; use before deep work on unfamiliar areas or after major structural changes. |

### dev-pipeline is the Default for Implementation

Use `/dev-pipeline` for any task that:
- Touches more than one file or subsystem
- Requires design decisions
- Could break existing behaviour

The pipeline isolates each phase in a subagent, prevents context accumulation, and enforces human checkpoints at Design and Task Decomposition.

---

## Workflow Selection

When starting significant work, use `/triage-workflow` to score the request and select the right process:

| Score | Recommendation |
|-------|----------------|
| 5–7 | GitHub issue only → implement directly on a feature branch |
| 8–11 | GitHub issue + SDD spec (`/kiro:spec-*` commands) |
| 12–15 | Full SDD spec → issue is created as part of spec output |

Bias toward the lighter-weight workflow when on a boundary.

---

## Branch and Commit Discipline

- **Never commit directly to `main`.** Always use a feature branch and open a PR for review.
- Use descriptive branch names with standard prefixes: `feature/`, `fix/`, `refactor/`.
- Keep commits focused — one logical change per commit.
- Before committing, run: `cd orchestrator-ts && bun run typecheck && bun test`

---

## Spec-Driven Development (SDD)

For work that scores 8+ in triage, follow the three-phase approval workflow:

1. `/kiro:spec-requirements {feature}` → human review
2. `/kiro:spec-design {feature}` → human review (optionally `/kiro:validate-design`)
3. `/kiro:spec-tasks {feature}` → human review
4. `/kiro:spec-impl {feature}` → implementation

Check progress at any time with `/kiro:spec-status {feature}`.

---

## Related Rules

- `@.claude/rules/architecture.md` — Clean Architecture layer boundaries and import restrictions
- `@.claude/rules/typescript.md` — TypeScript/Bun coding conventions and verification commands
- `@.claude/rules/di.md` — Dependency injection patterns for `orchestrator-ts`
- `@.claude/rules/docs.md` — Bilingual documentation rules and VitePress navigation
