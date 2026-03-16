<!-- SSOT: high-level SDD workflow summary (numbered list form).
     Included by: 
       docs/ja/vision.md,
       docs/ja/workflow/spec-driven-workflow.md
     Edit only this file when the summary workflow steps change. -->

1. spec-init *(llm slash command)*
2. 人間によるインタラクション *(ユーザー入力)*
3. 前提条件の検証 *(llm prompt)*
4. 要件定義 *(llm slash command)*
5. 要件の検証 *(llm prompt)*
6. 既存情報への振り返り *(llm prompt)*
7. ギャップ検証 *(llm slash command: オプション)*
8. **`/clear` slash command** — 設計フェーズ前にコンテキストをリセット
9. 設計 *(llm slash command)*
10. 設計の検証 *(llm slash command: オプション)*
11. 既存情報への振り返り *(llm prompt)*
12. **`/clear` slash command** — タスク生成前にコンテキストをリセット
13. タスク生成 *(llm slash command)*
14. タスクの検証 *(llm prompt)*
15. **`/clear` slash command** — 実装前にコンテキストをリセット
16. 実装ループ *(タスクグループごとに繰り返す)*：
    - spec-impl *(llm slash command)*
    - validate-impl *(llm prompt)*
    - コミット *(git command)*
    - **`/clear` slash command** — 次のタスクグループ前にコンテキストをリセット
17. プルリクエスト作成 *(git command)*
