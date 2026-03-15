# デバッグとログ

## 概要

Autonomous Engineer は開発中のデバッグをサポートするため、複数のレベルで構造化ログを出力します。
ワークフローレベルのイベント、エージェントの操作履歴、LLMへの指示・応答の履歴という3層のログが利用できます。

---

## ログレイヤー

| レイヤー | 記録内容 | 出力先 |
|---|---|---|
| ワークフローイベント | フェーズ遷移、承認ゲート、完了・失敗 | CLIのstdout + オプションの `--log-json` ファイル |
| 実装ループ | セクションの反復、レビューサイクル、エスカレーション | `.aes/logs/implementation-loop-<planId>.ndjson` |
| エージェント状態 | PLAN→ACT→OBSERVE→REFLECT→UPDATE の完全トレース | 実装ループのログエントリに埋め込み |
| LLM呼び出し履歴 | LLMに送受信したメッセージ | `ClaudeProvider` がキャプチャし、エージェント状態に反映 |

---

## ワークフローイベントログ（`--log-json`）

すべてのワークフローレベルのイベントをNDJSONとして取得:

```sh
aes run <spec-name> --log-json ./logs/run.ndjson
```

各行はイベントタイプを識別する `event` フィールドを持つJSONオブジェクトです。

**イベントタイプ:**

| イベント | 説明 |
|---|---|
| `phase:start` | ワークフローフェーズが開始された |
| `phase:complete` | ワークフローフェーズが正常に完了した |
| `phase:failed` | ワークフローフェーズが失敗した |
| `approval:required` | ワークフローが一時停止し、人間の承認を待っている |
| `approval:granted` | 人間の承認を受け取り、ワークフローが再開した |
| `workflow:complete` | ワークフロー全体が完了した |
| `workflow:failed` | ワークフローがエラーで終了した |

**出力例:**

```ndjson
{"event":"phase:start","phase":"REQUIREMENTS","specName":"tool-system","timestamp":"2026-03-15T05:00:00.000Z"}
{"event":"approval:required","phase":"REQUIREMENTS","artifactPath":".kiro/specs/tool-system/requirements.md","timestamp":"2026-03-15T05:01:23.000Z"}
{"event":"approval:granted","phase":"REQUIREMENTS","timestamp":"2026-03-15T05:01:45.000Z"}
{"event":"phase:complete","phase":"REQUIREMENTS","specName":"tool-system","timestamp":"2026-03-15T05:01:45.000Z"}
```

---

## 実装ループログ

IMPLEMENTATIONフェーズ中、詳細なログが自動的に以下に書き込まれます:

```
.aes/logs/implementation-loop-<planId>.ndjson
```

このファイルには各セクションの完全な実行履歴が記録されます。

**レコードタイプ:**

| タイプ | 説明 |
|---|---|
| `iteration:start` | セクションに対するエージェントループの反復が開始された |
| `iteration:complete` | 反復が結果とともに終了した |
| `step:start` | PLAN/ACT/OBSERVE/REFLECT/UPDATEの1ステップが開始された |
| `step:complete` | ステップが完了した |
| `section:complete` | タスクセクションがレビューを通過してコミットされた |
| `section:halted` | セクションがエスカレーションされた（リトライ上限到達） |
| `loop:halt` | 実装ループが早期停止した |

**反復レコードの例:**

```json
{
  "type": "iteration:complete",
  "sectionId": "task-1.1",
  "iterationCount": 2,
  "durationMs": 4200,
  "result": "completed",
  "toolsUsed": ["read_file", "write_file", "run_test_suite"],
  "timestamp": "2026-03-15T05:10:00.000Z"
}
```

---

## エージェント状態とLLM履歴

各エージェントループの反復は、以下を含む `AgentState` オブジェクトを生成します:

- `task` — 現在のタスク説明
- `plan` — 現在の作業計画
- `completedSteps` — 完了したステップのサマリー配列
- `observations` — 現在のセッションのツール結果オブザベーション
- `iterationCount` — 実行された反復回数

`finalState` は各セクションの完了またはハルト後に `iteration:complete` ログエントリで出力され、エージェントが何をしたか・なぜそうしたかの完全なトレースが確認できます。

**LLM指示履歴**は `ClaudeProvider` がフェーズ内のすべてのプロンプトをまたいで保持します。各フェーズは空のヒストリーで開始されます（フェーズ境界で `clearContext()` が呼ばれます）。履歴には以下が含まれます:

- システムプロンプト（エージェントの役割、ルール、コーディング標準、安全制約）
- タスク説明
- Claudeに送信されたすべてのPLANプロンプト
- Claudeのすべての応答（計画されたアクション、リフレクション）
- ユーザーターンメッセージとしてフィードバックされたツール結果

この完全なメッセージ履歴はエージェント状態のオブザベーションから確認でき、反復ごとにログに記録されます。

---

## ワークフロー状態ファイル

ワークフロー状態は各フェーズ後に `.aes/state/<spec-name>.json` に永続化されます。
このファイルはクラッシュからの復旧に使用され、現在のフェーズと履歴を確認できます。

```sh
cat .aes/state/tool-system.json
```

**構造:**

```json
{
  "specName": "tool-system",
  "currentPhase": "IMPLEMENTATION",
  "completedPhases": ["SPEC_INIT", "REQUIREMENTS", "DESIGN", "VALIDATE_DESIGN", "TASK_GENERATION"],
  "startedAt": "2026-03-15T05:00:00.000Z",
  "updatedAt": "2026-03-15T05:09:00.000Z"
}
```

---

## メモリファイル

エージェントは `.memory/` に知識を蓄積します:

| ファイル | 説明 |
|---|---|
| `.memory/project_rules.md` | コーディング規約とアーキテクチャ決定 |
| `.memory/coding_patterns.md` | 繰り返し使われる実装アプローチ |
| `.memory/review_feedback.md` | 過去のレビューサイクルからのフィードバック |
| `.memory/failure_records/` | セルフヒーリングループの構造化失敗記録 |

これらのファイルは人間が読める形式で、エージェントの動作を修正するために直接編集することもできます。

---

## デバッグのヒント

### まずドライランで検証

```sh
aes run <spec-name> --dry-run
```

ワークフローを実行せずに設定とスペック成果物を検証します。フル実行前に設定の欠落やスペックファイルの不足を検出できます。

### 完全なイベントログを取得

```sh
aes run <spec-name> --log-json /tmp/debug-$(date +%s).ndjson
```

`jq` で検査:

```sh
cat /tmp/debug-*.ndjson | jq 'select(.event == "phase:failed")'
```

### 実装ループログの検査

```sh
ls .aes/logs/
cat .aes/logs/implementation-loop-<planId>.ndjson | jq 'select(.type == "section:halted")'
```

### クラッシュ後のワークフロー状態確認

```sh
cat .aes/state/<spec-name>.json
```

再開:

```sh
aes run <spec-name> --resume
```

### エージェントメモリの確認

```sh
cat .memory/project_rules.md
cat .memory/failure_records/*.json
```

セルフヒーリングの失敗記録はここに書き込まれます。エージェントがループから抜け出せない場合は、まずこれらの記録を確認してください。

---

## センシティブデータのリダクション

256文字を超えるツール入力はログに書き込まれる前にリダクションされます。
これにより大きなファイル内容やAPIレスポンスによるログの肥大化を防ぎ、センシティブなコンテンツの漏洩リスクを低減します。

完全なツール入力・出力はライブ実行中のエージェントのインメモリ `observations` 配列で利用可能ですが、そのままの形ではディスクに永続化されません。
