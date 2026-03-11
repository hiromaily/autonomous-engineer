# エージェント設定方法論

## 概要

Autonomous Engineer は、統一されたアダプターインターフェースを通じて、複数のコーディングエージェントと LLM プロバイダーをサポートします。

各エージェント（Claude Code、Cursor、Codex、GitHub Copilot）には、独自のネイティブ設定形式、機能、および統合モデルがあります。

このドキュメントでは以下を説明します：

- どのエージェントとプロバイダーを使用するかの設定方法
- 設定の階層とスキーマ
- エージェントごとのネイティブ設定の統合
- 動的設定とフェーズごとの設定

---

## 設定の階層

設定は以下の順序で解決されます（優先度が高い順）：

```
CLI フラグ
↓
環境変数
↓
プロジェクト設定ファイル（aes.config.ts）
↓
デフォルト値
```

各レベルは前のレベルを上書きするため、異なる環境で細かく制御できます。

---

## プロジェクト設定ファイル

主要な設定ファイルはプロジェクトルートの `aes.config.ts` です。

例：

```ts
import { defineConfig } from "autonomous-engineer";

export default defineConfig({
  agent: {
    provider: "claude",       // 有効な LLM プロバイダー
    model: "claude-opus-4-6", // モデル識別子
  },

  sdd: {
    framework: "cc-sdd",      // 有効な SDD フレームワークアダプター
  },

  workflow: {
    phases: {
      design: {
        provider: "claude",   // フェーズ固有のプロバイダーオーバーライド
      },
      implementation: {
        provider: "codex",    // 実装フェーズに別のプロバイダーを使用
      },
    },
  },
});
```

設定ファイルはオプションです。存在しない場合はデフォルト値が適用されます。

---

## 環境変数

プロバイダーとモデルは環境変数で設定できます。

| 変数 | 説明 | 例 |
|---|---|---|
| `AES_PROVIDER` | 有効な LLM プロバイダー | `claude`, `codex`, `cursor`, `copilot` |
| `AES_MODEL` | モデル識別子 | `claude-opus-4-6` |
| `AES_SDD_FRAMEWORK` | 有効な SDD フレームワーク | `cc-sdd`, `openspec` |
| `ANTHROPIC_API_KEY` | Anthropic/Claude の API キー | `sk-ant-...` |
| `OPENAI_API_KEY` | OpenAI/Codex の API キー | `sk-...` |

環境変数は、設定ファイルを変更せずに CI/CD 環境やローカルオーバーライドに役立ちます。

---

## CLI フラグ

プロバイダーとモデルは CLI フラグでコマンドごとに上書きできます。

```sh
aes run <spec-name> --provider claude --model claude-opus-4-6
aes run <spec-name> --provider codex --model gpt-4o
```

これは、同じスペックを異なるプロバイダーで比較実行する際に役立ちます。

---

## サポートされているプロバイダー

アダプターインターフェースを通じて以下の LLM プロバイダーをサポートしています。

| プロバイダー | 識別子 | 説明 |
|---|---|---|
| Claude (Anthropic) | `claude` | Anthropic API を通じた Claude モデルファミリー |
| Codex (OpenAI) | `codex` | OpenAI API を通じた OpenAI モデルファミリー |
| Cursor | `cursor` | Cursor エージェントインターフェースを通じた Cursor AI |
| GitHub Copilot | `copilot` | Copilot API を通じた GitHub Copilot |

`adapters/llm/` に `LLMProvider` インターフェースを実装することで、追加のプロバイダーを追加できます。

---

## エージェントごとのネイティブ設定

各コーディングエージェントには独自のネイティブ設定形式があります。

Autonomous Engineer は、有効なエージェントとプロジェクトコンテキストに基づいて、これらのファイルを自動的に生成・管理します。

### Claude Code

Claude Code はプロジェクト固有のルールを以下から読み込みます：

