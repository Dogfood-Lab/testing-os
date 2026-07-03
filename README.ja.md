<p align="center">
  <a href="README.md">English</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
</p>

<p align="center">
  <img src="./assets/logo.png" alt="testing-os" width="280">
</p>

<div align="center">

# テスト用OS

[CI](https://github.com/dogfood-lab/testing-os/actions/workflows/ci.yml/badge.svg)
[Pages](https://github.com/dogfood-lab/testing-os/actions/workflows/pages.yml/badge.svg)
[dogfood](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/dogfood-lab/testing-os/main/indexes/badges/dogfood-lab--testing-os--cli.json)
[License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
[Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)

**AI時代におけるテスト用のオペレーティングシステム**

*AIを活用したソフトウェアにおける、プロトコル、証拠データの保存方法、および学習サイクル。*

**バージョン1.9.0** ― 現在のリリース版です。変更点については、[CHANGELOG.md](CHANGELOG.md) をご覧ください。

📖 **[ハンドブックを読む →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div>

---

## これは何ですか

「testing-os」は、AIを活用したワークフローで、リポジトリ内の実際のテスト結果を記録し、検証し、そこから学習します。リポジトリを指定するだけで、すべてのテスト実行が信頼できる情報源によって確認された記録となり、自己申告による合格というだけのものではありません。

特典：

- **真正性を確認済みの記録。** 各提出物は、承認される前に、実際のCI実行に紐付けられます。これは、プロバイダー自身のIDを使用して鍵なしで行われます。その結果として得られるのは、改ざんが検知可能で、追記のみが可能な証拠ストアであり、単なる形式的なチェックではありません。
- **自分で管理できるポリシー契約。** YAMLで「検証済み」とみなすものを定義します。これは、範囲を限定した評価を行わない述語DSL（`field`/`op`/`value` + `all`/`any`/`not`/`implies`）です。そして、このポリシーをすべてのリポジトリに適用します。`dogfood-verify lint`を使用して、ポリシーを公開する前にlintを実行します。
- **並列エージェント群プロトコル。** コードベースに対して複数のエージェントによる監査を実行し、その結果を再利用可能なパターンや原則に変換します。
- **リアルタイムのステータス表示。** リポジトリごとの記録、インデックス、およびステータスバッジはすべて、単一の証拠ストアから提供されます。

これは、[Dogfood Lab](https://github.com/dogfood-lab)組織の主要なモノリポジトリであり、1つの`swarm`コマンドラインインターフェース（CLI）に7つの`@dogfood-lab/*`パッケージが含まれています。

## クイックスタートガイド

```bash
npm install -g @dogfood-lab/dogfood-swarm
swarm --help
```

独自のリポジトリのテスト結果をここに記録したいですか？ **[`examples/`スターターキット](examples/)** を使用すると、5分で設定が完了します（`npx @dogfood-lab/report` で提出物をビルドし、`dogfood-init` でワークフローを構築します）。オペレーターガイド、CLIリファレンス、スキーマリファレンス、および統合レシピは、**[ハンドブック](https://dogfood-lab.github.io/testing-os/handbook/)** にあります。バージョンごとの詳細については、[CHANGELOG.md](CHANGELOG.md) を参照してください。

## 脅威モデル

テストOSのプロセスでは、信頼できるGitHubリポジトリ（`mcp-tool-shop-org/*`および`dogfood-lab/*`）から`repository_dispatch`を通じて送信されたドッグフード版の提出物を受け付けます。検証者はCIの出所を必要とします。つまり、提供元のAPIを通じて、提出された実行IDが確認され、形式が正しくない、参照が欠落している、または無効なポリシーが含まれている提出物は拒否されます。

**プロビナンスは証明です。** `github` への提出の場合、検証者は、主張されている GitHub Actions の実行が実際に存在すること（GitHub API）を確認し、提出物の `repo` と `commit_sha` をその確認された実行に紐付けます。これは、GitHub 自体の OIDC ID に基づくライブのキーレスチェックであり、記録は実際に行われなかった実行またはコミットを証明することはできません。 **GitLab CI** はオプションでサポートされています（`source.provider: gitlab`）。GitLab への提出は、検証者が GitHub 以外のホスト（`gitlab.com/api`）にアクセスする唯一のケースであり、`gitlab` への提出の場合のみです。

**記録の整合性は改ざんが「検知可能」であるだけで、「完全に防止」されるわけではありません。** 保存されたすべてのレコードには、`integrity` ブロック（`submission_digest` + `prev_digest`）が含まれており、これは追記のみを許可するハッシュチェーンを形成します。`dogfood ingest --verify-chain` を使用して、オフラインで完全に検証できます。これにより、外部からの改ざん、ディスクの破損、および部分的な復元が検出されます。ただし、これだけでは提出に使用される認証情報自体に対する保護にはなりません。認証情報はレコードとチェーンの両を書き換える可能性があるため、それを防ぐには、書き込み者の制御外にあるアンカーが必要です。 **オプションでデフォルトオフになっている XRPL アンカー**（`dogfood ingest --anchor-*`）は、チェーンの先頭をパブリックな XRP Ledger に記録し、アンカーポイントより前の任意の切り捨てまたは書き換えを検出できるようにします。これは、開示されている 2 番目の GitHub 以外の呼び出しであり、オペレーターが有効にした場合にのみ実行されます。

**テスト対象となるもの：** 各「リポジトリ」の `repository_dispatch` ペイロードに含まれる送信JSON、このリポジトリ内の `policies/`、`fixtures/`、`records/`、および `indexes/` ディレクトリ、およびプロビナンス検証のための `api.github.com` への外部呼び出し。また、「github」への送信に限り、送信元のリポジトリの `dogfood/scenarios/<scenario_id>.yaml` ファイルを読み取り専用で取得します（これは、必要なステップの強制に使用されるシナリオ定義であり、使用前にサイズ制限とスキーマ検証が行われ、ファイルが存在しない場合は、そのチェックは実行されず、警告が表示されます）。

**テスト対象外となるもの：** 公開されている「dogfood/scenarios/」ディレクトリ内の定義ファイル以外の、ユーザー側のソースコード、ディスパッチエンベロープに含まれないユーザーリポジトリ内の機密情報、またはこのリポジトリの作業ツリー外にあるあらゆるもの。

**ネットワークの露出範囲。** デフォルトでは、唯一のエグレスは `api.github.com`（読み取り専用のプロビナンス）です。例外は2つだけで、どちらもオプションであり、上記で説明されています。GitLab プロバイダーへの提出（`gitlab.com/api`）、およびオペレーターが有効にした XRPL アンカーの実行です。 **テレメトリや分析は行いません。このコードベースは外部に情報を送信しません。上記の2つのオプションパスがない場合、GitHub 以外のネットワークへの露出はありません。** 受信ワークフローは、このリポジトリのみを対象として `contents: write` のスコープで実行されます。

## パッケージ

| パッケージ | 出典 | 目的 |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | 8つのJSONスキーマ（レコード、検出結果、パターン、推奨事項、原則、ポリシー、シナリオ、提出物）。 |
| `@dogfood-lab/verify` | JS | 中央の入力検証モジュール。すべての入力データは、永続化される前にこのモジュールで検証されます。 |
| `@dogfood-lab/findings` | JS | 契約案件の探索、および関連するプロセス（分析、検討、統合、助言）の構築。 |
| `@dogfood-lab/ingest` | JS | パイプラインの各段階：送信→検証→保存→インデックス化。 |
| `@dogfood-lab/report` | JS | ソースリポジトリ用のビルドツール。 |
| `@dogfood-lab/portfolio` | JS | クロスリポジトリ・ポートフォリオ生成ツール。 |
| `@dogfood-lab/dogfood-swarm` | JS | 10段階の並列エージェント・プロトコル＋SQLiteによる制御プレーン＋`swarm`バイナリ。 |

公開されているAPIを通じて連携しつつ、**独立性を保つ**兄弟プロジェクトのテストツール：[`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck)、[`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge)、[`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp)、[`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine)、[`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab)。

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
└── .github/workflows/         # ci.yml, ingest.yml, pages.yml, release.yml
```

## 地域開発

```bash
git clone https://github.com/dogfood-lab/testing-os.git
cd testing-os
npm install
npm run build       # tsc --build across all packages
npm test            # vitest for schemas, node --test for the rest
npm run verify      # version-sync + doc-drift + regression-pin gates + build + tests (canonical pre-commit check — NOT the same as build && test)
```

Nodeのバージョンが22以上である必要があります。CI環境では、`ubuntu-latest`上でNode 22と24でテストを実行します。ローカル環境での検証はNode 25で行います。

**サポート対象のファイルシステム:** APFS、HFS+、ext4（CIベースライン）、NTFS — POSIX `link(2)` を実装しているもの。**サポート対象外:** exFAT、FAT32。[`packages/findings/lib/file-lock.js`](packages/findings/lib/file-lock.js) 内のファイルロックCASは、アトミックな公開のためにハードリンクのセマンティクスを必要とします。exFATの場合、`linkSync` は `ENOTSUP` エラー（エラーメッセージが表示される）をスローします。注意点として、クロスプラットフォームで使用する外部SSDは、多くの場合exFATでフォーマットされています。そのため、リポジトリをローカルのAPFS/HFS+にクローンして使用してください。完全なSession G検証マトリックスについては、[`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md) を参照してください。

## バージョン管理

すべての`@dogfood-lab/*`パッケージはまとめてバージョンアップされ、モノリポ全体で一括してバージョン番号が更新されます。6つのパッケージ（`schemas`、`verify`、`report`、`ingest`、`findings`、`dogfood-swarm`）がnpmに`@dogfood-lab`という名前でv1.9.0として公開され、7番目のパッケージである`@dogfood-lab/portfolio`は引き続き内部利用のみとなります。このREADMEの冒頭付近にあるバージョン情報は、`npm run build`を実行するたびに[`scripts/sync-version.mjs`](scripts/sync-version.mjs)から`package.json`を読み込んで自動的に更新されます。

## ライセンス

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[ハンドブック](https://dogfood-lab.github.io/testing-os/handbook/)** · **[すべてのリポジトリ](https://github.com/orgs/dogfood-lab/repositories)** · **[プロフィール](https://github.com/dogfood-lab)**

まずは試してから、次にリリースしましょう。

</div>
