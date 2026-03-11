# Technology Stack

## Architecture

Clean Architecture + Hexagonal Architecture: core logic is independent of infrastructure. Dependencies flow inward through interfaces implemented by adapters.

```
CLI → Use Case Layer → Domain Layer → Adapter Layer → External Systems
```

External systems (LLM providers, Git, SDD frameworks, file systems) are pluggable adapters.

## Core Technologies

- **Language**: TypeScript (strict mode)
- **Runtime**: Bun v1.3.10+
- **Documentation**: VitePress 1.6.x with Mermaid diagrams
- **CLI command**: `aes` (Autonomous Engineer System)

## Development Standards

### Type Safety
TypeScript strict mode with recommended settings:
```json
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true
}
```

### Framework Policy
**No monolithic AI agent frameworks** (no LangChain, AutoGPT, CrewAI, Semantic Kernel).
The system implements its own lightweight agent architecture for full architectural control and long-term stability.

### Documentation
Bilingual (English + Japanese) via VitePress. English in `docs/`, Japanese in `docs/ja/`. Navigation defined in `docs/.vitepress/config.ts`.

## Key Technical Decisions

- **Bun over Node+npm**: Faster startup, built-in TypeScript, simpler tooling
- **Custom agent architecture**: Avoids framework lock-in and maintains full control over tool system, memory, context management
- **SDD-first workflow**: Spec artifacts drive all development phases; reduces hallucination and improves AI reasoning
- **State machine workflow engine**: Deterministic phase transitions from spec to PR

## Common Commands
```bash
# Orchestrator (from orchestrator-ts/)
cd orchestrator-ts
bun install           # Install dependencies
bun run aes           # Run the aes CLI
bun test              # Run tests
bun run typecheck     # Type-check without emitting

# Docs (from repo root)
bun install           # Install VitePress and plugins
bun run docs:dev      # Start VitePress dev server
bun run docs:build    # Build documentation site
bun run docs:preview  # Preview built site
```

---
_Document standards and patterns, not every dependency_
