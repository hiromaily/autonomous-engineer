<!-- SSOT: orchestrator-ts/src/ ディレクトリ構造（日本語版）。
     Included by:
       docs/ja/architecture/architecture.md
     このファイルは docs/_partials/src-directory-structure.md の日本語版です。
     src/ のディレクトリ構造が変わったときは必ず両方のファイルを更新してください。 -->

```text
src/
├── main/                              # エントリポイント + トップレベルDIコンテナ（クリーンアーキテクチャのレイヤー外）
│   ├── index.ts                       # プロセスエントリポイント — CLIアダプターに委譲
│   └── di/                            # サブシステムDIファクトリー（main/からのみ呼び出し可能）
│       ├── run-container.ts           # runコマンド用DIコンテナ（遅延初期化）
│       ├── configure-container.ts     # configureコマンド用DIコンテナ（遅延初期化）
│       ├── factories.ts               # 統合されたサブシステムファクトリー関数群
│       ├── create-git-integration-service.ts
│       └── create-safety-executor.ts
│
├── adapters/                          # 受信デリバリーアダプター（CLIのみ）
│   └── cli/                           # 薄い層：引数解析、ユースケース呼び出し、出力描画
│
├── application/                       # ユースケース、調整サービス、抽象ポート
│   ├── usecases/                      # アプリケーションアクションのトップレベルエントリポイント（例：run-spec.ts）
│   ├── services/                      # 再利用可能な調整ロジック（agent、context、git、safety、tools…）
│   │   ├── agent/
│   │   ├── context/
│   │   ├── git/
│   │   ├── implementation-loop/
│   │   ├── planning/
│   │   ├── safety/
│   │   ├── self-healing-loop/
│   │   ├── tools/
│   │   └── workflow/
│   └── ports/                         # 抽象インターフェース定義（llm、memory、sdd、workflow…）
│
├── domain/                            # 純粋なビジネスルールとドメインコンセプト（外部依存なし）
│   ├── agent/
│   ├── context/
│   ├── debug/
│   ├── git/
│   ├── implementation-loop/
│   ├── planning/
│   ├── safety/
│   ├── self-healing/
│   ├── tools/
│   └── workflow/
│
└── infra/                             # 具体的なポート実装と技術インフラ
    ├── config/                        # 設定ファイルの読み込みとSDDフレームワーク検出
    ├── events/                        # 具体的なイベントバス実装
    ├── git/                           # Gitコントローラーアダプターと GitHub PRアダプター
    ├── llm/                           # Claudeプロバイダー、モックLLMプロバイダー
    ├── logger/                        # ロガークラス（ConsoleLogger、NdjsonFileLogger、AuditLogger…）
    ├── memory/                        # ファイルバックアップおよびインメモリストア
    ├── planning/                      # プランファイルストア
    ├── safety/                        # 承認ゲートウェイ、サンドボックスエグゼキューター
    ├── sdd/                           # Claude Code SDDアダプター、モックSDDアダプター
    ├── state/                         # ワークフロー状態ストア
    ├── tools/                         # シェル、ファイルシステム、git、コード解析ツール実装
    └── utils/                         # インフラ内で共有される低レベルユーティリティ（errors、fs、ndjson）
```
