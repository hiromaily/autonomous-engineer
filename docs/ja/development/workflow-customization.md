# ワークフローのカスタマイズ

## 概要

このドキュメントでは、`aes run <spec>` で実行される自動ワークフローを調整する際に変更すべきファイルを説明します。

---

## クイックリファレンス

| 変更したい内容 | ファイル |
|---|---|
| フェーズの一覧・順序 | `orchestrator-ts/src/domain/workflow/types.ts` |
| フェーズのシーケンス、ゲート、成果物チェック | `orchestrator-ts/src/domain/workflow/workflow-engine.ts` |
| 各フェーズの実行内容 | `orchestrator-ts/src/domain/workflow/phase-runner.ts` |
| 承認ゲートのロジック | `orchestrator-ts/src/domain/workflow/approval-gate.ts` |
| SDDサブプロセスコマンド | `orchestrator-ts/src/adapters/sdd/cc-sdd-adapter.ts` |
| 依存関係の配線 | `orchestrator-ts/src/application/usecases/run-spec.ts` |
| ターミナル出力 | `orchestrator-ts/src/cli/renderer.ts` |

---

## フェーズシーケンス

フェーズはフリーズされたconst配列として定義されています。フェーズの追加・削除・並び替えは以下を編集します:

**`orchestrator-ts/src/domain/workflow/types.ts`**

```typescript
export const WORKFLOW_PHASES = [
  "SPEC_INIT",
  "REQUIREMENTS",
  "DESIGN",
  "VALIDATE_DESIGN",
  "TASK_GENERATION",
  "IMPLEMENTATION",
  "PULL_REQUEST",
] as const;
```

`WorkflowPhase` 型はこの配列から派生するため、TypeScriptの網羅性チェックによりコードベース全体でフェーズ参照の更新漏れを検出できます。

---

## フェーズシーケンス・ゲート・成果物チェック

コアのステートマシンループは以下にあります:

**`orchestrator-ts/src/domain/workflow/workflow-engine.ts`**

変更すべき主要な定数:

```typescript
// フェーズ実行前に存在が必要なファイル
REQUIRED_ARTIFACTS: Partial<Record<WorkflowPhase, readonly string[]>> = {
  DESIGN:           ["requirements.md"],
  VALIDATE_DESIGN:  ["design.md"],
  TASK_GENERATION:  ["design.md"],
  IMPLEMENTATION:   ["tasks.md"],
}

// 完了後に人間の承認一時停止を発生させるフェーズ
APPROVAL_GATE_PHASES: Partial<Record<WorkflowPhase, ApprovalPhase>> = {
  REQUIREMENTS:    "requirements",
  VALIDATE_DESIGN: "design",
  TASK_GENERATION: "tasks",
}
```

IMPLEMENTATION前の追加ゲートとして、`checkReadyForImplementation()` が `spec.json` の `ready_for_implementation === true` を確認します。この動作を変更する場合はこのメソッドを修正または削除してください。

---

## 各フェーズの実行内容

個々のフェーズの動作は以下でルーティングされます:

**`orchestrator-ts/src/domain/workflow/phase-runner.ts`**

`execute()` メソッドがフェーズ名でスイッチします:

| フェーズ | 現在の動作 |
|---|---|
| `SPEC_INIT` | スタブ — 即座に成功を返す |
| `REQUIREMENTS` | `sdd.generateRequirements(ctx)` |
| `DESIGN` | `sdd.generateDesign(ctx)` |
| `VALIDATE_DESIGN` | `sdd.validateDesign(ctx)` |
| `TASK_GENERATION` | `sdd.generateTasks(ctx)` |
| `IMPLEMENTATION` | `implementationLoop.run(ctx.specName)`（未配線の場合はスタブ） |
| `PULL_REQUEST` | スタブ — 即座に成功を返す |

このクラスの**ライフサイクルフック**はすべてのフェーズ境界で呼び出されます:
- `onEnter(phase)` — 現在はLLMコンテキストをクリアしてフェーズ間の汚染を防止
- `onExit(phase)` — 現在はno-op; 拡張ポイントとして利用可能

---

## 承認ゲートのロジック

**`orchestrator-ts/src/domain/workflow/approval-gate.ts`**

`check()` メソッドは `spec.json` を読み込み `approvals[phase].approved === true` を確認します。
以下の変更はここで行います:
- 承認キー構造の変更
- 代替承認メカニズムの追加（環境変数バイパス、時間ベース自動承認など）
- 承認が必要なフェーズの追加・削除

---

## SDDサブプロセスコマンド

**`orchestrator-ts/src/adapters/sdd/cc-sdd-adapter.ts`**

各 `SddFrameworkPort` メソッドはcc-sdd CLIのサブプロセス呼び出しにマッピングされます。以下の変更はここで行います:
- cc-sddに渡すCLI引数の変更
- 別のSDDフレームワークのサポート追加
- 生成後の成果物のパースや検証方法の変更

---

## オプションサービスの配線

**`orchestrator-ts/src/application/usecases/run-spec.ts`**

`run()` メソッドがすべての依存関係を構築して `WorkflowEngine` に渡します。以下の変更はここで行います:
- `implementationLoop` の配線（現在はオプション）
- セルフヒーリングループサービスの配線
- アダプターの入れ替え（例: `CcSddAdapter` を別のSDDアダプターに変更）

---

## ターミナル出力

**`orchestrator-ts/src/cli/renderer.ts`**

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
SPEC_INIT → (スタブ)
  ↓
REQUIREMENTS → sdd.generateRequirements → [未承認の場合は一時停止]
  ↓ (承認後)
DESIGN → sdd.generateDesign → [未承認の場合は一時停止]
  ↓ (承認後)
VALIDATE_DESIGN → sdd.validateDesign
  ↓
TASK_GENERATION → sdd.generateTasks → [未承認の場合は一時停止]
  ↓ (承認後 + spec.json ready_for_implementation チェック)
IMPLEMENTATION → implementationLoop.run
  ↓
PULL_REQUEST → (スタブ)
  ↓
[workflow:complete]
```

クラッシュからの復旧のため、各フェーズ前に状態が `.aes/state/<spec>.json` に永続化されます。
