# CLIリファレンス

## 概要

`aes` CLIは Autonomous Engineer のコマンドラインインターフェースです。
要件定義から実装まで、仕様駆動ワークフロー全体をターミナルから自動的に実行します。

CLIはTypeScriptで実装されており、[Bun](https://bun.sh) 上で動作します。

---

## インストール

`orchestrator-ts/` ディレクトリから:

```sh
cd orchestrator-ts
bun install
```

開発中の実行:

```sh
bun run aes <command>
```

Bun linkによるグローバルインストール:

```sh
cd orchestrator-ts
bun link
aes <command>
```

---

## コマンド

### `aes run <spec-name>`

指定した仕様の仕様駆動ワークフロー全体を実行します。

```sh
aes run <spec-name> [options]
```

**引数:**

| 引数 | 必須 | 説明 |
|---|---|---|
| `spec-name` | はい | 実行するスペック名（`specDir` 以下のディレクトリ名と一致する必要あり） |

**オプション:**

| オプション | 型 | デフォルト | 説明 |
|---|---|---|---|
| `--provider <name>` | string | 設定から | このランのLLMプロバイダーを上書き |
| `--dry-run` | boolean | `false` | ワークフローを実行せず、スペックと設定の検証のみを行う |
| `--resume` | boolean | `false` | 最後に保存されたワークフロー状態から再開 |
| `--log-json <path>` | string | — | すべてのワークフローイベントをNDJSON形式でこのファイルパスに書き込む |

**使用例:**

```sh
# "tool-system" スペックのワークフロー全体を実行
aes run tool-system

# 設定の検証のみ（実行なし）
aes run tool-system --dry-run

# 中断した実行の再開
aes run tool-system --resume

# プロバイダーを上書きして構造化ログを取得
aes run tool-system --provider claude --log-json ./logs/tool-system.ndjson
```

---

## ワークフローフェーズ

`aes run <spec>` を実行すると、以下のフェーズが自動的に順番に実行されます:

```
SPEC_INIT
    ↓
REQUIREMENTS
    ↓
DESIGN
    ↓
VALIDATE_DESIGN
    ↓
TASK_GENERATION
    ↓
IMPLEMENTATION
    ↓
PULL_REQUEST
```

各フェーズは `.kiro/specs/<spec-name>/` 以下に構造化された成果物を生成します。

### 承認ゲート

ワークフローは3箇所で人間によるレビューのために一時停止します:

| フェーズ後 | レビューする成果物 | 確認内容 |
|---|---|---|
| REQUIREMENTS | `requirements.md` | スコープと要件の確認 |
| DESIGN | `design.md` | アーキテクチャの確認 |
| TASK_GENERATION | `tasks.md` | 実装計画の確認 |

各ゲートでは成果物のパスを表示し、続行前に確認を待ちます。

---

## 設定

### 設定ファイル

プロジェクトルート（`aes` を実行する場所）に `aes.config.json` を配置します:

```json
{
  "llm": {
    "provider": "claude",
    "modelName": "claude-opus-4-6",
    "apiKey": "sk-ant-..."
  },
  "specDir": ".kiro/specs",
  "sddFramework": "cc-sdd"
}
```

**フィールド:**

| フィールド | 必須 | デフォルト | 説明 |
|---|---|---|---|
| `llm.provider` | はい | — | LLMプロバイダー（`claude` がサポート済み） |
| `llm.modelName` | はい | — | モデル識別子（例: `claude-opus-4-6`） |
| `llm.apiKey` | はい | — | LLMプロバイダーのAPIキー |
| `specDir` | いいえ | `.kiro/specs` | スペックサブディレクトリが格納されているディレクトリ |
| `sddFramework` | いいえ | `cc-sdd` | SDDフレームワークアダプター（`cc-sdd`, `openspec`, `speckit`） |

### 環境変数

すべての設定フィールドは環境変数でも設定可能で、設定ファイルより優先されます:

| 変数 | 説明 |
|---|---|
| `AES_LLM_PROVIDER` | LLMプロバイダー名 |
| `AES_LLM_MODEL_NAME` | モデル識別子 |
| `AES_LLM_API_KEY` | APIキー |
| `AES_SPEC_DIR` | スペックディレクトリパス |
| `AES_SDD_FRAMEWORK` | SDDフレームワークアダプター |

**Git連携**（オプション、すべてデフォルト値あり）:

| 変数 | デフォルト | 説明 |
|---|---|---|
| `AES_GIT_BASE_BRANCH` | `main` | フィーチャーブランチのベースブランチ |
| `AES_GIT_REMOTE` | `origin` | Gitリモート名 |
| `AES_GIT_MAX_FILES_PER_COMMIT` | `50` | コミットあたりのファイル数の安全制限 |
| `AES_GIT_PROTECTED_BRANCHES` | `main,master,production,release/*` | 保護されたブランチのカンマ区切りリスト |
| `AES_GIT_IS_DRAFT` | `false` | PRをドラフトとして作成 |
| `AES_GITHUB_TOKEN` | — | PR作成用GitHubトークン |

### 設定の優先順位

設定は以下の順序で解決されます（優先度高い順）:

```
CLIフラグ  →  環境変数  →  aes.config.json  →  デフォルト値
```

---

## 状態と成果物

| パス | 説明 |
|---|---|
| `.kiro/specs/<name>/` | スペック成果物（requirements.md, design.md, tasks.md） |
| `.aes/state/<name>.json` | 保存されたワークフロー状態（`--resume` で使用） |
| `.aes/logs/` | 実装ループのNDJSONログ |
| `.memory/` | エージェントメモリ（ルール、パターン、障害記録） |

### クラッシュからの復旧

実行が中断された場合（プロセス強制終了、ネットワーク障害など）、以下で再開:

```sh
aes run <spec-name> --resume
```

最後に完了したフェーズの境界からワークフローが再開されます。

---

## 終了コード

| コード | 意味 |
|---|---|
| `0` | ワークフローが正常に完了 |
| `1` | ワークフロー失敗、設定エラー、またはスペックが見つからない |
