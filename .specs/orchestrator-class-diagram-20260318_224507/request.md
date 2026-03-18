# Request: Orchestrator-TS Class Diagram

## Task Description

Create a class diagram using Mermaid notation that visualizes the structure of the `orchestrator-ts` project.

The diagram should:
- Show abstract classes/interfaces and their concrete implementation classes
- Visualize the relationships between structs (composition, inheritance, implementation)
- Make it easy to understand the architecture at a glance

## Context

- Repository: `/Users/hiroki.yasui/work/hiromaily/autonomous-engineer`
- Current branch: `feature/yaml-impl-loop-config`
- The project follows Clean Architecture with layers: domain, application (ports + services), infra, adapters, main
- Source code lives in: `orchestrator-ts/src/`
- The project uses TypeScript with Bun as the runtime

## Output

The final output should be one or more Mermaid class diagrams (in a markdown file) that clearly shows:
1. Domain models (types/interfaces)
2. Application ports (abstract interfaces)
3. Application services (concrete implementations of ports)
4. Infrastructure implementations (concrete port implementations)
5. Relationships between all of the above
