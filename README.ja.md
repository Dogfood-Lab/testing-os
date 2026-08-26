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
[![dogfood](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/dogfood-lab/testing-os/main/indexes/badges/dogfood-lab--testing-os--cli.json)](https://dogfood-lab.github.io/testing-os/handbook/read-model/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

**AI時代におけるテストのためのオペレーティングシステム**

*AIによる支援を受けたソフトウェアのためのプロトコル、証拠ストア、および学習ループ。*

<!-- version:start -->
**v1.11.0** — 現在のリリース。変更点は[CHANGELOG.md](CHANGELOG.md)を参照してください。
<!-- version:end -->

📖 **[ハンドブックを読む →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div>

---

## これは何ですか？

`testing-os`は、AIネイティブなワークフローで、リポジトリの実際のテスト証拠を記録、検証し、そこから学習します。リポジトリを指定すると、すべてのテスト実行が、信頼できるProvenance（出所）が確認されたレコードとなり、自己申告による合格ではなくなります。

得られるもの：

- **Provenance（出所）が確認されたレコード。** すべての送信は、受け入れられる前に、実際のCI実行にバインドされます（プロバイダー自身のIDを使用して、キーレス）。その結果、改ざん防止機能があり、追記のみが許可される証拠ストアとなり、単なる「合格」のチェックマークではありません。
- **制御可能なポリシー契約。** YAMLで、「検証済み」と見なすものを宣言します。これは、境界のある、評価を含まない述語DSL（`field`/`op`/`value` + `all`/`any`/`not`/`implies`）であり、リポジトリ全体で強制することができます。ポリシーをリリースする前に、`dogfood-verify lint`を使用してlintを実行します。
- **並列エージェントスウォームプロトコル。** コードベースに対してマルチエージェント監査を実行し、次に生の調査結果を再利用可能なパターンとドクトリンに変換します。
- **ライブステータスサーフェス。** リポジトリごとのレコード、インデックス、およびステータスバッジはすべて、1つの証拠ストアから提供されます。

これは、[Dogfood Lab](https://github.com/dogfood-lab)組織の主要なモノリポジトリであり、7つの`@dogfood-lab/*`パッケージが1つの`swarm`CLIにまとめられています。

## クイックスタート

```bash
npm install -g @dogfood-lab/dogfood-swarm
swarm --help
```

独自のレポジトリのテスト証拠をここに記録したいですか？ **[`examples/`スターターキット](examples/)**を使用すると、5分で送信を開始できます（`dogfood-report`が送信を作成し、`dogfood-init`がワークフローを構築します）。オペレーターガイド、CLIリファレンス、スキーマリファレンス、および統合レシピは、**[ハンドブック](https://dogfood-lab.github.io/testing-os/handbook/)**にあります。バージョンごとの詳細は、[CHANGELOG.md](CHANGELOG.md)に記載されています。

## 脅威モデル

testing-osは、`mcp-tool-shop-org/*`と`dogfood-lab/*`の下にある信頼できるGitHubリポジトリから、`repository_dispatch`を介して送信されたdogfoodの提出物を処理します。検証者はCIのProvenance（出所）を必要とします。主張された実行IDはプロバイダーのAPIによって確認され、形式が正しくない、参照が欠落している、または無効なポリシーの主張を含む送信物は拒否されます。

**Provenance（出所）が認証です。** `github`の提出物について、検証者は、主張されたGitHub Actions実行が実際に存在すること（GitHub API）を確認し、提出物の`repo`と`commit_sha`をその確認された実行にバインドします。これはライブでキーレスなチェックであり、GitHub自身のOIDC IDに基づいています。したがって、レコードは、実際には発生しなかった実行またはコミットに対して認証することはできません。**GitLab CI**はオプションでサポートされています（`source.provider: gitlab`）。GitLabの提出物は、検証者が非GitHubホストに呼び出す唯一の場合であり、（`gitlab.com/api`）、および`gitlab`の送信物のみです。

**レコードの整合性は改ざん防止機能があり、完全に保護されているわけではありません。** 永続化されたすべてのレコードには、`integrity`ブロック（`submission_digest` + `prev_digest`）が含まれており、これは追記のみが許可されるハッシュチェーンを形成し、`node packages/ingest/run.js --verify-chain`によってオフラインで完全に検証されます。これにより、外部からの改ざん、ディスクの破損、および部分的な復元を検出できます。ただし、これはレコード自体とチェーンの両方を書き換えることができるインジェスト認証に対しては保護しません。これを解決するには、ライターの制御外にあるアンカーが必要です。**オプションでデフォルトでは無効になっているXRPLアンカー**（`node packages/ingest/run.js --anchor-*`）は、チェーンヘッダーをパブリックXRP Ledgerに記録し、アンカーポイントより下の切り捨てまたは書き換えを検出できるようにします。これは、開示された2番目の非GitHub呼び出しであり、オペレーターが有効にした場合にのみ行われます。

**testing-osが扱うもの：** 各`repository_dispatch`ペイロード内の送信JSON。このリポジトリ内の`policies/`、`fixtures/`、`records/`、`indexes/`、および`dogfood/roadmap/`（後者はオペレーターが呼び出す`swarm roadmap compile`によってのみ書き込まれ、自動化されたインジェストパスでは決して書き込まれません）。Provenance（出所）検証のための`api.github.com`へのアウトバウンド呼び出し。および — `github`の提出物のみ — 認証されたコミットにおける送信元リポジトリの`dogfood/scenarios/<scenario_id>.yaml`の読み取り専用フェッチ（必須ステップの強制を支えるシナリオ定義。サイズ上限付きで、使用前にスキーマ検証され、ファイルが存在しない場合はそのチェックは強制されず、目に見える警告が表示されます）。

**testing-osが扱わないもの：**宣言された`dogfood/scenarios/`定義ファイルを超えた消費者のソースコード、消費者のリポジトリ内の送信エンベロープを超える秘密情報、またはこのリポジトリのワーキングツリー外にあるもの。

**調査状態遷移は証拠があり、追記のみが許可されます。** スウォーム制御プレーンのクロージャ動詞（`swarm reopen`、`swarm close`）には、明示的な理由と証拠が必要であり、オペレーターによるクロージャの場合には、宣言された検証モードも必要です。すべての遷移は、実行権限を記録する不変の`finding_events`行に書き込まれます。自動化されたパスでは、陳腐化によって調査を閉じたり、予測によって再開したりすることはできず、どの動詞もイベント履歴を書き換えることはできません。誤って使用された認証情報は、遷移を追加できますが、各追加は記録されます。

**ネットワークインターフェース。** デフォルトでは、唯一の送信先は`api.github.com`です（読み取り専用：プロベナンス確認 + 上記のシナリオ定義の取得）。例外となるのは2つだけで、どちらもオプトイン方式であり、上記で説明されています。GitLabプロバイダーによる提出（`gitlab.com/api`）、およびオペレーターが有効にしたXRPLアンカー実行です。**テレメトリーや分析は行いません。このコードベースは外部に情報を送信しません。上記の2つのオプトインパスがない場合、GitHubを超えてネットワークインターフェースを公開することはありません。** 受信ワークフローは、このリポジトリのみを対象として`contents: write`で実行されます。

## パッケージ

| パッケージ | ソース | 目的 |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | 8つのJSONスキーマ（レコード、検出結果、パターン、推奨事項、ドクトリン、ポリシー、シナリオ、提出）。 |
| `@dogfood-lab/verify` | JS | 中央の提出バリデーター。提出物は、永続化される前にここを通過します。 |
| `@dogfood-lab/findings` | JS | 検出契約 + 派生/レビュー/統合/アドバイス パイプライン。 |
| `@dogfood-lab/ingest` | JS | パイプラインの連携：ディスパッチ → 検証 → 永続化 → インデックス作成。 |
| `@dogfood-lab/report` | JS | ソースリポジトリ用の提出ビルダー。 |
| `@dogfood-lab/portfolio` | JS | クロスリポジトリポートフォリオジェネレーター。 |
| `@dogfood-lab/dogfood-swarm` | JS | 10段階の並列エージェントプロトコル + SQLiteコントロールプレーン + `swarm`バイナリ。 |

**独立性を維持しながら、公開APIを通じて統合する**関連テストツール：[`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck)、[`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge)、[`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp)、[`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine)、[`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab)。

## レイアウト

```
testing-os/
├── packages/                  # 7 workspace packages (@dogfood-lab/*)
├── site/                      # Astro Starlight handbook → dogfood-lab.github.io/testing-os/handbook/
├── swarms/                    # Swarm-run artifacts + control-plane.db
├── indexes/                   # Generated read API: latest-by-repo.json, failing.json, stale.json, trends.json, badges/ (shields.io endpoints)
├── policies/                  # Policy YAML by repo
├── records/                   # Submission landing pad (ingest.yml writes here)
├── fixtures/                  # Test/example fixtures
├── docs/                      # Contract docs + architecture notes
├── examples/                  # Copy-paste consumer starter kit (dogfood.yml + scenario + policy)
├── scripts/                   # Repo-level utilities (sync-version, build)
└── .github/workflows/         # ci.yml, ingest.yml, pages.yml, release.yml, self-dogfood.yml
```

## ローカル開発

```bash
git clone https://github.com/dogfood-lab/testing-os.git
cd testing-os
npm install
npm run build       # tsc --build across all packages
npm test            # vitest for schemas, node --test for the rest
npm run verify      # version-sync + doc-drift + regression-pin gates + build + tests (canonical pre-commit check — NOT the same as build && test)
```

Node ≥ 22が必要です。CIマトリックスは、`ubuntu-latest`でNode 22 + 24を実行します。ローカルではNode 25で検証されています。

**サポートされているファイルシステム：** APFS、HFS+、ext4（CIベースライン）、NTFS — POSIX `link(2)`を実装しているもの。**サポート対象外：** exFAT、FAT32。[`packages/findings/lib/file-lock.js`](packages/findings/lib/file-lock.js)のファイルロックCASは、アトミックな公開のためにハードリンクセマンティクスが必要です。exFATの場合、`linkSync`は`ENOTSUP`をスローします（大きなエラーメッセージが表示されますが、サイレントではありません）。一般的な注意点：クロスプラットフォームの外部SSDは、多くの場合exFATでフォーマットされています。リポジトリをローカルのAPFS/HFS+にクローンしてください。完全なSession G検証マトリックスについては、[`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md)を参照してください。

## バージョン管理

All `@dogfood-lab/*` packages bump together — one number across the monorepo. Six packages publish to npm under `@dogfood-lab` at v1.11.0 in lockstep (`schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`); the seventh, `@dogfood-lab/portfolio`, stays internal. The version line near the top of this README is auto-stamped from `package.json` via [`scripts/sync-version.mjs`](scripts/sync-version.mjs) on every `npm run build`.

## ライセンス

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[ハンドブック](https://dogfood-lab.github.io/testing-os/handbook/)** · **[すべてのリポジトリ](https://github.com/orgs/dogfood-lab/repositories)** · **[プロフィール](https://github.com/dogfood-lab)**

*まず食べて、次にリリースする。*

</div>
