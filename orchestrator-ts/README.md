# orchestrator-ts

TypeScript implementation of the Autonomous Engineer System (AES) orchestrator. This package contains the core agent loop, domain logic, and all adapters for the `aes` CLI tool.

## Architecture

Clean Architecture + Hexagonal Architecture. Dependencies flow inward; the domain layer has no external dependencies.

```
CLI → Application (Use Cases) → Domain → Adapters → External Systems
```

## Directory Structure

```
orchestrator-ts/
├── src/
│   ├── adapters/     # Outbound adapters: LLM providers, Git, tools, safety
│   ├── application/  # Use cases, application services, port interfaces
│   ├── cli/          # CLI entrypoint (aes command) and terminal rendering
│   ├── domain/       # Core domain models and business logic (no dependencies)
│   └── infra/        # Infrastructure: config loading, event buses, state stores
├── tests/            # Unit, integration, and e2e tests mirroring src/ structure
├── package.json
└── tsconfig.json
```

## Development

Requires [Bun](https://bun.sh) v1.3.10+.

```bash
bun install        # Install dependencies
bun run aes        # Run the CLI
bun test           # Run all tests
bun run typecheck  # Type-check without emitting
bun run lint       # Lint with Biome
bun run fmt        # Format with dprint
bun run build      # Build to dist/
```
