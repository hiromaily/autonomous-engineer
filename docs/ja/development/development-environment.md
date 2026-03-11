# 開発環境

## 概要

Autonomous Engineerは、パフォーマンス、一貫性、AI支援開発との互換性のために設計された最新の開発ツールチェーンを使用しています。

環境は以下を優先します：

- 決定論的なビルド
- 高速な実行
- 最小限のツーリング複雑さ
- TypeScriptとRustとの互換性

このドキュメントはプロジェクトの公式にサポートされた開発環境を定義します。

---

## ランタイムとパッケージマネージャー

プロジェクトはランタイムとパッケージマネージャーの両方として**Bun**を使用します。

Bunはパッケージ管理、スクリプト実行、TypeScriptサポートのための組み込みツーリングを持つ高性能なJavaScriptランタイムを提供します。

このプロジェクトで使用されるバージョン：

```
bun v1.3.10
```

公式ウェブサイト：

https://bun.sh

Bunを選択した主な理由：

- 非常に高速な起動と実行
- 組み込みのパッケージマネージャー
- ネイティブのTypeScriptサポート
- Node.jsエコシステムとの互換性
- Node + npm/pnpmと比較してシンプルなツーリング

すべてのプロジェクトスクリプトはBunを使用して実行すべきです。

例：

```
bun install
bun run build
bun run dev
```

---

## TypeScript

システムのプライマリ言語はTypeScriptです。

バージョン：

```
TypeScript 5.9.3
```

TypeScriptは以下に使用されます：

- コアシステムロジック
- ワークフローエンジン
- AI調整
- CLIインターフェース
- アダプター実装

推奨されるコンパイラー設定：

```
strict: true
noUncheckedIndexedAccess: true
exactOptionalPropertyTypes: true
```

これらの設定により型安全性が向上し、ランタイムエラーが削減されます。

---

## Rust

Rustはパフォーマンスクリティカルなコンポーネントに使用されます。

Rustモジュールが担当する可能性があります：

- メモリインデックス作成
- セマンティック検索
- コンテキストフィルタリング
- 知識取得

このプロジェクトで使用されるRustエディション：

```
Rust 2024 Edition
```

RustコンポーネントはTypeScriptシステムと以下を使用して統合されることがあります：

- napi-rs
- WebAssembly

これにより、ほとんどのシステムロジックをTypeScriptに保ちながら高性能な操作が可能になります。

---

## TypeScriptとRustの役割分担

TypeScriptとRustはシステム内で明確に異なる目的を持ちます。

| 関心事 | TypeScript | Rust |
|---|---|---|
| コアビジネスロジック | ✓ | |
| ワークフロー orchestration | ✓ | |
| AI/LLMインタラクション | ✓ | |
| CLIインターフェース | ✓ | |
| アダプター実装 | ✓ | |
| メモリインデックス作成 | | ✓ |
| セマンティック検索 | | ✓ |
| コンテキスト差分計算 | | ✓ |
| 知識取得 | | ✓ |

基本方針：まずTypeScriptで実装する。パフォーマンスプロファイリングで具体的なボトルネックが確認された場合のみRustに移行する。

---

## リント

リントは**Biome**を使用して実行されます。

BiomeはJavaScriptとTypeScriptのための高速で信頼性の高いリントを提供するRustベースのツールです。

ツール：

```
biome
```

Biomeを選択した理由：

- Rustで書かれている
- 従来のリンターより大幅に高速
- 統合されたリントエコシステム
- 最新のJavaScriptサポート

Biomeは以下の検出を担当します：

- コード品質の問題
- 安全でないパターン
- スタイルの不一致

---

## フォーマット

コードフォーマットは**dprint**を使用して実行されます。

ツール：

```
dprint
```

dprintを選択した理由：

- Rustで書かれている
- 非常に高速
- 決定論的なフォーマット
- 安定したフォーマットルール

dprintはリポジトリ全体でコードフォーマットが一貫していることを確保します。

---

## パッケージ管理

依存関係管理はBunによって処理されます。

コマンド例：

依存関係のインストール：

```
bun install
```

依存関係の追加：

```
bun add <package>
```

スクリプトの実行：

```
bun run <script>
```

Bunを使用することで、従来のNode環境と比較して依存関係管理が簡略化されます。

---

## Anthropic AI SDK

プロジェクトは公式のTypeScript向けAnthropicSDKを通じてClaudeモデルと連携します。

このプロジェクトで使用されるバージョン：

```
@anthropic-ai/sdk 0.78.0
```

このバージョンが提供する機能：

- Bun 1.0+ ランタイムの明示的なサポート
- ピア依存関係として `zod ^3.25.0`（ランタイム依存関係としても使用）
- Claudeプロバイダーアダプターが使用する `client.messages.create()` API

SDKはランタイム依存関係としてインストールされます：

```
bun add @anthropic-ai/sdk
```

---

## リポジトリ構造

プロジェクトはClean ArchitectureおよびHexagonal Architectureの原則に沿ったモジュラーなディレクトリ構造を採用しています。

正式な全体構造については[アーキテクチャ — ディレクトリ構造](/ja/architecture/architecture#directory-structure)を参照してください。

```
autonomous-engineer/
├─ cli/
│
├─ application/
│  ├─ usecases/
│  ├─ facades/
│  └─ ports/
│
├─ domain/
│  ├─ engines/
│  ├─ workflow/
│  ├─ memory/
│  └─ self-healing/
│
├─ adapters/
│  ├─ sdd/
│  └─ llm/
│
├─ infra/
│  ├─ git/
│  └─ filesystem/
│
├─ docs/
│
├─ package.json
├─ tsconfig.json
└─ README.md
```

この構造はClean Architectureの各層に直接対応しており、コアロジックを外部依存から独立した状態に保ちます。

---

## 開発哲学

開発環境はAI支援開発をサポートするよう設計されています。

主要原則：

### 高速フィードバックループ

ツーリングは頻繁なAI生成の変更をサポートするために高速でなければなりません。

### 決定論的出力

フォーマットとリントは一貫した結果を生成しなければなりません。

### 最小限の設定

ツーリングの複雑さは開発者とAIエージェントの両方の摩擦を削減するために最小化すべきです。

### AIフレンドリーな構造

明確な構造と決定論的なツーリングはAIシステムがより良いコードを生成するのに役立ちます。

---

## まとめ

Autonomous Engineerの開発環境は最新の高性能ツールを中心に構築されています。

コア技術：

```
ランタイム: Bun v1.3.10
言語: TypeScript 5.9.3
システム言語: Rust（Edition 2024）
リンター: Biome
フォーマッター: dprint
AI SDK: @anthropic-ai/sdk 0.78.0
```

このスタックは自律エンジニアリングシステムを構築するための高速で一貫したAIフレンドリーな開発環境を提供します。
