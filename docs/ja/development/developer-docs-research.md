# 開発者ドキュメント調査レポート

## 概要

このレポートでは、既存の開発者向けドキュメント、ギャップ、および `docs/development/` をコントリビューター向けの完全な知識ベースとして整備するための推奨事項を示します。

追跡: [GitHub Issue #23](https://github.com/hiromaily/autonomous-engineer/issues/23)

---

## Part 1: 既存ドキュメント

### `docs/development/` （現在のファイル）

| ファイル | 状態 | 概要 |
|---|---|---|
| `development-environment.md` | 完了 | ツールチェーン: Bun v1.3.10, TypeScript 5.9.3, Biome, dprint, Anthropic SDK |
| `ai-agent-framework-policy.md` | 完了 | モノリシックフレームワーク（LangChainなど）を避ける理由 |
| `agent-configuration.md` | 完了 | LLMプロバイダー設定、環境変数、フェーズ別オーバーライド |
| `cli-reference.md` | 完了 | `aes run` コマンド、ワークフローフェーズ、承認ゲート、終了コード |
| `debugging.md` | 完了 | ログレイヤー、`--log-json`、`.aes/logs/`、`.aes/state/`、メモリファイル |
| `workflow-customization.md` | 完了 | ワークフロー調整時に変更すべきファイル |

すべてのファイルは `docs/ja/development/` に日本語ミラーがあります。

### 関連ドキュメント

| 場所 | 内容 |
|---|---|
| `docs/architecture/` | システム設計レイヤーをカバーする7つのアーキテクチャドキュメント |
| `docs/memory/memory-architecture.md` | メモリシステムの抽象設計 |
| `docs/workflow/spec-driven-workflow.md` | SDDフェーズワークフロー |
| `CLAUDE.md` | Claude Code向けプロジェクトルール |
| `.kiro/steering/` | 永続的なプロジェクトメモリ（product.md, tech.md, structure.md） |

### ツールチェーン設定ファイル

| ファイル | 用途 |
|---|---|
| `orchestrator-ts/package.json` | スクリプト: `test`, `typecheck`, `fmt`, `lint`, `build` |
| `orchestrator-ts/tsconfig.json` | `@/*` パスエイリアス付きの厳格なTypeScript設定 |
| `orchestrator-ts/biome.json` | Biome リンター設定 |
| `orchestrator-ts/dprint.json` | dprint フォーマッター設定 |
| `lefthook.yml` | プリコミットフック: `make ts-lint` |
| `.github/workflows/docs.yml` | CI: VitePress の GitHub Pages へのデプロイ |

---

## Part 2: ギャップ

### P1 — 重大（コントリビューターのオンボーディングをブロック）

**クイックスタート** (`quickstart.md`)
- `development-environment.md` はツールチェーンを説明しているが、「クローン→動作確認」の一貫したガイドがない
- 不足: 段階的な `bun install` 手順、CLIのローカル動作確認、開発中に作成される `.aes/` / `.memory/` / `.kiro/` ディレクトリの説明、lefthookのセットアップ

**テストガイド** (`testing-guide.md`)
- `orchestrator-ts/tests/` には unit / integration / e2e サブディレクトリに実際のテストが存在するが、テストの実行方法、テスト構成、LLM/Git/ファイルシステムのモック戦略、カバレッジ基準に関するドキュメントが皆無

**コントリビューションガイド** (`contributing.md`)
- ブランチ命名規則、コミットメッセージ標準、PRチェックリスト、スペックを作成するタイミングと直接PRを開くタイミングのガイダンスがない

**コード構造** (`code-structure.md`)
- アーキテクチャドキュメントは抽象的なレイヤリングを説明しているが、`orchestrator-ts/src/` の具体的なClean Architectureレイアウト（cli / application / domain / adapters / infra）、コードでのポート/アダプターパターン、`@/*` パスエイリアスについての説明がない

---

### P2 — 重要（コントリビューション開始後に必要）

**アダプターの実装** (`implementation/implementing-adapters.md`)
- 新しいLLMプロバイダー、SDDフレームワーク、ツールの追加方法に関するガイドがない。パターンは一貫している（`adapters/` でポートインターフェースを実装する）が文書化されていない

**ドメインレイヤーガイド** (`implementation/domain-layer-guide.md`)
- ビジネスルールの組織化、状態マシン（`WorkflowState`, `AgentState`）、判別共用体パターン、ドメイン型の安全な拡張方法の説明がない

**ツールシステムリファレンス** (`implementation/tool-system.md`)
- `docs/architecture/tool-system-architecture.md` は抽象設計をカバーしているが、既存のツールインベントリ（filesystem, shell, git, code-analysis, knowledge）や安全制約を含む新しいツールの追加方法についての説明がない

**Git連携の内部実装** (`implementation/git-integration.md`)
- フィーチャーブランチの作成、コミット戦略（タスクセクションごとのアトミックコミット）、PR生成、ローカル開発用のGitHubトークンセットアップの説明がない

**メモリシステムの内部実装** (`implementation/memory-system-implementation.md`)
- `docs/memory/memory-architecture.md` は抽象的。実行中の `.memory/` の生成方法、メモリファイルの手動編集タイミング、失敗記録がエージェント動作にフィードバックされる仕組みのガイドがない

**詳細なデバッグ** (`implementation/deep-debugging.md`)
- `debugging.md` はログファイルをカバーしているが、レイヤー別デバッグ、LLMプロンプト/レスポンスのトレース、ツール実行失敗、ワークフローフェーズのハング、Bunデバッガーの使用方法が不足

---

### P3 — 高度（メンテナーと専門コントリビューター向け）

**TypeScriptパターン** (`advanced/type-safety-patterns.md`)
- `strict` / `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` は設定されているが文書化されていない。Result/Eitherエラーハンドリング、ブランデッド型、判別共用体の網羅性チェックのガイドがない

**パフォーマンスとプロファイリング** (`advanced/performance-and-profiling.md`)
- トークンバジェット監視、エージェントループのNDJSON分析、Rustコンポーネント（`memory-rs`）の導入基準のガイドがない

**デプロイと配布** (`advanced/deployment-and-distribution.md`)
- `bun build` でバイナリが生成されるが、ビルド、NPM公開、GitHubリリースのガイドがない

**SDDフレームワークアダプター** (`implementation/sdd-framework-adapters.md`)
- `cc-sdd-adapter.ts` の動作や `openspec` / `speckit` サポートの追加方法のガイドがない

---

### CI/CDのギャップ

既存のワークフローは `.github/workflows/docs.yml`（VitePress デプロイ）のみです。テスト、リンティング、型チェックのCIがありません。以下の2つのワークフローが必要です:

- `.github/workflows/test.yml` — すべてのPRでlint + typecheck + `bun test`
- `.github/workflows/release.yml` — リリース時のバイナリビルドと公開

---

## Part 3: 推奨ディレクトリ構造

```
docs/development/
├── quickstart.md                          新規 (P1)
├── contributing.md                        新規 (P1)
├── testing-guide.md                       新規 (P1)
├── code-structure.md                      新規 (P1)
├── workflow-customization.md              既存
├── cli-reference.md                       既存
├── debugging.md                           既存
├── development-environment.md             既存
├── agent-configuration.md                 既存
├── ai-agent-framework-policy.md           既存
│
├── implementation/
│   ├── implementing-adapters.md           新規 (P2)
│   ├── domain-layer-guide.md             新規 (P2)
│   ├── tool-system.md                    新規 (P2)
│   ├── git-integration.md               新規 (P2)
│   ├── memory-system-implementation.md   新規 (P2)
│   ├── deep-debugging.md                 新規 (P2)
│   └── sdd-framework-adapters.md         新規 (P3)
│
└── advanced/
    ├── type-safety-patterns.md            新規 (P3)
    ├── performance-and-profiling.md       新規 (P3)
    └── deployment-and-distribution.md    新規 (P3)
```

`docs/ja/development/` は同じ構造をミラーします（バイリンガル要件）。

---

## Part 4: ドキュメント仕様

### `quickstart.md` (P1)
主要セクション: システム要件 → クローン + `bun install` → `bun run typecheck` と `bun test` による検証 → `bun run aes` でのCLI実行 → lefthookプリコミットセットアップ → 実行時に作成されるディレクトリ → 次のステップ

### `contributing.md` (P1)
主要セクション: ブランチ命名（`feature/`, `fix/`, `docs/`, `refactor/`）、コミットメッセージ規約、スペック作成 vs 直接PRの判断基準、PRチェックリスト、マージ戦略

### `testing-guide.md` (P1)
主要セクション: テストの実行（`bun test`、`--watch`、フィルタリング）、テスト構成（`src/` をミラー）、unit / integration / e2eの境界定義、モック戦略（LLM / ファイルシステム / Git）、フィクスチャパターン、命名規則

### `code-structure.md` (P1)
主要セクション: `orchestrator-ts/src/` のClean Architectureレイヤー、依存性の方向、具体的なコード例でのポート/アダプターパターン、`@/*` パスエイリアス、「全レイヤーを通じた機能のトレース」ウォークスルー

### `implementation/implementing-adapters.md` (P2)
主要セクション: 新しいLLMプロバイダーの追加（`ClaudeProvider` を参照として段階的に）、新しいツールの追加、新しいSDDフレームワークアダプターの追加、各タイプのテスト

### `implementation/domain-layer-guide.md` (P2)
主要セクション: 外部依存禁止の制約、主要エンティティと状態マシン、判別共用体パターン、エラー型、ドメイン型の安全な拡張、純粋関数テスト

### `implementation/tool-system.md` (P2)
主要セクション: ツールインベントリ（filesystem, shell, git, code-analysis, knowledge）、ツールエグゼキューターパイプライン（バリデーション → 実行 → 監査ログ）、安全制約、新しいツールの追加方法

### `implementation/git-integration.md` (P2)
主要セクション: フィーチャーブランチの作成と命名、アトミックコミット戦略、保護ブランチチェック、PR生成、GitHubトークンセットアップ

### `implementation/memory-system-implementation.md` (P2)
主要セクション: `.memory/` ファイルの種類と構造、実行中のメモリ生成方法、失敗記録、メモリの手動編集タイミングと方法、LLMプロンプトコンテキストへの影響

### `implementation/deep-debugging.md` (P2)
主要セクション: レイヤー別デバッグ（CLI / Application / Domain / Adapters / Infra）、LLMプロンプト/レスポンスのトレース、ツール実行失敗、ワークフローフェーズのハング、Bunデバッガー、`jq` でのNDJSONログ分析

### `advanced/type-safety-patterns.md` (P3)
主要セクション: `strict` / `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` の実例、Result/Eitherエラーハンドリング、判別共用体、ブランデッド型、`never` での網羅性チェック

### `advanced/performance-and-profiling.md` (P3)
主要セクション: トークンバジェット監視、反復回数とタイミングのNDJSONログ分析、最適化戦略（コンテキスト削減、メモリ関連性）、Rustコンポーネントの導入基準

### `advanced/deployment-and-distribution.md` (P3)
主要セクション: `bun build` の出力、ローカル開発用の `bun link`、NPM公開、GitHubリリースアセット、バージョニング

---

## Part 5: 受け入れ基準

- [ ] P1ドキュメントを英語と日本語で作成
- [ ] P2ドキュメントを英語と日本語で作成
- [ ] P3ドキュメントを英語と日本語で作成
- [ ] すべての新規ドキュメントとサブディレクトリのVitePress ナビゲーション更新
- [ ] `.github/workflows/test.yml` の追加
- [ ] 新しい開発者が15分以内にクイックスタートを完了できる
