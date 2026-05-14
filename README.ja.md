<p align="center">
  <a href="README.md">English</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
</p>

<div align="center">

# testing-os

[![CI](https://github.com/dogfood-lab/testing-os/actions/workflows/ci.yml/badge.svg)](https://github.com/dogfood-lab/testing-os/actions/workflows/ci.yml)
[![Pages](https://github.com/dogfood-lab/testing-os/actions/workflows/pages.yml/badge.svg)](https://dogfood-lab.github.io/testing-os/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

**AI時代におけるテストのためのオペレーティングシステム**

*AIを活用したソフトウェア開発のためのプロトコル、証拠保存、学習ループ。*

<!-- version:start -->
**v0.2.0-pre** — 7つのパッケージ (`@dogfood-lab/*`)、ワークスペース全体のテストスイート、データ受信機能が稼働中、ハンドブックがデプロイ済み。
<!-- version:end -->

📖 **[ハンドブックを読む →](https://dogfood-lab.github.io/testing-os/)**

</div>

---

## このプロジェクトについて

`testing-os` は、[Dogfood Lab](https://github.com/dogfood-lab) GitHub組織の主要なモノレポです。これは、現在アーカイブされている [`mcp-tool-shop-org/dogfood-labs`](https://github.com/mcp-tool-shop-org/dogfood-labs) の後継です。このプロジェクトは、AIを活用した開発ワークフローでテストを実行、記録し、学習するためのプロトコルとインフラストラクチャをまとめて提供します。

- コードベースに対して並列エージェントで監査を実行するための **スウォームプロトコル**。
- 記録、発見事項、パターン、推奨事項を保存するための **証拠保存とスキーマ**。
- 「検証済み」とみなされるものを決定し、それを消費者リポジトリ全体で適用するための **ポリシーと検証機能**。
- 生の発見事項を再利用可能なパターンとドクトリンに変換する **インテリジェンスレイヤー**。

## ステータス

`mcp-tool-shop-org/dogfood-labs` からの移行が完了しました (2026年4月25日)。データ受信機能が稼働中です。消費者リポジトリの `dogfood.yml` ワークフローがこのリポジトリに送信され、[`.github/workflows/ingest.yml`](.github/workflows/ingest.yml) が結果の記録とインデックスを `main` ブランチにコミットします。ハンドブックは [dogfood-lab.github.io/testing-os/](https://dogfood-lab.github.io/testing-os/) にデプロイされています。v1.0.0 は、[HANDOFF.md](HANDOFF.md) に記載されている移行後の調整が完了次第リリースされます。

## パッケージ

| パッケージ | ソース | 目的 |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | 8つのJSONスキーマ (記録、発見事項、パターン、推奨事項、ドクトリン、ポリシー、シナリオ、送信)。 |
| `@dogfood-lab/verify` | JS | 中央の送信検証機能。送信データは永続化される前にここを経由します。 |
| `@dogfood-lab/findings` | JS | 発見事項の管理、分析、合成、推奨パイプライン。 |
| `@dogfood-lab/ingest` | JS | パイプラインの連携：送信 → 検証 → 永続化 → インデックス化。 |
| `@dogfood-lab/report` | JS | ソースリポジトリ用の送信ビルダー。 |
| `@dogfood-lab/portfolio` | JS | クロスリポジトリポートフォリオジェネレーター。 |
| `@dogfood-lab/dogfood-swarm` | JS | 10段階の並列エージェントプロトコル + SQLite 制御プレーン + `swarm` 実行ファイル。 |

**独立**しているものの、公開APIを介して統合される、関連するテストツール：[`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck), [`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge), [`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp), [`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine), [`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab)。

## 構成

```
testing-os/
├── packages/                  # 7 workspace packages (@dogfood-lab/*)
├── site/                      # Astro Starlight handbook → dogfood-lab.github.io/testing-os/
├── swarms/                    # Swarm-run artifacts + control-plane.db
├── indexes/                   # Generated read API: latest-by-repo.json, failing.json, stale.json
├── policies/                  # Policy YAML by repo
├── records/                   # Submission landing pad (ingest.yml writes here)
├── fixtures/                  # Test/example fixtures
├── docs/                      # Contract docs + architecture notes
├── scripts/                   # Repo-level utilities (sync-version, build)
└── .github/workflows/         # ci.yml, ingest.yml, pages.yml
```

## ローカル開発環境

```bash
git clone https://github.com/dogfood-lab/testing-os.git
cd testing-os
npm install
npm run build       # tsc --build across all packages
npm test            # vitest for schemas, node --test for the rest
npm run verify      # build + test (canonical pre-commit check)
```

Node ≥ 20 が必要です。

## バージョン管理

すべての `@dogfood-lab/*` パッケージで一貫したバージョン管理を行います。現在 `0.1.0-pre` です。最初の安定版は `1.0.0` で、[HANDOFF.md](HANDOFF.md) に記載されている移行後の調整が完了次第リリースされます。このREADMEに記載されているバージョンは、`scripts/sync-version.mjs` (ビルド時に実行される) によって `package.json` から自動的に更新されます。

## ライセンス

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[ハンドブック](https://dogfood-lab.github.io/testing-os/)** · **[すべてのリポジトリ](https://github.com/orgs/dogfood-lab/repositories)** · **[プロフィール](https://github.com/dogfood-lab)**

*まず試す。次にリリースする。*

</div>
