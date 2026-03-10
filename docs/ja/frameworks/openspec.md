# OpenSpec

[OpenSpec](https://github.com/Fission-AI/OpenSpec)は、AIコーディングアシスタント向けのSDDフレームワークで、npmパッケージ `@fission-ai/openspec` として公開されています。

厳格なフェーズゲートを設けるフレームワークとは異なり、OpenSpecは仕様ワークフローを**流動的なアクション**として扱います。アーティファクトはいつでも作成・スキップ・更新でき、依存関係はロックではなくエネイブラーとして機能します。

---

## インストール

```bash
npm install -g @fission-ai/openspec@latest
openspec init [path] [--tools <list|all|none>] [--profile core|custom]
```

`openspec init` は、Claude Code、Cursor、Copilot、Windsurfなど20以上のAIツール向けに統合ファイルを生成します。

---

## ワークフロープロファイル

OpenSpecは2段階のワークフロータイプを提供します。

### コアプロファイル（デフォルト）

素早く利用するための3ステップ：

```
/opsx:propose  →  /opsx:apply  →  /opsx:archive
```

### 拡張プロファイル（オプトイン）

スキャフォールドとアーティファクトコマンドを明示的に分けたステップバイステップ制御：

```
/opsx:new  →  /opsx:ff (または /opsx:continue)  →  /opsx:apply  →  /opsx:verify  →  /opsx:archive
```

プロファイルの切り替え：

```bash
openspec config profile
```

---

## フェーズ構造

OpenSpecの `spec-driven` スキーマにおける基本フェーズ：

```
EXPLORE          （オプション：事前調査、アーティファクトは作成しない）
    ↓
SCAFFOLD         （変更フォルダと .openspec.yaml を作成）
    ↓
ARTIFACTS        （proposal → specs → design → tasks を依存順に作成）
    ↓
IMPLEMENT        （tasks.md のチェックリストに従って実装）
    ↓
VERIFY           （オプション：実装後の検証）
    ↓
SYNC             （オプション：デルタ仕様をメイン仕様にマージ）
    ↓
ARCHIVE          （確定、デルタマージ、変更フォルダをアーカイブに移動）
```

---

## コマンド

### スラッシュコマンド（AIチャットインターフェース）

**コアプロファイル：**

| コマンド | フェーズ | 説明 |
|---|---|---|
| `/opsx:explore` | 事前調査 | 自由な調査。アーティファクトは作成しない |
| `/opsx:propose [name]` | スキャフォールド＋アーティファクト | 変更フォルダと全アーティファクトを一括作成 |
| `/opsx:apply [name]` | 実装 | `tasks.md` のチェックリストを実行 |
| `/opsx:archive [name]` | 確定 | デルタ仕様をマージし、アーカイブに移動 |

**拡張プロファイル：**

| コマンド | フェーズ | 説明 |
|---|---|---|
| `/opsx:new [name]` | スキャフォールドのみ | 変更フォルダと `.openspec.yaml` を作成 |
| `/opsx:continue [name]` | アーティファクト（1つずつ） | 依存グラフに従い次のアーティファクトを作成 |
| `/opsx:ff [name]` | アーティファクト（一括） | 全アーティファクトを依存順に一括作成 |
| `/opsx:apply [name]` | 実装 | コアと同じ |
| `/opsx:verify [name]` | 検証 | 完全性・正確性・整合性を確認 |
| `/opsx:sync [name]` | 仕様マージ | アーカイブせずデルタ仕様をメインにマージ |
| `/opsx:archive [name]` | 確定 | コアと同じ |
| `/opsx:bulk-archive [names...]` | 複数確定 | 複数変更を一括アーカイブ（競合を処理） |

### ターミナルCLI

```bash
# プロジェクト設定
openspec init [path]
openspec update [path]

# 閲覧
openspec list [--specs|--changes]
openspec view
openspec show [item]

# 検証
openspec validate [item] [--all] [--strict]

# ライフサイクル
openspec archive [name] [-y]

# ステータス（エージェント対応）
openspec status --change <name> [--json]
openspec instructions [artifact] --change <name> [--json]
```

---

## アーティファクト

### 変更フォルダ

すべての変更アーティファクトは `openspec/changes/<change-name>/` 以下に格納されます：

```
openspec/changes/<change-name>/
├── .openspec.yaml          # 変更メタデータ（スキーマ、作成日）
├── proposal.md             # 意図、スコープ、アプローチ
├── design.md               # 技術的決定、アーキテクチャ
├── tasks.md                # 実装チェックリスト
└── specs/
    └── <domain>/
        └── spec.md         # デルタ仕様（ADDED/MODIFIED/REMOVED要件）
```

アーカイブ後は `openspec/changes/archive/YYYY-MM-DD-<change-name>/` に移動。

### メイン仕様（永続的なソース・オブ・トゥルース）

```
openspec/specs/
└── <domain>/
    └── spec.md             # 完全な動作仕様。アーカイブのたびに更新される
```

### アーティファクト形式

**`proposal.md`** — セクション：Why / What Changes / Capabilities / Impact

**`specs/<domain>/spec.md`**（デルタ） — `## ADDED Requirements`、`## MODIFIED Requirements`、`## REMOVED Requirements`。要件は `### Requirement: <name>` でRFC 2119のSHALL/MUST言語を使用。シナリオは `#### Scenario: <name>` でWHEN/THEN形式。

**`design.md`** — セクション：Context / Goals / Non-Goals / Decisions / Risks / Trade-offs / Migration Plan / Open Questions

**`tasks.md`** — セクションでグループ化されたチェックボックスリスト：

```markdown
## 1. セクション名
- [ ] 1.1 タスク名
- [ ] 1.2 タスク名
```

---

## 人間によるレビューゲート

OpenSpecは厳格なフェーズゲートを設けません。設計思想は：

> 「流動的であること — フェーズゲートなし、意味のある順序で作業する」

実際の運用：

- アーティファクトは1つずつ（`/opsx:continue`）またはまとめて（`/opsx:ff`）作成でき、前者はステップ間でレビューが可能。
- `/opsx:verify` は問題（CRITICAL / WARNING / SUGGESTION）を報告するが、アーカイブをブロックしない。
- `/opsx:archive` は未完了タスクや未同期仕様に対して警告するが、ブロックしない。
- 人間のレビューは、AIが生成したアーティファクトを確認してから続行または編集を決定する形で行われる。

---

## 設定

### プロジェクト単位（`openspec/config.yaml`）

```yaml
schema: spec-driven

context: |
  技術スタック: TypeScript, Node.js
  APIスタイル: RESTful

rules:
  proposal:
    - ロールバック計画を含めること
  design:
    - 複雑なフローにはシーケンス図を含めること
  tasks:
    - CIの検証ステップを追加すること
```

`context` フィールド（最大50KB）は全アーティファクトのプロンプトに注入されます。`rules` はアーティファクト単位で、対応するアーティファクトにのみ注入されます。

### 変更単位（`openspec/changes/<name>/.openspec.yaml`）

スキーマ名と作成日を格納。`/opsx:new` で自動作成されます。

### スキーマ解決順序

1. CLIフラグ `--schema <name>`
2. 変更の `.openspec.yaml`
3. プロジェクトの `openspec/config.yaml`
4. デフォルト：`spec-driven`

### 多言語サポート

`context` フィールドで言語を指定：

```yaml
context: |
  言語: 日本語
  全アーティファクトは日本語で記述すること。
```

---

## cc-sddとの主な違い

| 観点 | OpenSpec | cc-sdd |
|---|---|---|
| フェーズ強制 | 流動的、ロックなし | 順次、レビューゲートあり |
| 仕様モデル | アーカイブ時にマージされるデルタ仕様 | 機能ごとの新規アーティファクト |
| アーティファクトグラフ | 依存順、スキーマでカスタマイズ可能 | 固定の7フェーズ順序 |
| 人間のゲート | 警告のみ | 強制（`-y` でバイパス可能） |
| スキーマカスタマイズ | YAMLスキーマで完全カスタマイズ | 固定スキーマ |
| ツール統合 | 20以上のAIツールに対応 | Claude Code（cc-sdd）向け |
