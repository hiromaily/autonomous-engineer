# 自動化ワークフロー

## 概要

このドキュメントでは、Autonomous Engineer システムにおけるユーザーと AI 駆動の自動化の役割分担を説明します。目標は日常的な開発作業を排除することです — ユーザーは開始時と終了時のみ関与し、AI がその間のすべてを処理します。

**ユーザーの関与箇所**: 初期コンテキスト準備 + 最終 PR レビュー。

**AI が自動化**: ブランチ作成、仕様生成、レビューループ、承認、実装、コミット、PR 作成。

---

## ワークフロー全体図

```mermaid
flowchart TD
    H1["👤 ユーザー: 前提ドキュメントを整理"] --> H2
    H2["👤 ユーザー: /kiro:spec-init + requirements.md の Project Description を編集"] --> BRANCH_CHECK

    subgraph AUTO ["🤖 自動化"]
        BRANCH_CHECK{フィーチャーブランチは\n既に存在する?}
        BRANCH_CHECK -->|いいえ| BRANCH_CREATE["フィーチャーブランチ作成\nfeature/spec-{spec-name}"]
        BRANCH_CHECK -->|はい| BRANCH_CONFIRM["確認: 既存ブランチで\n続行しますか? [Y/n]"]
        BRANCH_CREATE --> REQ
        BRANCH_CONFIRM --> REQ

        subgraph SPEC_PHASE ["仕様フェーズ"]
            REQ["/kiro:spec-requirements"] --> REQ_LOOP
            subgraph REQ_LOOP ["レビューループ（最大 N 回）"]
                REQ_R["AI が requirements.md をレビュー"] --> REQ_F["AI が問題を修正"]
                REQ_F --> REQ_R
            end
            REQ_LOOP --> REQ_OK["承認: spec.json\nrequirements.approved = true"]
            REQ_OK --> REQ_KNOW["AI が学習内容を\nsteering/rules に記録"]
            REQ_KNOW --> REQ_CLR["/clear"]

            REQ_CLR --> DESIGN["/kiro:spec-design"] --> VAL_D["/kiro:validate-design"] --> DESIGN_LOOP
            subgraph DESIGN_LOOP ["レビューループ（最大 N 回）"]
                DESIGN_R["AI が design.md をレビュー"] --> DESIGN_F["AI が問題を修正"]
                DESIGN_F --> DESIGN_R
            end
            DESIGN_LOOP --> DESIGN_OK["承認: spec.json\ndesign.approved = true"]
            DESIGN_OK --> DESIGN_KNOW["AI が学習内容を\nsteering/rules に記録"]
            DESIGN_KNOW --> DESIGN_CLR["/clear"]

            DESIGN_CLR --> TASKS["/kiro:spec-tasks"] --> TASKS_LOOP
            subgraph TASKS_LOOP ["レビューループ（最大 N 回）"]
                TASKS_R["AI が tasks.md をレビュー"] --> TASKS_F["AI が問題を修正"]
                TASKS_F --> TASKS_R
            end
            TASKS_LOOP --> TASKS_OK["承認: spec.json\ntasks.approved = true"]
            TASKS_OK --> TASKS_KNOW["AI が学習内容を\nsteering/rules に記録"]
            TASKS_KNOW --> TASKS_CLR["/clear"]
        end

        TASKS_CLR --> COMMIT_SPEC["仕様アーティファクトをコミット"]
        COMMIT_SPEC --> COMMIT_CLR["/clear"]

        COMMIT_CLR --> IMPL_LOOP

        subgraph IMPL_LOOP ["実装ループ"]
            IMPL["/kiro:spec-impl {タスクグループ}"] --> IMPL_R["AI がコードをレビュー & 修正"]
            IMPL_R --> IMPL_C["コミット"]
            IMPL_C --> IMPL_KNOW["AI が学習内容を\nsteering/rules に記録"]
            IMPL_KNOW --> IMPL_CLR["/clear"]
            IMPL_CLR --> IMPL_MORE{残タスクあり?}
            IMPL_MORE -->|yes| IMPL
        end

        IMPL_MORE -->|no| PR["Pull Request を作成"]
    end

    PR --> H3["👤 ユーザー: PR をレビュー"]
```

---

## ユーザーの責任

### 自動化開始前

| ステップ | アクション                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------------- |
| 1        | 前提情報を `docs/` に整理する                                                                         |
| 2        | `/kiro:spec-init "説明"` を実行して仕様ディレクトリを作成する                                         |
| 3        | `requirements.md` の **Project Description (Input)** セクションを十分なコンテキストで編集する        |

生成される仕様の品質は、ステップ 3 の記述の質に直接依存します。AI は書かれていない意図を推測できません。

> **将来のアイデア**: `/kiro:spec-design` に進む前に、`requirements.md` に十分な情報が含まれているかを確認する事前検証ステップの追加。

### 自動化完了後

| ステップ | アクション                                          |
| -------- | --------------------------------------------------- |
| 4        | 自動化が作成したプルリクエストをレビューする        |

中間フェーズ（要件、設計、タスク、実装）はすべてユーザーの介入なしに AI が承認します。PR が唯一のユーザーによるレビューゲートです。

---

## ブランチ命名

仕様作業を開始する前に、自動化は専用のフィーチャーブランチを作成します。デフォルトのパターンは：

```text
feature/spec-{spec-name}
```

ブランチ命名規則は設定可能です。自動化は以下を行う必要があります：

