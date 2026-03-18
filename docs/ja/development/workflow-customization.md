# ワークフローのカスタマイズ

## 概要

このドキュメントでは、`aes run <spec>` で実行される自動ワークフローを調整する方法を説明します。

`custom-sddfw-flow-management` 機能の実装以降、**すべてのフェーズ動作はデータとして定義**されており、複数のソースファイルにハードコードされるのではなく、フレームワーク定義ファイルで管理されます。ワークフローの動作を変更するには、主にSDDフレームワークのフレームワーク定義ファイルを編集します。

フレームワーク定義は `.aes/workflow/<frameworkId>.yaml` に配置された **YAMLファイル**です。`YamlWorkflowDefinitionLoader` によって実行時に読み込まれるため、再コンパイルは不要です。

---

## クイックリファレンス

| 変更したい内容 | 変更場所 |
|---|---|
| フェーズの一覧・順序・タイプ・プロンプト・必要成果物・承認ゲート | フレームワーク定義YAML（例: `orchestrator-ts/.aes/workflow/cc-sdd.yaml`） |
| プロジェクト設定のフレームワーク識別子 | `.aes/config.json` → `sddFramework` フィールド（デフォルト: `"cc-sdd"`） |
| 新しい実行タイプのディスパッチロジック | `orchestrator-ts/src/application/services/workflow/phase-runner.ts` |
| 承認ゲートのロジック | `orchestrator-ts/src/application/services/workflow/approval-gate.ts` |
| SDDサブプロセスコマンド（`llm_slash_command`フェーズ用） | `orchestrator-ts/src/infra/sdd/cc-sdd-adapter.ts` |
| フレームワークYAMLローダー | `orchestrator-ts/src/infra/sdd/yaml-workflow-definition-loader.ts` |
| ターミナル出力 | `orchestrator-ts/src/adapters/cli/renderer.ts` |

---

## フレームワーク定義ファイル

各SDDフレームワークのフェーズ動作は、`.aes/workflow/<frameworkId>.yaml` に配置された単一のYAMLファイルで定義され、`YamlWorkflowDefinitionLoader` によって実行時に読み込まれます。

**ドメインインターフェース:** `orchestrator-ts/src/domain/workflow/framework.ts`

```typescript
export interface PhaseDefinition {
  readonly phase: string;               // フェーズ識別子
  readonly type: PhaseExecutionType;    // ディスパッチタイプ（以下参照）
  readonly content: string;            // スラッシュコマンド名またはインラインプロンプトテキスト
  readonly requiredArtifacts: readonly string[];  // フェーズ実行前に存在が必要なファイル
  readonly approvalGate?: ApprovalPhase; // 設定した場合、このフェーズ後に人間の承認のために一時停止
  readonly approvalArtifact?: string;  // 承認ゲートメッセージに表示する成果物パス
  readonly outputFile?: string;        // llm_promptフェーズの出力ファイル名
}

export interface FrameworkDefinition {
  readonly id: string;                  // フレームワーク識別子（例: "cc-sdd"）
  readonly phases: readonly PhaseDefinition[];  // 実行順のフェーズ一覧
}
```

**cc-sdd具体定義:** `orchestrator-ts/.aes/workflow/cc-sdd.yaml`

このYAMLファイルはcc-sddワークフローの**唯一の信頼できる情報源**です。以前ソースファイル全体に分散していた `REQUIRED_ARTIFACTS`、`APPROVAL_GATE_PHASES`、`WORKFLOW_PHASES` 定数を置き換えます。

---

## フェーズ実行タイプ

各フェーズは `type` を宣言し、`PhaseRunner` がどのようにディスパッチするかを決定します:

| タイプ | ディスパッチ動作 |
|---|---|
| `llm_slash_command` | `SddFrameworkPort.executeCommand(content, ctx)` を呼び出す — cc-sddスラッシュコマンドをサブプロセスとして実行 |
| `llm_prompt` | `LlmProviderPort.complete(content)` を呼び出す — インラインプロンプトテキストをLLMに直接送信 |
| `suspension` | 即座に `{ ok: true }` を返す; 承認ゲート（設定されている場合）が再開を処理 |
| `human_interaction` | 即座に `{ ok: true }` を返す; `suspension` と同じセマンティクス（レガシーエイリアス） |
| `implementation_loop` | `IImplementationLoop.run(ctx.specName)` に委譲、未配線の場合は `{ ok: true }` スタブを返す |
| `git_command` | 将来のgit/PR操作のためのスタブとして `{ ok: true }` を返す |

---

## cc-sddフェーズリファレンス

cc-sddフレームワークは14フェーズを順に定義します:

| フェーズ | タイプ | 内容・動作 |
|---|---|---|
| `SPEC_INIT` | `llm_slash_command` | `kiro:spec-init` |
| `HUMAN_INTERACTION` | `suspension` | 一時停止 — 承認ゲートがユーザーの `requirements.md` 作成まで待機 |
| `VALIDATE_PREREQUISITES` | `llm_prompt` | `requirements.md` の存在と非空を確認 |
| `SPEC_REQUIREMENTS` | `llm_slash_command` | `kiro:spec-requirements` |
| `VALIDATE_REQUIREMENTS` | `llm_prompt` | `requirements.md` の完全性とテスト可能性をレビュー |
| `REFLECT_BEFORE_DESIGN` | `llm_prompt` | `requirements.md` から制約とオープンクエスチョンを統合 |
| `VALIDATE_GAP` | `llm_slash_command` | `kiro:validate-gap` |
| `SPEC_DESIGN` | `llm_slash_command` | `kiro:spec-design` |
| `VALIDATE_DESIGN` | `llm_slash_command` | `kiro:validate-design` |
| `REFLECT_BEFORE_TASKS` | `llm_prompt` | `design.md` から設計決定とパターンを統合 |
| `SPEC_TASKS` | `llm_slash_command` | `kiro:spec-tasks` |
| `VALIDATE_TASKS` | `llm_prompt` | `tasks.md` の完全性と実装準備状況をレビュー |
| `IMPLEMENTATION` | `implementation_loop` | 実装ループサービスに委譲 |
| `PULL_REQUEST` | `git_command` | 将来のgit/PR操作のためのスタブ |

