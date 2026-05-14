<p align="center">
  <a href="README.md">English</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
</p>

<p align="center">
  <img src="./assets/logo.png" alt="testing-os" width="280">
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
**v1.2.0** — `@dogfood-lab/*` パッケージ6つ、ワークスペース全体のテストスイート、インジェスト受信機能の実装、ハンドブックのデプロイ。
<!-- version:end -->

📖 **[ハンドブックを読む →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div

---

## このプロジェクトについて

`testing-os` は、[Dogfood Lab](https://github.com/dogfood-lab) GitHub組織の主要なモノレポです。これは、現在アーカイブされている [`mcp-tool-shop-org/dogfood-labs`](https://github.com/mcp-tool-shop-org/dogfood-labs) の後継です。このプロジェクトは、AIを活用した開発ワークフローでテストを実行、記録し、学習するためのプロトコルとインフラストラクチャをまとめて提供します。

- コードベースに対して並列エージェントによる監査を実行するための **スウォームプロトコル**。
- 記録、結果、パターン、推奨事項を保存するための **証拠保存とスキーマ**。
- 「検証済み」とみなされるものを決定し、それをすべての関連リポジトリに適用する **ポリシーと検証機能**。
- 生のデータから再利用可能なパターンと原則を生成する **インテリジェンスレイヤー**。

## 状態

**v1.2.0** — `@dogfood-lab/*` モノレポの最初のnpm公開。`schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm` (主要な`swarm` CLI) の6つのパッケージが、`@dogfood-lab` スコープで公開されています。このリリースで新たに追加された機能：ウェーブレベルの状態マシン、Three R's 回復契約 (`swarm revalidate`, `swarm rewind`, `swarm redrive`)、`swarm history` による監査トレイル機能、Stage A–D の健全性チェック (0 CRIT / 0 HIGH)。**1105/1105 テスト**。v1.0.0 以降の累積的なテスト数 (2026年4月25日時点): 上記の機能に加え、Phase 7 dogfood swarm (~31ウェーブ、~115件の検証済み修正、14種類の監査範囲)。公式スウォームカタログ: [`docs/swarm-evidence-2026-04-27.md`](docs/swarm-evidence-2026-04-27.md)。

受信機能は稼働中です。コンシューマーリポジトリの `dogfood.yml` ワークフローがこのリポジトリに送信され、[`.github/workflows/ingest.yml`](.github/workflows/ingest.yml) が、結果の記録とインデックスを `main` ブランチにコミットします。ハンドブックは [dogfood-lab.github.io/testing-os/](https://dogfood-lab.github.io/testing-os/) で公開されています。インストール方法: `npm install -g @dogfood-lab/dogfood-swarm`。受信機能は、コンシューマーリポジトリから送信される形式で利用されます。詳細は、ハンドブックの「統合」セクションを参照してください。

**プラットフォーム:** Darwin/APFS上でエンドツーエンドの検証済み (Session G の一部として、[`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md) を参照)。サポートされているファイルシステムについては、[Local Development](#local-development) を参照してください。各バージョンに関する詳細は、[CHANGELOG.md](CHANGELOG.md) に記載されています。

## 脅威モデル

`testing-os` は、`mcp-tool-shop-org/*` および `dogfood-lab/*` の信頼できるGitHubリポジトリから `repository_dispatch` を使用して送信された dogfood データを処理します。検証機能は、GitHub Actions の認証情報を必要とします。主張された実行 ID は、GitHub API を使用して確認され、不正な形式、参照の欠落、または無効なポリシーの主張を含む送信は拒否されます。

`testing-os` が扱うデータ: 各 `repository_dispatch` ペイロードに含まれる送信 JSON データ; このリポジトリ内の `policies/`, `fixtures/`, `records/`, および `indexes/` ディレクトリ; `api.github.com` へのアウトバウンド呼び出し (認証情報の検証用)。

**testing-os が扱わないもの:** ユーザー向けのソースコード、ユーザーリポジトリ内の、ディスパッチ範囲を超える機密情報、およびこのリポジトリのワーキングツリー外にあるもの。

**必要な権限:** レシーバーワークフローは、このリポジトリのみに限定された `contents: write` スコープで実行されます。 プロヴェナンス検証では、ワークフローのデフォルトの `GITHUB_TOKEN` を使用して、読み取り専用の Actions API への呼び出しを行います。 **テレメトリー、サードパーティサービス、分析機能は一切ありません。このコードベースは、外部サーバーへの通信を行わず、GitHub 以外のネットワークへの接続も許可しません。**

## パッケージ

| パッケージ | ソース | 目的 |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | 8つの JSON スキーマ (record, finding, pattern, recommendation, doctrine, policy, scenario, submission)。 |
| `@dogfood-lab/verify` | JS | 中央のサブミッションバリデータ。サブミッションは、永続化される前にここを経由します。 |
| `@dogfood-lab/findings` | JS | ファインディング契約 + derive/review/synthesis/advise パイプライン。 |
| `@dogfood-lab/ingest` | JS | パイプラインの連携: dispatch → verify → persist → index。 |
| `@dogfood-lab/report` | JS | ソースリポジトリ用のサブミッションビルダー。 |
| `@dogfood-lab/portfolio` | JS | クロスリポジトリポートフォリオジェネレーター。 |
| `@dogfood-lab/dogfood-swarm` | JS | 10段階の並列エージェントプロトコル + SQLite コントロールプレーン + `swarm` バイナリ。 |

**独立**性を保ちながら、公開された API を介して統合される、関連するテストツール: [`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck), [`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge), [`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp), [`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine), [`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab)。

## レイアウト

```
testing-os/
├── packages/                  # 7 workspace packages (@dogfood-lab/*)
├── site/                      # Astro Starlight handbook → dogfood-lab.github.io/testing-os/handbook/
├── swarms/                    # Swarm-run artifacts + control-plane.db
├── indexes/                   # Generated read API: latest-by-repo.json, failing.json, stale.json
├── policies/                  # Policy YAML by repo
├── records/                   # Submission landing pad (ingest.yml writes here)
├── fixtures/                  # Test/example fixtures
├── docs/                      # Contract docs + architecture notes
├── scripts/                   # Repo-level utilities (sync-version, build)
└── .github/workflows/         # ci.yml, ingest.yml, pages.yml
```

## ローカル開発

```bash
git clone https://github.com/dogfood-lab/testing-os.git
cd testing-os
npm install
npm run build       # tsc --build across all packages
npm test            # vitest for schemas, node --test for the rest
npm run verify      # build + test (canonical pre-commit check)
```

Node ≥ 20 が必要です。CI マトリックスでは、Node 20 と 22 を `ubuntu-latest` で実行し、ローカルでは Node 25 で検証します。

**サポートされているファイルシステム:** APFS, HFS+, ext4 (CI のベースライン), NTFS — POSIX の `link(2)` を実装しているもの。 **サポートされていないもの:** exFAT, FAT32。 [`packages/findings/lib/file-lock.js`](packages/findings/lib/file-lock.js) にあるファイルロック CAS は、アトミックな公開のためにハードリンクのセマンティクスを必要とします。exFAT では、`linkSync` が `ENOTSUP` エラーを発生させます (サイレントではなく、エラーが発生します)。よくある問題: クロスプラットフォームの外部 SSD は、多くの場合 exFAT でフォーマットされています。リポジトリをローカルの APFS/HFS+ にクローンしてください。完全なセッション G 検証マトリックスについては、[`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md) を参照してください。

## バージョン管理

すべての `@dogfood-lab/*` パッケージで一貫したバージョンを使用します。バージョンは、この README のバージョン行で、`scripts/sync-version.mjs` (prebuild として実行) を使用して `package.json` から自動的に更新されます。 **v1.2.0** 以降、`schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm` の 6 つのパッケージが、`@dogfood-lab` スコープで npm に公開されています。7 番目のパッケージ (`@dogfood-lab/portfolio`) は、モノリポジトリ内で使用されます。

## ライセンス

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[マニュアル](https://dogfood-lab.github.io/testing-os/handbook/)** · **[すべてのリポジトリ](https://github.com/orgs/dogfood-lab/repositories)** · **[プロフィール](https://github.com/dogfood-lab)**

*まず食べる。次に、リリースする。*

</div