1. 現在のブランチを検出する
2. `main` または `master` の場合は処理を拒否する
3. 対象のフィーチャーブランチが既に存在するか確認する
4. ブランチが存在する場合は、ユーザーにインタラクティブに確認を求める
5. それ以外の場合はフィーチャーブランチを作成してチェックアウトする

---

## レビューループのパターン

3 つの仕様フェーズ（要件、設計、タスク）はすべて同じレビュー & 修正ループを使用します。`/clear` の前に、AI はコンテキストリセットをまたいだ知識消失を防ぐために学習内容を記録します：

```mermaid
flowchart TD
    GEN["アーティファクトを生成"] --> REVIEW["AI がアーティファクトをレビュー"]
    REVIEW --> RESULT{問題あり?}
    RESULT -->|なし| APPROVE["承認\nspec.json の approved = true を更新"]
    RESULT -->|あり — 単一の修正| FIX["AI が修正を適用"]
    RESULT -->|あり — 複数の選択肢| SELECT["AI が最適な選択肢を選んで\n修正を適用"]
    FIX --> ITER{繰り返し上限\n到達?}
    SELECT --> ITER
    ITER -->|いいえ| REVIEW
    ITER -->|はい| APPROVE
    APPROVE --> KNOW["AI が学習内容を\nsteering/rules に記録"]
    KNOW --> CLR["/clear"]
```

**主なルール:**

- AI は常に具体的なアクションに解決します — 問題を報告するだけで修正しないことはありません
- 複数の修正選択肢がある場合、AI はシステムアーキテクチャと技術に照らして最適なものを選択します
- ループには設定可能な最大繰り返し回数があります（推奨デフォルト: 2 回）
- ループ後、AI は対応するフェーズの `spec.json` に `approved: true` を書き込みます
- `/clear` の前に、AI は蓄積した学習内容を永続リソースに記録します（[コンテキストリセット前の知識記録](#コンテキストリセット前の知識記録)を参照）
- `/clear` は各フェーズ承認後に実行され、コンテキストが次のフェーズに持ち越されるのを防ぎます

---

## 実装ループ

すべての仕様アーティファクトが承認・コミットされてコンテキストがクリアされた後、実装ループが始まります。各タスクグループに対して：

```mermaid
flowchart LR
    IMPL["/kiro:spec-impl\nタスクグループ"] --> REVIEW["AI がコードを\nレビュー & 修正"]
    REVIEW --> COMMIT["変更をコミット"]
    COMMIT --> KNOW["AI が学習内容を\nsteering/rules に記録"]
    KNOW --> CLEAR["/clear"]
    CLEAR --> NEXT{残タスク\nあり?}
    NEXT -->|yes| IMPL
    NEXT -->|no| PR["PR を作成"]
```

1. **`/kiro:spec-impl {タスクグループ}`** — エージェントが指定タスクを実装
2. **AI レビュー & 修正** — 設計ドキュメントと要件に対して自動レビュー；問題はインラインで修正
3. **コミット** — 説明的なメッセージで変更をコミット
4. **知識記録** — AI がコンテキストリセット前に蓄積した知見を永続化（[コンテキストリセット前の知識記録](#コンテキストリセット前の知識記録)を参照）
5. **`/clear`** — タスク間のコンテキスト汚染を防ぐためコンテキストをクリア
6. すべてのタスクが完了するまで繰り返す

---

## タスクバッチング: (P) マーカー

`tasks.md` で `(P)` マークが付いたタスクは、単一の `spec-impl` 呼び出しにまとめて処理できます：

```text
/kiro:spec-impl tool-system 3.1,3.2,3.3
```

タスクが `(P)` として適格となる条件の完全なルールについては、[cc-sdd 並列タスク分析](../frameworks/cc-sdd#並列タスク分析)を参照してください。

---

## コンテキストリセット前の知識記録

すべての `/clear` の前に、AI はコンテキストリセットをまたいだ知識消失を防ぐため、蓄積した知見を永続化しなければなりません。これは任意のステップではなく、必須のステップです。

**記録すべき内容:**

- 解決に複数の試みが必要だった調査経路や検索クエリ
- 将来のフェーズで重要となる、曖昧な要件や設計上の意思決定とその根拠
- フェーズ中に発見した再利用可能なパターン、規約、注意点
- 実装上の選択に影響したアーキテクチャのトレードオフ

**書き込み先:**

| リソース | パス | 用途 |
| -------- | ---- | ---- |
| Steering ドキュメント | `.kiro/steering/` | プロジェクト固有のパターン、技術スタックの知見、アーキテクチャ上の意思決定 |
| ルール | `.claude/rules/` | ワークフロールール、コード規約、繰り返し発生するプロセス上の問題の対処法 |
| スキル | `.claude/commands/` | フェーズ中に現れた再利用可能なプロンプトパターン |

**重要な制約**: **将来のフェーズやセッションをまたいで再利用できる**知見のみを記録します — 二度と発生しないタスク固有の状態は記録しません。

このメカニズムにより、各新規コンテキストウィンドウがこれまでのすべてのフェーズで蓄積された知識を引き継ぎ、`/clear` が本来引き起こす知識消失を防ぎます。

---

## 承認メカニズム

フェーズの承認は自動化によって `spec.json` に書き込まれます — 手動編集は不要です：

```json
{
  "approvals": {
    "requirements": { "generated": true, "approved": true },
    "design":       { "generated": true, "approved": true },
    "tasks":        { "generated": true, "approved": true }
  },
  "ready_for_implementation": true
}
```

3 つのフェーズがすべて承認されると `ready_for_implementation` フラグが `true` に設定され、実装ループが開始できるようになります。
