<!-- SSOT: orchestrator-ts/src/ レイヤー依存ルール（日本語版）。
     Included by:
       docs/ja/architecture/architecture.md
     このファイルは docs/_partials/src-dependency-direction.md の日本語版です。
     依存ルールが変わったときは必ず両方のファイルを更新してください。 -->

依存は常に**内側**を向いていなければなりません：

```text
infra ──► adapters ──► application ──► domain
```

| レイヤー                  | 依存できる対象                                                                      |
| ------------------------ | -------------------------------------------------------------------------------- |
| `domain`                 | `domain` only                                                                    |
| `application/ports`      | `domain`, other `application/ports`                                              |
| `application/services`   | `application/ports`, `application/services`, `domain`                            |
| `application/usecases`   | `application/services`, `application/ports`, `domain`                            |
| `adapters/cli`           | `application/usecases`, `application/ports`                                      |
| `infra/*`                | `application/ports`, `domain`, `infra/utils`                                    |
| `main/di/`               | `application/usecases`, `application/services`, `application/ports`, `adapters/cli`, `infra/*`, `domain` |
| `main/`                  | `main/di/`, `adapters/cli`, `application/ports`, `infra/*`.                     |