- `CLAUDE.md` — プロジェクトの指示と開発ルール
- `.claude/settings.json` — ツールの権限と動作設定
- `.claude/rules/` — CLAUDE.md によって読み込まれるモジュールルールファイル

Autonomous Engineer が管理する CLAUDE.md の例：

```md
# プロジェクトルール

## 開発ガイドライン
- 仕様駆動開発ワークフローに従う
- すべての変更は有効な仕様に一致する必要がある
- コミット前にテストを実行する

## アーキテクチャ
- クリーンアーキテクチャのレイヤー境界に従う
- すべてのアダプターに依存性注入を使用する
```

### Cursor

Cursor はルールを以下から読み込みます：

- `.cursor/rules/` — `.mdc` ルールファイルを含むディレクトリ

`.cursor/rules/project.mdc` の例：

```md
---
alwaysApply: true
---

仕様駆動開発ワークフローに従ってください。
すべての実装は .kiro/specs/ の有効な仕様に一致する必要があります。
```

### GitHub Copilot

GitHub Copilot はリポジトリの指示を以下から読み込みます：

- `.github/copilot-instructions.md` — リポジトリレベルの指示

例：

```md
このプロジェクトは Autonomous Engineer を使用した仕様駆動開発に従っています。
実装前に .kiro/specs/ の有効な仕様を必ず確認してください。
コードベースのクリーンアーキテクチャのレイヤー構造に従ってください。
```

### Codex (OpenAI)

Codex は以下で設定できます：

- `AGENTS.md` — プロジェクトルートのエージェントレベルの指示
- 環境固有のシステムプロンプトオーバーライド

`AGENTS.md` の例：

```md
# Codex エージェント指示

このプロジェクトは仕様駆動開発を使用しています。
実装前に .kiro/specs/ の有効な仕様を確認してください。
docs/architecture/ で定義されたディレクトリ構造とアーキテクチャに従ってください。
```

---

## 動的設定

### フェーズごとのプロバイダー選択

ワークフローの各フェーズに異なるプロバイダーを割り当てることができます。

これにより、特定のタスクに特化したモデルを使用できます。

設定例：

```ts
workflow: {
  phases: {
    requirements: { provider: "claude" },
    design:       { provider: "claude" },
    implementation: { provider: "codex" },
    review:       { provider: "claude" },
  },
},
```

この戦略により、フェーズの要件にプロバイダーの強みを合わせることができます。

### ランタイム切り替え

設定ファイルを変更せずに、実行間で有効なプロバイダーを切り替えることができます。

```sh
# Claude で実行
AES_PROVIDER=claude aes run <spec-name>

# 同じスペックを Codex で実行
AES_PROVIDER=codex aes run <spec-name>
```

これはプロバイダー間の出力比較に役立ちます。

---

## ネイティブ設定の同期

有効なエージェントが変更された場合、Autonomous Engineer はエージェントネイティブの設定ファイルを再生成できます。

```sh
aes sync-agent-config --provider cursor
```

このコマンドは以下を実行します：

1. `.kiro/steering/` から現在のプロジェクトルールを読み込む
2. ターゲットプロバイダー用のエージェント固有の設定ファイルを生成する
3. `.cursor/rules/`、`CLAUDE.md`、または `AGENTS.md` などのファイルを更新する

これにより、エージェント固有のファイルがプロジェクトのステアリングドキュメントと一致し続けることが保証されます。

---

## まとめ

| 関心事 | 仕組み |
|---|---|
| 有効なプロバイダー | `aes.config.ts`、環境変数、CLI フラグ |
| モデル選択 | `aes.config.ts`、環境変数、CLI フラグ |
| フェーズごとのプロバイダー | `aes.config.ts` の workflow.phases |
| エージェントネイティブルール | `.kiro/steering/` から自動生成 |
| プロバイダーインターフェース | `adapters/llm/` の実装 |

この設定システムにより、ワークフローエンジンはプロバイダーに依存しない状態を維持しながら、ユーザーが各フェーズで実行するエージェントを完全に制御できます。
