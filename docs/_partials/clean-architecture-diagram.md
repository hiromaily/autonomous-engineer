<!-- SSOT: Clean Architecture layer dependency diagram (Mermaid).
     Included by:
       docs/architecture/architecture.md,
       docs/ja/architecture/architecture.md
     Edit only this file when the diagram changes. -->

<!-- Dependency direction: infra ──► adapters ──► application ──► domain
     Arrows in the diagram represent compile-time import dependencies.
     For the full per-layer rules, see src-dependency-direction.md. -->

```mermaid
graph TD
    Main["main/<br/>(entry point + top-level DI container)"]
    DI["main/di/<br/>(sub-system DI factories)"]
    CLI["adapters/cli<br/>(CLI adapter — args, rendering)"]
    UC["application/usecases<br/>(use case orchestration)"]
    Services["application/services<br/>(application services)"]
    Ports["application/ports<br/>(port interfaces)"]
    Domain["domain<br/>(core business logic)"]
    Infra["infra/*<br/>(implementations)"]

    Main --> CLI
    Main --> DI
    DI --> UC
    DI --> Services
    DI --> Infra
    DI --> Ports
    DI --> CLI
    CLI --> UC
    UC --> Services
    UC --> Ports
    UC --> Domain
    Services --> Ports
    Services --> Domain
    Ports --> Domain
    Infra --> Ports
    Infra --> Domain
```

Arrows represent compile-time import dependencies. Each layer has strict responsibilities.
