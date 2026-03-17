<!-- SSOT: クリーンアーキテクチャのレイヤー依存関係図（Mermaid）。
     Included by:
       docs/architecture/architecture.md,
       docs/ja/architecture/architecture.md
     Edit only this file when the diagram changes. -->

<!-- 依存関係の方向: infra ──► adapters ──► application ──► domain
     図中の矢印はコンパイル時のインポート依存関係を表します。
     レイヤーごとの詳細ルールは src-dependency-direction-ja.md を参照してください。 -->

```mermaid
graph TD
    Main["main/<br/>(エントリポイント + トップレベルDIコンテナ)"]
    DI["main/di/<br/>(サブシステムDIファクトリー)"]
    CLI["adapters/cli<br/>(CLIアダプター — 引数解析・描画)"]
    UC["application/usecases<br/>(ユースケース調整)"]
    Services["application/services<br/>(アプリケーションサービス)"]
    Ports["application/ports<br/>(ポートインターフェース)"]
    Domain["domain<br/>(コアビジネスロジック)"]
    Infra["infra/*<br/>(実装)"]

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

矢印はコンパイル時のインポート依存関係を表します。各レイヤーは厳格な責務を持ちます。
