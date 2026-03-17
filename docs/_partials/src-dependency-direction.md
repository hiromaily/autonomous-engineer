<!-- SSOT: orchestrator-ts/src/ layer dependency rules.
     Included by:
       docs/architecture/architecture.md,
       docs/ja/architecture/architecture.md,
       docs/README.md
     Edit only this file when the dependency rules change.
     When this file changes, also update the RULES array in:
       orchestrator-ts/scripts/lint-ts-architecture.sh
     Note: orchestrator-ts/src/README.md also shows this table inline
           (GitHub README cannot use @include directives). -->

Dependencies must always point **inward**:

```text
infra ──► adapters ──► application ──► domain
```

| Layer                  | May depend on                                                               |
| ---------------------- | --------------------------------------------------------------------------- |
| `domain`               | `domain` only                                                               |
| `application/ports`    | `domain`, other `application/ports`                                         |
| `application/services` | `application/ports`, `application/services`, `domain`                       |
| `application/usecases` | `application/services`, `application/ports`, `domain`                       |
| `adapters/cli`         | `application/usecases`, `application/ports`                                 |
| `infra/*`              | `application/ports`, `domain`                                               |
| `main/di/`             | `application/usecases`, `application/services`, `adapters/cli`, `infra/*`, `domain`         |
| `main/`                | `main/di/`, `application/ports`, `infra/*`.                                 |
