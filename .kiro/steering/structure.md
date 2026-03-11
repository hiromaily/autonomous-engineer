# Project Structure

## Organization Philosophy

Topic-based documentation structure with bilingual support. Source code will follow Clean/Hexagonal Architecture layers when implemented. Currently the repo is primarily documentation-driven, with implementation design captured in `docs/architecture/`.

## Directory Patterns

### Documentation (`docs/`)
**Purpose**: VitePress documentation site — vision, architecture, workflow, development guides
**Subdirectories by domain**: `architecture/`, `agent/`, `development/`, `workflow/`, `frameworks/`, `memory/`, `design/`, `roadmap/`
**Japanese translations**: Mirror structure under `docs/ja/`

### Specs (`.kiro/specs/`)
**Purpose**: Active feature specifications following SDD phases
**Structure per spec**: `requirements.md`, `design.md`, `tasks.md` + `spec.json`

### Steering (`.kiro/steering/`)
**Purpose**: Persistent project memory — patterns, principles, conventions loaded as AI context

### Architecture Layers (planned source structure)
- **CLI Layer**: User-facing entry point (`aes` command)
- **Use Case Layer**: Application business rules and workflow orchestration
- **Domain Layer**: Core system logic, SDD state machine, agent coordination
- **Adapter Layer**: LLM providers, Git, SDD framework bridges

## Naming Conventions

- **Documentation files**: `kebab-case.md`
- **Directories**: `kebab-case/`
- **TypeScript**: `camelCase` functions, `PascalCase` types/interfaces, `kebab-case` files

## Code Organization Principles

- Core logic must not import from adapter layer (dependency inversion)
- Interfaces defined at domain/use-case boundary, implemented in adapters
- New SDD framework support = new adapter only, no core changes required
- Each subsystem (Spec Engine, Workflow Engine, Review Engine) has clearly defined responsibilities

---
_Document patterns, not file trees. New files following patterns shouldn't require updates_