承認ゲートによる一時停止: `HUMAN_INTERACTION`、`SPEC_REQUIREMENTS`、`VALIDATE_DESIGN`、`SPEC_TASKS` の後。

必要成果物はYAMLファイルでフェーズごとに宣言されます。例えば `VALIDATE_DESIGN` は実行前に `design.md` の存在が必要です。

---

## 新しいSDDフレームワークの追加

オーケストレーターのソースファイルを変更せずに新しいSDDフレームワーク（例: `open-spec`）のサポートを追加するには:

1. YAML定義ファイルを作成: `orchestrator-ts/.aes/workflow/open-spec.yaml`
2. フレームワークのフェーズでスキーマを実装（参考: `cc-sdd.yaml`）。
3. `.aes/config.json` に `"sddFramework": "open-spec"` を設定。

不明なフレームワーク識別子が設定されている場合、オーケストレーターは起動時に不足しているYAMLファイルのパスを示すエラーで失敗します。

---

## cc-sddフェーズ動作の変更

**プロンプトを変更する**場合、`.aes/workflow/cc-sdd.yaml` の `llm_prompt` フェーズの `content` フィールドを編集します。コンテンツはランタイムプレースホルダーとして `{specDir}` をサポートします。

**必要成果物を追加・削除する**場合、該当フェーズの `required_artifacts` を更新します。

**承認ゲートを追加・削除する**場合、フェーズエントリの `approval_gate` を設定またはクリアします。有効な値: `"human_interaction"`、`"requirements"`、`"design"`、`"tasks"`。オプションで `approval_artifact` を設定して承認メッセージに表示するファイルを指定できます。

**フェーズを並び替える**場合、`phases` フィールドの配列順序を変更します。`WorkflowEngine` はこの配列から実行順序を導きます。

YAMLを編集した後、テストスイート（`bun test`）を実行して構造的な妥当性を確認してください — `validateFrameworkDefinition()` はロード時に呼び出され、フェーズの重複、`llm_slash_command`/`llm_prompt` フェーズの空の `content`、不明な `approval_gate` の値などの問題を検出します。

---

## 承認ゲートのロジック

**`orchestrator-ts/src/application/services/workflow/approval-gate.ts`**

`check()` メソッドは `spec.json` を読み込み `approvals[phase].approved === true` を確認します。以下の変更はここで行います:
- 承認キー構造の変更
- 代替承認メカニズムの追加（環境変数バイパス、時間ベース自動承認など）

---

## オプションサービスの配線

**`orchestrator-ts/src/main/di/run-container.ts`**

DIコンテナがすべての依存関係を構築して `RunSpecUseCase` に注入します。以下の変更はここで行います:
- `implementationLoop` の配線（現在はオプション）
- セルフヒーリングループサービスの配線
- フレームワークアダプターの入れ替え

---

## ターミナル出力

**`orchestrator-ts/src/adapters/cli/renderer.ts`**

ワークフローイベントのターミナル表示を処理します。以下の変更はここで行います:
- フェーズ開始・完了メッセージ
- ユーザーへの承認ゲート指示
- エラーと失敗のフォーマット

イベント型の定義は以下にあります:
**`orchestrator-ts/src/application/ports/workflow.ts`**

---

## ワークフローの状態遷移

```
[初期状態]
  ↓
SPEC_INIT → llm_slash_command (kiro:spec-init)
  ↓
HUMAN_INTERACTION → suspension → [一時停止: ユーザーが requirements.md を作成]
  ↓ (承認後)
VALIDATE_PREREQUISITES → llm_prompt (requirements.md を確認)
  ↓
SPEC_REQUIREMENTS → llm_slash_command (kiro:spec-requirements) → [未承認の場合は一時停止]
  ↓ (承認後)
VALIDATE_REQUIREMENTS → llm_prompt (requirements.md をレビュー)
  ↓
REFLECT_BEFORE_DESIGN → llm_prompt (制約を統合)
  ↓
VALIDATE_GAP → llm_slash_command (kiro:validate-gap)
  ↓
SPEC_DESIGN → llm_slash_command (kiro:spec-design)
  ↓
VALIDATE_DESIGN → llm_slash_command (kiro:validate-design) → [未承認の場合は一時停止]
  ↓ (承認後)
REFLECT_BEFORE_TASKS → llm_prompt (設計決定を統合)
  ↓
SPEC_TASKS → llm_slash_command (kiro:spec-tasks) → [未承認の場合は一時停止]
  ↓ (承認後)
VALIDATE_TASKS → llm_prompt (tasks.md をレビュー)
  ↓
IMPLEMENTATION → implementation_loop
  ↓
PULL_REQUEST → git_command スタブ
  ↓
[workflow:complete]
```

クラッシュからの復旧のため、各フェーズ前に状態が `.aes/state/<spec>.json` に永続化されます。
