# OpenSpec

[OpenSpec](https://github.com/Fission-AI/OpenSpec) is an SDD framework for AI coding assistants, published as the npm package `@fission-ai/openspec`.

Unlike rigid phase-gate frameworks, OpenSpec treats the spec workflow as **fluid actions** — artifacts can be created, skipped, or updated at any time, with dependencies as enablers rather than locks.

---

## Installation

```bash
npm install -g @fission-ai/openspec@latest
openspec init [path] [--tools <list|all|none>] [--profile core|custom]
```

`openspec init` generates AI tool integration files for 20+ tools (Claude Code, Cursor, Copilot, Windsurf, etc.) under their respective config directories.

---

## Workflow Profiles

OpenSpec provides two workflow tiers:

### Core Profile (default)

Three steps for fast use:

```
/opsx:propose  →  /opsx:apply  →  /opsx:archive
```

### Expanded Profile (opt-in)

Step-by-step control with explicit scaffold and artifact commands:

```
/opsx:new  →  /opsx:ff (or /opsx:continue)  →  /opsx:apply  →  /opsx:verify  →  /opsx:archive
```

Switch profiles with:

```bash
openspec config profile
```

---

## Phase Structure

The underlying phases in OpenSpec's `spec-driven` schema:

```
EXPLORE          (optional pre-work, no artifacts created)
    ↓
SCAFFOLD         (create change folder and .openspec.yaml)
    ↓
ARTIFACTS        (proposal → specs → design → tasks, dependency-ordered)
    ↓
IMPLEMENT        (work through tasks.md checklist)
    ↓
VERIFY           (optional post-implementation validation)
    ↓
SYNC             (optional: merge delta specs into main specs)
    ↓
ARCHIVE          (finalize, merge deltas, move change to archive/)
```

---

## Commands

### Slash Commands (AI chat interface)

**Core profile:**

| Command | Phase | Description |
|---|---|---|
| `/opsx:explore` | Pre-planning | Free-form investigation, no artifacts created |
| `/opsx:propose [name]` | Scaffold + Artifacts | Creates change folder and all planning artifacts in one step |
| `/opsx:apply [name]` | Implementation | Works through `tasks.md`, checks off items |
| `/opsx:archive [name]` | Finalize | Merges delta specs, moves folder to archive |

**Expanded profile:**

| Command | Phase | Description |
|---|---|---|
| `/opsx:new [name]` | Scaffold only | Creates change folder and `.openspec.yaml` |
| `/opsx:continue [name]` | Artifacts (one at a time) | Creates the next ready artifact per dependency graph |
| `/opsx:ff [name]` | Artifacts (all at once) | Creates all planning artifacts in dependency order |
| `/opsx:apply [name]` | Implementation | Same as core |
| `/opsx:verify [name]` | Validation | Checks completeness, correctness, coherence |
| `/opsx:sync [name]` | Spec merge | Merges delta specs into `openspec/specs/` without archiving |
| `/opsx:archive [name]` | Finalize | Same as core |
| `/opsx:bulk-archive [names...]` | Finalize multiple | Archives multiple changes, handles spec conflicts |

### Terminal CLI

```bash
# Project setup
openspec init [path]
openspec update [path]

# Browsing
openspec list [--specs|--changes]
openspec view
openspec show [item]

# Validation
openspec validate [item] [--all] [--strict]

# Lifecycle
openspec archive [name] [-y]

# Status (agent-compatible)
openspec status --change <name> [--json]
openspec instructions [artifact] --change <name> [--json]
```

---

## Artifacts

### Change folder

All change artifacts live under `openspec/changes/<change-name>/`:

```
openspec/changes/<change-name>/
├── .openspec.yaml          # Change metadata (schema, created date)
├── proposal.md             # Intent, scope, approach
├── design.md               # Technical decisions, architecture
├── tasks.md                # Implementation checklist
└── specs/
    └── <domain>/
        └── spec.md         # Delta spec (ADDED/MODIFIED/REMOVED requirements)
```

After archiving, moved to `openspec/changes/archive/YYYY-MM-DD-<change-name>/`.

### Main specs (persistent source of truth)

```
openspec/specs/
└── <domain>/
    └── spec.md             # Full behavior spec, updated on each archive
```

### Artifact formats

**`proposal.md`** — sections: Why / What Changes / Capabilities / Impact

**`specs/<domain>/spec.md`** (delta) — `## ADDED Requirements`, `## MODIFIED Requirements`, `## REMOVED Requirements`. Requirements use `### Requirement: <name>` with RFC 2119 SHALL/MUST language. Scenarios use `#### Scenario: <name>` with WHEN/THEN format.

**`design.md`** — sections: Context / Goals / Non-Goals / Decisions / Risks / Trade-offs / Migration Plan / Open Questions

**`tasks.md`** — checkbox list grouped by section:

```markdown
## 1. Section Name
- [ ] 1.1 Task name
- [ ] 1.2 Task name
```

---

## Human Review Gates

OpenSpec does not enforce rigid phase gates. The design philosophy is:

> "fluid not rigid — no phase gates, work on what makes sense"

In practice:

- Artifacts can be created individually (`/opsx:continue`) for review between steps, or all at once (`/opsx:ff`).
- `/opsx:verify` surfaces issues (CRITICAL / WARNING / SUGGESTION) but does not block archiving.
- `/opsx:archive` warns on incomplete tasks or unsynced specs but does not block.
- Human review happens by inspecting artifacts after AI generation, then deciding whether to continue or edit.

---

## Configuration

### Per-project (`openspec/config.yaml`)

```yaml
schema: spec-driven

context: |
  Tech stack: TypeScript, Node.js
  API style: RESTful

rules:
  proposal:
    - Include rollback plan
  design:
    - Include sequence diagrams for complex flows
  tasks:
    - Add CI verification steps
```

The `context` field (up to 50 KB) is injected into all artifact prompts. `rules` are per-artifact and injected only for the matching artifact type.

### Per-change (`openspec/changes/<name>/.openspec.yaml`)

Stores the schema name and creation date. Created automatically by `/opsx:new`.

### Schema resolution order

1. CLI flag `--schema <name>`
2. Change's `.openspec.yaml`
3. Project `openspec/config.yaml`
4. Default: `spec-driven`

### Multi-language support

Set language via the `context` field:

```yaml
context: |
  Language: Japanese
  All artifacts must be written in Japanese.
```

---

## Key Differences from cc-sdd

| Aspect | OpenSpec | cc-sdd |
|---|---|---|
| Phase enforcement | Fluid, no locks | Sequential with review gates |
| Spec model | Delta specs merged on archive | Fresh artifacts per feature |
| Artifact graph | Dependency-ordered, customizable via schema | Fixed seven-phase sequence |
| Human gates | Advisory only | Enforced (bypass with `-y`) |
| Schema customization | Fully customizable YAML schemas | Fixed schema |
| Tool integration | 20+ AI tools via generated files | Claude Code (cc-sdd) |
