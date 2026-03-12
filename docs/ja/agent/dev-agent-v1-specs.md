# 仕様計画

このドキュメントは、[dev-agent-v1.md](dev-agent-v1.md)で説明されているAI Dev Agent v1を実装するための仕様分解を定義します。

各仕様は`docs/`配下の1つ以上のアーキテクチャドキュメントに対応し、[cc-sdd](https://github.com/gotalab/cc-sdd)や[OpenSpec](https://openspec.dev/), [spec-kit](https://github.com/github/spec-kit)といったsdd frameworkを介して独立して実装・提供できるよう設計されています。

---

## 設計原則

- **依存順序**: 仕様は実装順にリストされており、各仕様はそれより前に列挙されたものにのみ依存します
- **単一責任**: 各仕様は明確に定義されたインターフェース境界を持つ1つのアーキテクチャ上の関心事を担当します
- **独立してテスト可能**: 各仕様は統合前に単独で検証できます
- **v1スコープ**: 仕様1〜10がAI Dev Agent v1の完全な機能セットをカバーします；仕様11はストレッチゴール（v1.x）です

---

## アーキテクチャ参照

| 仕様 | アーキテクチャドキュメント |
|---|---|
| spec1: orchestrator-core | system-overview.md, architecture/architecture.md |
| spec2: tool-system | architecture/tool-system-architecture.md |
| spec3: agent-safety | architecture/agent-safety-architecture.md |
| spec4: agent-loop | architecture/agent-loop-architecture.md |
| spec5: memory-system | memory/memory-architecture.md |
| spec6: context-engine | architecture/context-engineering-architecture.md |
| spec7: task-planning | architecture/task-planning-architecture.md |
| spec8: git-integration | architecture/architecture.md（Gitコントローラーセクション） |
| spec9: implementation-loop | agent/dev-agent-v1.md |
| spec10: self-healing-loop | agent/dev-agent-v1.md |
| spec11: codebase-intelligence | architecture/codebase-intelligence-architecture.md |

---

## 依存関係マップ

```
spec1: orchestrator-core
├── spec2: tool-system
│   └── spec3: agent-safety
├── spec4: agent-loop
│   └── spec7: task-planning
│       └── spec9: implementation-loop
│           └── spec10: self-healing-loop
├── spec5: memory-system
│   └── spec10: self-healing-loop
└── spec6: context-engine
    ├── spec7: task-planning
    └── spec9: implementation-loop

spec8: git-integration  （spec2: tool-systemに依存）
spec11: codebase-intelligence  （v1.x — spec2, spec6に依存）
```

> **注意:** 上のツリーは推移的な依存階層全体を示しており、`spec1`の直接の子のみを表しているわけではありません。
> `spec1`のブランチとして表示されている仕様も、開始前に中間の仕様を必要とする場合があります。
> 正確な前提条件については、各仕様の`Dependencies`フィールドを参照してください。

以下の表は、並行して実装できる仕様をまとめたものです：

| ウェーブ | 仕様 | 前提条件 |
|---|---|---|
| 1 | spec1 | — |
| 2 | spec2, spec5 | spec1 |
| 3 | spec3, spec4, spec6 | spec2（spec3, spec4の場合）；spec2 + spec5（spec6の場合） |
| 4 | spec7, spec8 | spec4 + spec6（spec7の場合）；spec2 + spec3（spec8の場合） |
| 5 | spec9 | spec4 + spec6 + spec7 + spec8 |
| 6 | spec10 | spec5 + spec9 |
| 7 | spec11 _(v1.x)_ | spec2 + spec6 |

---

## v1仕様

### spec1: orchestrator-core

**アーキテクチャ**: `docs/system-overview.md`, `docs/architecture/architecture.md`

**スコープ**: システムの実行可能なスケルトン。これなしに他のものは実行できません。エントリーポイント、フェーズベースのワークフローステートマシン、プライマリSDDアダプター、LLMプロバイダー抽象化を確立します。

**サブコンポーネント**:
- `cli` — エントリーポイント: `aes run <spec-name>`、設定の読み込み、実行トリガー、進捗レポート
- `workflow-engine` — 7フェーズの開発ライフサイクルを管理するステートマシン:
  `SPEC_INIT → REQUIREMENTS → DESIGN → VALIDATE_DESIGN → TASK_GENERATION → IMPLEMENTATION → PULL_REQUEST`
- `phase-transitions` — フェーズ検証、ライフサイクルフック、状態の永続化、フェーズ境界コンテキストリセット
- `cc-sdd-adapter` — cc-sddコマンドを呼び出して仕様から要件、設計ドキュメント、タスク定義を生成するアダプター
- `llm-abstraction` — LLMプロバイダーインターフェース + Claudeプロバイダー実装；すべてのLLM呼び出しはこの抽象化を通じて行われ、プロバイダーAPIに直接アクセスしない

**依存関係**: なし

**成功基準**: `aes run <spec>` が完全な7フェーズシーケンスをトリガーし、各仕様フェーズでcc-sddを呼び出し、抽象化を介してClaudeを使用し、各フェーズ境界でコンテキストをリセットする。

---

### spec2: tool-system

**アーキテクチャ**: `docs/architecture/tool-system-architecture.md`

**スコープ**: LLMと開発環境の間の構造化された実行インターフェース。すべてのファイルシステム、シェル、git、コード分析、知識操作がこのシステムを通じて行われます。エージェントループが依存する決定論的なツールインターフェースを提供します。

**サブコンポーネント**:
- `tool-interface` — 共通の`Tool<Input, Output>`インターフェース: 名前、説明、JSONスキーマ、実行関数
- `tool-context` — すべてのツールに注入される実行コンテキスト: workspaceRoot、workingDirectory、permissions、memory client、logger
- `tool-registry` — ツールの登録、発見、スキーマ取得の中央レジストリ
- `tool-executor` — スキーマに対して入力を検証し、ツールを呼び出し、出力を検証し、タイムアウトを強制し、エラーを処理する
- `permission-system` — `PermissionSet`能力フラグ（filesystemRead、filesystemWrite、shellExecution、gitWrite、networkAccess）；実行モード（ReadOnly、Dev、CI、Full）
- `tool-categories` — 5つのツールカテゴリーのすべての実装:
  - **ファイルシステムツール**: `read_file`, `write_file`, `list_directory`, `search_files`
  - **Gitツール**: `git_status`, `git_diff`, `git_commit`, `git_branch`
  - **シェルツール**: `run_command`, `run_test_suite`, `install_dependencies`
  - **コード分析ツール**: `parse_typescript_ast`, `find_symbol_definition`, `find_references`, `dependency_graph`
  - **知識ツール**: `search_memory`, `retrieve_spec`, `retrieve_design_doc`
- `error-handling` — `"validation" | "runtime" | "permission"`カテゴリーを持つ構造化された`ToolError`型

**依存関係**: spec1（orchestrator-core）

**成功基準**: ツールがスキーマ検証された入力/出力で登録・呼び出し可能；権限チェックが不正操作をブロック；5つのツールカテゴリーすべてが利用可能で機能する。

---

### spec3: agent-safety

**アーキテクチャ**: `docs/architecture/agent-safety-architecture.md`

**スコープ**: ツール実行をラップする運用安全レイヤー。エージェントが環境に意図しない、または破壊的な変更を引き起こすことを防ぐポリシーとガードレールを定義します。

**サブコンポーネント**:
- `workspace-isolation` — すべてのファイル操作が設定されたワークスペースルート内に収まることを強制；境界外のパストラバーサルを拒否
- `filesystem-guardrails` — パス正規化、保護ファイルの検出（`.env`、`secrets.json`、`.git/config`）、書き込み検証
- `git-safety` — 保護ブランチの強制（`main`/`production`への直接プッシュ禁止）；フィーチャーブランチの命名規則；変更サイズ制限（コミットごとの最大ファイル数）
- `shell-restrictions` — シェルコマンドの許可リスト/ブロックリスト；破壊的コマンドをブロックするパターンマッチング（`rm -rf /`、`shutdown`など）
- `sandboxing` — 信頼できないコードとテストランナーのためのコンテナ化または制限シェル実行環境
- `iteration-limits` — エージェントセッションごとの設定可能な`maxIterations`と`maxRuntime`；違反時に正常停止をトリガー
- `failure-detection` — 同一の繰り返し失敗を検出（閾値: 3回）；実行を一時停止して人間のレビューを要求
- `destructive-action-detection` — 高影響操作（大量ファイル削除、フォースプッシュ）にフラグを立て、人間承認ワークフローにルーティング
- `rate-limiting` — ツール実行、リポジトリ変更、外部APIリクエストの操作ごとの頻度制限
- `audit-logging` — すべてのツール呼び出しの不変ログ: タイムスタンプ、ツール、パラメーター、結果、エラー
- `human-approval-workflow` — フラグが立てられた高リスク操作の承認ゲート；エージェントが一時停止して変更を提案；承認後に再開
- `emergency-stop` — エージェントループ、ツール実行、バックグラウンドプロセスの即時終了のためのシグナルハンドラー

**依存関係**: spec2（tool-system）

**成功基準**: エージェントがワークスペース外に書き込めない；保護ブランチと機密ファイルが変更されない；シェルブロックリストが強制される；繰り返し失敗が実行を一時停止して人間のレビューを要求する；すべてのツール呼び出しがログに記録される。

---

### spec4: agent-loop

**アーキテクチャ**: `docs/architecture/agent-loop-architecture.md`

**スコープ**: AI Dev Agentの認知コア — タスク記述を完成した作業に変換する反復的な推論と実行サイクル。タスク計画の下、生のツール実行の上のレベルで動作します。

**サブコンポーネント**:
- `agent-state` — イテレーション間の永続的な状態: `{ task, plan, completedSteps, currentStep, observations }`
- `plan-step` — LLMが現在の状態を推論して次の`ActionPlan`を生成: 次に何をすべきか、その理由
- `act-step` — ツールシステムを介して計画されたアクションを実行；生の結果を生成
- `observe-step` — ツール結果を構造化された`Observation`として記録；次のイテレーションのコンテキストに追加
- `reflect-step` — LLMが結果が期待通りだったか、何が学ばれたか、計画の調整が必要かを評価
- `update-state-step` — `AgentState`を更新: 完了したステップをマーク、発見をログ、作業計画を更新
- `iteration-control` — `maxIterations`制限を強制；ループ終了を処理（タスク完了 / 人間介入が必要 / 安全制限）
- `action-types` — 4つのアクションカテゴリーをサポート: 探索（読み取り/検索）、変更（書き込み/編集）、検証（テスト/ビルド/リント）、文書化（ドキュメント/コメントの更新）
- `error-recovery` — ループ内回復: エラー分析 → 根本原因の特定 → 修正の試み → 検証の再実行
- `observability` — イテレーションごとの構造化ログ: イテレーション番号、アクション、呼び出されたツール、実行時間、結果状態

**依存関係**: spec2（tool-system）、spec1（orchestrator-core）

**成功基準**: タスクが与えられると、エージェントはタスクが完了するか停止条件に達するまでPLAN→ACT→OBSERVE→REFLECT→UPDATEを反復的に実行；イテレーションログが生成される；エラーがエスカレーション前に回復を試みる。

---

### spec5: memory-system

**アーキテクチャ**: `docs/memory/memory-architecture.md`

**スコープ**: エージェントがワークフローセッションをまたいで情報を蓄積・再利用できるようにする永続的な知識ストレージ。

**サブコンポーネント**:
- `short-term-memory` — アクティブなワークフロー状態のインプロセスストア: 現在の仕様、現在のフェーズ、タスク進捗、作業コンテキスト
- `project-memory` — リポジトリ固有の知識のための`.memory/`ベースのファイルストア:
  - `project_rules.md` — コーディング規約とアーキテクチャ決定
  - `coding_patterns.md` — 繰り返し使用される実装アプローチ
  - `review_feedback.md` — 過去のレビューサイクルからのフィードバック
- `knowledge-memory` — 成功した過去の実行から抽出された再利用可能な実装パターンと戦略（構造化エントリーとして保存）
- `failure-memory` — 失敗の構造化記録: 試みられたこと、失敗したこと、根本原因、解決策；self-healing-loopに直接フィード
- `memory-reader` — クエリに基づいて関連するメモリエントリーを取得；キーワード検索とメタデータフィルタリングをサポート；コンテキスト注入のためのランク付けされた結果を返す

**依存関係**: spec1（orchestrator-core）

**成功基準**: 過去のセッションからの知識（パターン、ルール、レビューフィードバック）が新しいセッションで自動的に取得可能；失敗記録が再起動後も持続；メモリリーダーがコンテキスト注入のための関連結果を返す。

---

### spec6: context-engine

**アーキテクチャ**: `docs/architecture/context-engineering-architecture.md`

**スコープ**: 各推論ステップでLLMに提供される情報を構築します。すべてのプロンプトに何が入るかを決定します — それ以上でもそれ以下でもありません。推論品質とトークン効率の観点から他のすべての仕様にとって重要です。

**サブコンポーネント**:
- `context-layers` — プロンプトごとに組み立てられる7レイヤーコンテキストモデル:
  1. システム指示（エージェントの役割、ツールルール、コーディング標準、安全制約）
  2. タスク記述
  3. アクティブな仕様（設計/要件ドキュメントの関連セクション）
  4. 関連コードコンテキスト（シンボル、依存関係、またはファイル近接性によって取得）
  5. リポジトリ状態（git status、変更ファイル、現在のブランチ）
  6. メモリ取得（メモリシステムから注入された知識）
  7. ツール結果（現在のセッションのツール呼び出しからの出力）
- `context-planner` — 現在のタスクとステップに基づいて、取得するファイル、メモリ、仕様セクションを決定
- `token-budget-manager` — レイヤーごとのトークンを割り当て（例: system:1000、task:500、spec:2000、code:4000、memory:1500、tools:2000）；モデルの制限に合わせてバジェットを調整
- `context-compression` — 過大なレイヤーを削減: ドキュメントの要約、関数レベルのコード抽出、メモリ優先度フィルタリング
- `iterative-expansion` — イテレーション中のエージェント駆動のコンテキスト拡張をサポート（エージェントが追加ファイルの必要性を発見 → 取得してコンテキストに追加）
- `context-cache` — 安定したレイヤー（システム指示、アーキテクチャドキュメント、コーディング標準）をキャッシュして冗長な取得を避ける
- `phase-isolation` — ワークフローがフェーズ間を遷移するときに蓄積されたコンテキストをリセット；フェーズをまたいだコンテキスト汚染を防ぐ
- `task-isolation` — 各タスクセクションが独自のアーティファクトのみから派生した新しい最小コンテキストで開始することを確保

**依存関係**: spec1（orchestrator-core）、spec2（tool-system）、spec5（memory-system）

**成功基準**: プロンプトが各ステップに関連するレイヤーのみを含む；トークン使用量が設定されたバジェット内に収まる；コンテキストがフェーズやタスクセクションをまたいでリークしない；制限に近づいたときに自動的に圧縮が作動する。

---

### spec7: task-planning

**アーキテクチャ**: `docs/architecture/task-planning-architecture.md`

**スコープ**: エージェントループの上に位置する階層的な計画レイヤー。高レベルのゴールを構造化された実行可能な計画に変換します。エージェントループが操作する作業のシーケンスを導きます。

**サブコンポーネント**:
- `planning-hierarchy` — 4レベルの構造: Goal → Tasks → Steps → Actions；各レベルは異なる粒度とライフサイクルを持ちます
- `plan-types` — TypeScript型: `TaskPlan { goal, tasks }`, `Task { id, title, status, steps }`, `Step { id, description, status, dependsOn[] }`
- `initial-plan-generation` — LLMがタスク記述、アーキテクチャドキュメント、リポジトリコンテキストから初期計画を生成
- `dynamic-plan-adjustment` — 新しい情報（既存モジュール、アーキテクチャ制約、テスト失敗）がアプローチを変更したときに実行中に計画を更新
- `step-execution-model` — 各ステップはエージェントループに引き渡される；ステップ状態はエージェントループの結果に基づいて更新される（pending → in_progress → completed）
- `dependency-tracking` — ステップ間の`dependsOn`関係を尊重；順序外の実行を防ぐ
- `failure-recovery` — ステップ失敗時: 再試行 → 実装の精緻化 → 計画の修正；再試行が尽きたらself-healing-loopにエスカレート
- `plan-validation` — アーキテクチャの互換性、コーディング標準、依存制約の実行前チェック
- `plan-persistence` — 計画は`.memory/tasks/task_{id}.json`に保存；中断やクラッシュ後の再開を可能にする
- `human-interaction` — 大規模または高リスクの変更の実行前に人間のレビューのために計画を公開；承認を待って進行

**依存関係**: spec4（agent-loop）、spec6（context-engine）

**成功基準**: cc-sddタスクリストが与えられると、システムが実行可能な計画を生成し、ステップの依存関係を尊重し、計画状態を永続化し、中断後に正しく再開；フラグが立てられた計画の人間レビューゲートが機能する。

---

### spec8: git-integration

**アーキテクチャ**: `docs/architecture/architecture.md`（Gitコントローラーセクション）、`docs/agent/dev-agent-v1.md`

**スコープ**: 自動化された開発パイプラインに必要なすべてのリポジトリ操作。Gitコントローラーインターフェースの背後に完全にカプセル化；他のすべてのコンポーネントはtool-systemのツールを介してこれを呼び出す。

**サブコンポーネント**:
- `branch-manager` — 設定されたベースブランチからフィーチャーブランチを作成；仕様とタスクメタデータからブランチ名を付ける（例: `agent/cache-implementation`）
- `commit-automation` — ステージングされた変更を検出し、LLMを使用して説明的なコミットメッセージを生成し、安全制限（変更サイズ）に対して検証し、コミット
- `push` — 安全チェック（保護ブランチでない、フォースプッシュでない）後に設定されたリモートにフィーチャーブランチをプッシュ
- `pull-request-creator` — LLMが生成したタイトルと本文でリポジトリAPIを介してプルリクエストを作成；仕様参照と実装サマリーを含む

**依存関係**: spec2（tool-system）、spec3（agent-safety）

**成功基準**: 実装完了後、システムがフィーチャーブランチを作成し、意味のあるメッセージですべての変更をコミットし、プッシュし、プルリクエストを開く — 手動介入なし、保護ブランチへの書き込みなし。

---

### spec9: implementation-loop

**アーキテクチャ**: `docs/agent/dev-agent-v1.md`

**スコープ**: タスク計画からの各タスクセクションの実行を調整します。タスクセクションごとのimplement → review → improve → commitサイクルを通じてエージェントループを駆動し、品質ゲートを強制するためにレビューエンジンと調整します。

**サブコンポーネント**:
- `task-section-executor` — 計画からタスクセクションを反復；各セクションについて: コンテキストを初期化し、エージェントループを呼び出し、結果を評価
- `review-engine` — 生成された出力の自動レビュー:
  - 要件整合性（実装が仕様を満たしているか？）
  - 設計一貫性（アーキテクチャに従っているか？）
  - コード品質（リント、テストカバレッジ、命名規則）
- `implement-review-improve-commit` — セクションごとのサイクル:
  1. `implement` — エージェントループがセクションのコードを書く
  2. `review` — レビューエンジンが出力を評価しフィードバックを生成
  3. `improve` — エージェントループがレビューフィードバックを適用して問題を修正
  4. `commit` — Git統合が承認された変更をコミット
- `iteration-control` — セクションごとの再試行数を追跡；設定可能な閾値（例: 3サイクル）；閾値違反時にself-healing-loopにエスカレート
- `quality-gate` — レビューの合格/不合格基準を定義；セクションはゲートが満たされるまでコミットに進めない

**依存関係**: spec4（agent-loop）、spec7（task-planning）、spec6（context-engine）、spec8（git-integration）

**成功基準**: 各タスクセクションが実装され、自動レビューに合格し、コミットされる；サイクルが設定された閾値まで再試行する；閾値を超えたセクションが自己修復に正しくエスカレートする。

---

### spec10: self-healing-loop

**アーキテクチャ**: `docs/agent/dev-agent-v1.md`, `docs/architecture/agent-loop-architecture.md`（エラー回復セクション）

**スコープ**: implementation-loopが再試行閾値を超えたとき、またはエージェントが行き詰まった状態になったときに起動します。失敗を分析し、欠けている知識を特定し、ルールを更新し、改善されたコンテキストで再開します。

**サブコンポーネント**:
- `failure-detection` — 以下によってトリガーされる: implementation-loopからの再試行閾値違反；agent-loopでの同一エラーの繰り返し；エージェントが進めないと報告
- `root-cause-analysis` — 完全な失敗コンテキストのLLM駆動分析: すべての再試行で何が試みられたか、毎回何が失敗したか、エラーのパターン
- `gap-identification` — 現在のルールセットのどのルール、パターン、または知識が欠けているために失敗を防げなかったかを特定
- `rule-update` — ルールファイルへの的を絞った更新を書き込む:
  - `rules/coding_rules.md`
  - `rules/review_rules.md`
  - `rules/implementation_patterns.md`
- `failure-record` — memory-system（failure-memory）に構造化された失敗記録を書き込む: タスクコンテキスト、根本原因、特定されたギャップ、行われたルール変更
- `self-healing-retry` — コンテキストに注入された更新されたルールで失敗したタスクセクションを再開；結果をログ（解決済み / 人間にエスカレート）

**依存関係**: spec9（implementation-loop）、spec5（memory-system）

**成功基準**: 繰り返し失敗が自動的なルールファイル更新をトリガーする；エージェントが自己修復後に以前失敗したタスクを正常に完了する；失敗記録が永続化されて取得可能；自己修復後も解決できないタスクが人間のレビューに正しくエスカレートする。

---

## v1.x仕様（ストレッチゴール）

### spec11: codebase-intelligence

**アーキテクチャ**: `docs/architecture/codebase-intelligence-architecture.md`

**スコープ**: エージェントが大規模な既存ソフトウェアリポジトリを理解し推論できるようにします。context-engineにフィードするスケーラブルなコード取得を提供します。アーキテクチャは完全に文書化されていますが、この仕様は初期v1配信から除外されています。

**サブコンポーネント**:
- `file-scanner` — ソースファイルを検出し、変更を検出し、無関係なディレクトリをフィルタリング（`node_modules/`、`dist/`、`.git/`）
- `parser-layer` — TypeScriptコンパイラーAPI、Tree-sitter、またはRustパーサーを使用してソースファイルを構造化表現（AST、シンボル定義、インポート、関数シグネチャー）に変換
- `symbol-index` — ファイルの場所とメタデータを持つコードベースで定義されたシンボル定義（関数、クラス、インターフェース、型）を保存
- `dependency-graph` — モジュール間の関係を表現: インポート、型参照、モジュール依存関係；影響分析をサポート
- `semantic-index` — 意味ベースの取得のためにコードフラグメント（関数、クラス、ドキュメント）を埋め込む；「ユーザー認証ロジック」などのクエリをサポート
- `query-engine` — 統合された取得API: シンボルルックアップ、参照検索、依存関係トラバーサル、セマンティック検索；すべてのインデックスから結果を組み合わせてランク付け
- `incremental-indexer` — 変更されたファイルのみを再パース；シンボルインデックスと依存グラフをインクリメンタルに更新
- `code-chunker` — 大きなファイルをセマンティックインデックス作成のために独立して取得可能なチャンク（関数、クラス、モジュールごと）に分割

**依存関係**: spec2（tool-system）、spec6（context-engine）

**成功基準**: エージェントが名前と意味によって関連するソースファイルとシンボルを見つけられる；依存パスがトラバース可能；context-engineがファイル全体をロードするのではなくquery-engineからコードスニペットを取得する。

---

## 実装順序

```
1.  spec1:  orchestrator-core        — CLI、ワークフローステートマシン、cc-sddアダプター、LLM抽象化
2.  spec2:  tool-system              — ツールインターフェース、レジストリ、エグゼキューター、5ツールカテゴリー
3.  spec3:  agent-safety             — ワークスペース分離、ガードレール、サンドボックス、人間承認
4.  spec4:  agent-loop               — PLAN→ACT→OBSERVE→REFLECT→UPDATE、エージェント状態、イテレーション制御
5.  spec5:  memory-system            — プロジェクトメモリ、知識メモリ、失敗メモリ、取得
6.  spec6:  context-engine           — 7レイヤーコンテキスト、プランナー、トークンバジェット、圧縮、分離
7.  spec7:  task-planning            — goal→task→steps→actions、動的修正、永続化
8.  spec8:  git-integration          — ブランチ、コミット、プッシュ、プルリクエスト
9.  spec9:  implementation-loop      — implement→review→improve→commit、品質ゲート
10. spec10: self-healing-loop        — 失敗分析、ルール更新、再試行
--- v1完了 ---
11. spec11: codebase-intelligence    — ファイルスキャナー、パーサー、シンボルインデックス、依存グラフ、セマンティック検索
--- v1.x完了 ---
```
